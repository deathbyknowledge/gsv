/**
 * ProcessStore — SQLite-backed state for a single Process DO.
 *
 * Manages:
 *   - messages: the active conversation (agent loop working memory)
 *   - pending_tool_calls: in-flight tool calls awaiting results
 *   - message_queue: FIFO queue for messages arriving during an active run
 *   - process_kv: key-value metadata (processId, archiveId, etc.)
 */

import { SYSCALL_TOOL_NAMES } from "../syscalls/constants";
import type {
  ProcAiConfigSnapshot,
  ProcContextFile,
  ProcContextState,
  ProcMessageMetadata,
  ProcMessageModelMetadata,
  ProcMessageProviderMetadata,
  ProcToolResultOutcome,
  ProcUsageCost,
  ProcUsageCostSource,
  ProcUsageState,
} from "@humansandmachines/gsv/protocol";
import type {
  Message,
  UserMessage,
  AssistantMessage,
  ToolResultMessage,
  TextContent,
  ThinkingContent,
  ToolCall,
} from "@earendil-works/pi-ai";
import {
  buildFallbackMediaBlocks,
  describeStoredProcessMedia,
  parseStoredProcessMedia,
  type StoredProcessMedia,
} from "./media";
import {
  DEFAULT_CONVERSATION_GENERATION,
  DEFAULT_CONVERSATION_ID,
  normalizeConversationId,
  type ConversationArchiveKind,
  type ConversationSegmentKind,
  type ProcessConversationArchiveRecord,
  type ProcessConversationRecord,
  type ProcessConversationSegmentRecord,
} from "./conversations";
import {
  PROCESS_AI_CONFIG_STORE_KEY,
  normalizeProcessAiConfigSnapshot,
} from "./ai-config";

const DEFAULT_MESSAGE_READ_LIMIT = 200;

export type ToolCallStatus = "registered" | "pending" | "completed" | "error";

export type ToolCallRecord = {
  id: string;
  dispatchId: string;
  conversationId: string;
  call: string;
  args: unknown;
  status: ToolCallStatus;
  result: unknown;
  error: string | null;
  outcome: ProcToolResultOutcome | null;
};

export type PendingToolCallRecord = {
  runId: string;
  call: string;
  args: unknown;
};

export type MessageRole = "user" | "assistant" | "system" | "toolResult";

export type MessageRecord = {
  id: number;
  conversationId: string;
  generation: number;
  runId?: string | null;
  role: MessageRole;
  content: string;
  toolCalls: string | null;
  toolCallId: string | null;
  media: string | null;
  origin?: string | null;
  metadata: string | null;
  createdAt: number;
};

export type ConversationArchivePointer = {
  source: "segment" | "archive";
  id: string;
  conversationId: string;
  generation: number;
  archivePath: string;
};

type MessageRow = {
  id: number;
  conversation_id: string;
  generation: number;
  run_id: string | null;
  role: string;
  content: string;
  tool_calls: string | null;
  tool_call_id: string | null;
  media_json: string | null;
  origin_json: string | null;
  metadata_json?: string | null;
  created_at: number;
};

export type AssistantMessageMeta = {
  thinking?: ThinkingContent[];
  toolCalls?: ToolCall[];
};

export type MessageProviderMetadata = ProcMessageProviderMetadata;
export type MessageMetadata = ProcMessageMetadata;

export type QueuedMessage = {
  id: number;
  runId: string;
  conversationId: string;
  generation: number;
  message: string;
  media: string | null;
  origin?: string | null;
};

export type PendingHilRecord = {
  requestId: string;
  runId: string;
  conversationId: string;
  ownerDispatchId?: string;
  toolCallId: string;
  toolName: string;
  syscall: string;
  args: Record<string, unknown>;
  createdAt: number;
};

function normalizeStoredToolResultOutcome(value: string | null): ProcToolResultOutcome | null {
  if (
    value === "completed"
    || value === "failed"
    || value === "cancelled"
    || value === "denied"
  ) {
    return value;
  }
  return null;
}

function resolvedToolResultOutcome(result: unknown): "completed" | "failed" {
  if (
    result
    && typeof result === "object"
    && !Array.isArray(result)
    && (result as { status?: unknown }).status === "failed"
  ) {
    return "failed";
  }
  return "completed";
}

export class ProcessStore {
  constructor(private readonly sql: SqlStorage) {}

  // --- Conversations ---

  ensureConversation(conversationId: string = DEFAULT_CONVERSATION_ID): ProcessConversationRecord {
    const id = normalizeConversationId(conversationId);
    const existing = this.getConversation(id);
    if (existing) {
      return existing;
    }

    const now = Date.now();
    this.sql.exec(
      `INSERT INTO conversations (id, generation, status, title, created_at, updated_at)
       VALUES (?, ?, 'open', NULL, ?, ?)`,
      id,
      DEFAULT_CONVERSATION_GENERATION,
      now,
      now,
    );

    return {
      id,
      generation: DEFAULT_CONVERSATION_GENERATION,
      status: "open",
      title: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  getConversation(conversationId: string = DEFAULT_CONVERSATION_ID): ProcessConversationRecord | null {
    const id = normalizeConversationId(conversationId);
    const rows = [...this.sql.exec<{
      id: string;
      generation: number;
      status: string;
      title: string | null;
      created_at: number;
      updated_at: number;
    }>(
      "SELECT * FROM conversations WHERE id = ? LIMIT 1",
      id,
    )];
    const row = rows[0];
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      generation: row.generation,
      status: row.status === "closed" ? "closed" : "open",
      title: row.title,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  getConversationGeneration(conversationId: string = DEFAULT_CONVERSATION_ID): number {
    return this.ensureConversation(conversationId).generation;
  }

  openConversation(input?: {
    conversationId?: string;
    title?: string | null;
  }): { conversation: ProcessConversationRecord; created: boolean } {
    const id = normalizeConversationId(input?.conversationId ?? crypto.randomUUID());
    const existing = this.getConversation(id);
    const now = Date.now();
    const title = normalizeNullableString(input?.title);

    if (existing) {
      this.sql.exec(
        `UPDATE conversations
            SET status = 'open',
                title = COALESCE(?, title),
                updated_at = ?
          WHERE id = ?`,
        title,
        now,
        id,
      );
      return {
        conversation: this.getConversation(id) ?? existing,
        created: false,
      };
    }

    this.sql.exec(
      `INSERT INTO conversations (id, generation, status, title, created_at, updated_at)
       VALUES (?, ?, 'open', ?, ?, ?)`,
      id,
      DEFAULT_CONVERSATION_GENERATION,
      title,
      now,
      now,
    );

    return {
      conversation: {
        id,
        generation: DEFAULT_CONVERSATION_GENERATION,
        status: "open",
        title,
        createdAt: now,
        updatedAt: now,
      },
      created: true,
    };
  }

  listConversations(options?: { includeClosed?: boolean }): ProcessConversationRecord[] {
    const rows = [...this.sql.exec<{
      id: string;
      generation: number;
      status: string;
      title: string | null;
      created_at: number;
      updated_at: number;
    }>(
      options?.includeClosed
        ? "SELECT * FROM conversations ORDER BY updated_at DESC, id ASC"
        : "SELECT * FROM conversations WHERE status != 'closed' ORDER BY updated_at DESC, id ASC",
    )];

    return rows.map((row) => ({
      id: row.id,
      generation: row.generation,
      status: row.status === "closed" ? "closed" : "open",
      title: row.title,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  closeConversation(conversationId: string): boolean {
    const id = normalizeConversationId(conversationId);
    const existing = this.getConversation(id);
    if (!existing || existing.status === "closed") {
      return false;
    }
    this.sql.exec(
      "UPDATE conversations SET status = 'closed', updated_at = ? WHERE id = ?",
      Date.now(),
      id,
    );
    return true;
  }

  resetConversation(conversationId: string): ProcessConversationRecord {
    const id = normalizeConversationId(conversationId);
    const existing = this.ensureConversation(id);
    const nextGeneration = existing.generation + 1;
    const now = Date.now();

    this.clearMessages(id);
    this.sql.exec(
      `UPDATE conversations
          SET generation = ?,
              status = 'open',
              updated_at = ?
        WHERE id = ?`,
      nextGeneration,
      now,
      id,
    );

    return {
      ...existing,
      generation: nextGeneration,
      status: "open",
      updatedAt: now,
    };
  }

  totalMessageCount(): number {
    const rows = [...this.sql.exec<{ cnt: number }>(
      "SELECT COUNT(*) as cnt FROM messages",
    )];
    return rows[0]?.cnt ?? 0;
  }

  clearAllMessages(): number {
    const count = this.totalMessageCount();
    this.sql.exec("DELETE FROM messages");
    this.deleteAllContextStates();
    this.deleteAllConversationUsage();
    return count;
  }

  resetAllConversations(): ProcessConversationRecord[] {
    const now = Date.now();
    this.clearAllMessages();
    this.sql.exec(
      `UPDATE conversations
          SET generation = generation + 1,
              status = 'open',
              updated_at = ?`,
      now,
    );
    return this.listConversations({ includeClosed: true });
  }

  getConversationPrefixMessages(opts: {
    conversationId?: string;
    keepLast?: number;
    throughMessageId?: number;
  }): MessageRecord[] {
    const conversationId = normalizeConversationId(opts.conversationId);
    const generation = this.getConversationGeneration(conversationId);
    const records = this.getMessagesForGeneration(conversationId, generation);

    if (opts.keepLast !== undefined) {
      const keepLast = Math.max(0, Math.trunc(opts.keepLast));
      const compactCount = normalizeCompactionCut(
        records,
        records.length - keepLast,
        "backward",
      );
      return compactCount > 0 ? records.slice(0, compactCount) : [];
    }

    if (opts.throughMessageId !== undefined) {
      const throughMessageId = Math.trunc(opts.throughMessageId);
      const compactCount = normalizeCompactionCut(
        records,
        records.findLastIndex((record) => record.id <= throughMessageId) + 1,
        "forward",
      );
      return records.slice(0, compactCount);
    }

    return [];
  }

  compactConversationPrefix(opts: {
    conversationId?: string;
    generation: number;
    fromMessageId: number;
    toMessageId: number;
    summary: string;
  }): number {
    const conversationId = normalizeConversationId(opts.conversationId);
    const summaryMessageId = opts.fromMessageId;
    const now = Date.now();

    this.sql.exec(
      `DELETE FROM messages
        WHERE conversation_id = ?
          AND generation = ?
          AND id >= ?
          AND id <= ?`,
      conversationId,
      opts.generation,
      opts.fromMessageId,
      opts.toMessageId,
    );
    this.sql.exec(
      `INSERT INTO messages (
        id, conversation_id, generation, role, content, tool_calls, tool_call_id, media_json, origin_json, created_at
      ) VALUES (?, ?, ?, 'system', ?, NULL, NULL, NULL, NULL, ?)`,
      summaryMessageId,
      conversationId,
      opts.generation,
      opts.summary,
      now,
    );
    this.sql.exec(
      "UPDATE conversations SET updated_at = ? WHERE id = ?",
      now,
      conversationId,
    );

    return summaryMessageId;
  }

  recordConversationSegment(input: {
    id: string;
    conversationId?: string;
    generation: number;
    kind: ConversationSegmentKind;
    fromMessageId: number;
    toMessageId: number;
    archivePath: string;
    summaryMessageId?: number | null;
  }): ProcessConversationSegmentRecord {
    const conversationId = normalizeConversationId(input.conversationId);
    const createdAt = Date.now();
    this.sql.exec(
      `INSERT INTO conversation_segments (
        id, conversation_id, generation, kind, from_message_id, to_message_id,
        archive_path, summary_message_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.id,
      conversationId,
      input.generation,
      input.kind,
      input.fromMessageId,
      input.toMessageId,
      input.archivePath,
      input.summaryMessageId ?? null,
      createdAt,
    );
    return {
      id: input.id,
      conversationId,
      generation: input.generation,
      kind: input.kind,
      fromMessageId: input.fromMessageId,
      toMessageId: input.toMessageId,
      archivePath: input.archivePath,
      summaryMessageId: input.summaryMessageId ?? null,
      createdAt,
    };
  }

  listConversationSegments(conversationId: string = DEFAULT_CONVERSATION_ID): ProcessConversationSegmentRecord[] {
    const normalizedConversationId = normalizeConversationId(conversationId);
    return [...this.sql.exec<{
      id: string;
      conversation_id: string;
      generation: number;
      kind: string;
      from_message_id: number;
      to_message_id: number;
      archive_path: string;
      summary_message_id: number | null;
      created_at: number;
    }>(
      `SELECT id, conversation_id, generation, kind, from_message_id, to_message_id,
              archive_path, summary_message_id, created_at
         FROM conversation_segments
        WHERE conversation_id = ?
        ORDER BY created_at ASC, id ASC`,
      normalizedConversationId,
    )].map((row) => ({
      id: row.id,
      conversationId: row.conversation_id,
      generation: row.generation,
      kind: "compaction",
      fromMessageId: row.from_message_id,
      toMessageId: row.to_message_id,
      archivePath: row.archive_path,
      summaryMessageId: row.summary_message_id,
      createdAt: row.created_at,
    }));
  }

  getConversationSegment(
    conversationId: string,
    segmentId: string,
  ): ProcessConversationSegmentRecord | null {
    const normalizedConversationId = normalizeConversationId(conversationId);
    const rows = [...this.sql.exec<{
      id: string;
      conversation_id: string;
      generation: number;
      kind: string;
      from_message_id: number;
      to_message_id: number;
      archive_path: string;
      summary_message_id: number | null;
      created_at: number;
    }>(
      `SELECT id, conversation_id, generation, kind, from_message_id, to_message_id,
              archive_path, summary_message_id, created_at
         FROM conversation_segments
        WHERE conversation_id = ?
          AND id = ?
        LIMIT 1`,
      normalizedConversationId,
      segmentId,
    )];
    const row = rows[0];
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      conversationId: row.conversation_id,
      generation: row.generation,
      kind: "compaction",
      fromMessageId: row.from_message_id,
      toMessageId: row.to_message_id,
      archivePath: row.archive_path,
      summaryMessageId: row.summary_message_id,
      createdAt: row.created_at,
    };
  }

  recordConversationArchive(input: {
    id: string;
    conversationId?: string;
    generation: number;
    kind: ConversationArchiveKind;
    messages: number;
    archivePath: string;
  }): ProcessConversationArchiveRecord {
    const conversationId = normalizeConversationId(input.conversationId);
    const createdAt = Date.now();
    this.sql.exec(
      `INSERT INTO conversation_archives (
        id, conversation_id, generation, kind, messages, archive_path, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      input.id,
      conversationId,
      input.generation,
      input.kind,
      input.messages,
      input.archivePath,
      createdAt,
    );
    return {
      id: input.id,
      conversationId,
      generation: input.generation,
      kind: input.kind,
      messages: input.messages,
      archivePath: input.archivePath,
      createdAt,
    };
  }

  listConversationArchives(conversationId: string = DEFAULT_CONVERSATION_ID): ProcessConversationArchiveRecord[] {
    const normalizedConversationId = normalizeConversationId(conversationId);
    return [...this.sql.exec<{
      id: string;
      conversation_id: string;
      generation: number;
      kind: string;
      messages: number;
      archive_path: string;
      created_at: number;
    }>(
      `SELECT id, conversation_id, generation, kind, messages, archive_path, created_at
         FROM conversation_archives
        WHERE conversation_id = ?
        ORDER BY generation ASC, created_at ASC, id ASC`,
      normalizedConversationId,
    )].map((row) => ({
      id: row.id,
      conversationId: row.conversation_id,
      generation: row.generation,
      kind: parseConversationArchiveKind(row.kind),
      messages: row.messages,
      archivePath: row.archive_path,
      createdAt: row.created_at,
    }));
  }

  listConversationArchivePointers(): ConversationArchivePointer[] {
    return [...this.sql.exec<{
      source: "segment" | "archive";
      id: string;
      conversation_id: string;
      generation: number;
      archive_path: string;
    }>(
      `SELECT 'segment' AS source, id, conversation_id, generation, archive_path
         FROM conversation_segments
       UNION ALL
       SELECT 'archive' AS source, id, conversation_id, generation, archive_path
         FROM conversation_archives
       ORDER BY source ASC, id ASC`,
    )].map((row) => ({
      source: row.source,
      id: row.id,
      conversationId: row.conversation_id,
      generation: row.generation,
      archivePath: row.archive_path,
    }));
  }

  replaceConversationArchivePointer(
    pointer: ConversationArchivePointer,
    nextPath: string,
  ): boolean {
    const table = pointer.source === "segment"
      ? "conversation_segments"
      : "conversation_archives";
    this.sql.exec(
      `UPDATE ${table}
          SET archive_path = ?
        WHERE id = ? AND conversation_id = ? AND archive_path = ?`,
      nextPath,
      pointer.id,
      pointer.conversationId,
      pointer.archivePath,
    );
    return this.sql.exec<{ changed: number }>(
      "SELECT changes() AS changed",
    ).toArray()[0]?.changed === 1;
  }

  listConversationGenerations(conversationId: string = DEFAULT_CONVERSATION_ID): number[] {
    const normalizedConversationId = normalizeConversationId(conversationId);
    const generations = new Set<number>();
    const conversation = this.ensureConversation(normalizedConversationId);
    generations.add(conversation.generation);

    for (const row of this.sql.exec<{ generation: number }>(
      `SELECT generation FROM conversation_segments WHERE conversation_id = ?
       UNION
       SELECT generation FROM conversation_archives WHERE conversation_id = ?`,
      normalizedConversationId,
      normalizedConversationId,
    )) {
      generations.add(row.generation);
    }

    return [...generations].sort((a, b) => a - b);
  }

  // --- Tool calls ---

  register(
    dispatchId: string,
    id: string,
    runId: string,
    call: string,
    args: unknown,
    conversationId: string = DEFAULT_CONVERSATION_ID,
  ): void {
    const normalizedConversationId = normalizeConversationId(conversationId);
    this.sql.exec(
      `INSERT INTO pending_tool_calls (
        dispatch_id, id, run_id, conversation_id, call, args_json, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'registered', ?)`,
      dispatchId,
      id,
      runId,
      normalizedConversationId,
      call,
      JSON.stringify(args),
      Date.now(),
    );
  }

  resolve(
    dispatchId: string,
    result: unknown,
    outcome: "completed" | "failed" = resolvedToolResultOutcome(result),
  ): void {
    this.sql.exec(
      `UPDATE pending_tool_calls
          SET status = 'completed', result_json = ?, outcome = ?
        WHERE dispatch_id = ? AND status IN ('registered', 'pending')`,
      JSON.stringify(result ?? null),
      outcome,
      dispatchId,
    );
  }

  fail(
    dispatchId: string,
    error: string,
    outcome: Exclude<ProcToolResultOutcome, "completed"> = "failed",
  ): void {
    this.sql.exec(
      `UPDATE pending_tool_calls
          SET status = 'error', error = ?, outcome = ?
        WHERE dispatch_id = ? AND status IN ('registered', 'pending')`,
      error,
      outcome,
      dispatchId,
    );
  }

  markDispatched(dispatchId: string): boolean {
    const cursor = this.sql.exec(
      `UPDATE pending_tool_calls
          SET status = 'pending'
        WHERE dispatch_id = ? AND status = 'registered'`,
      dispatchId,
    );
    return cursor.rowsWritten > 0;
  }

  getPending(dispatchId: string): PendingToolCallRecord | null {
    const rows = [...this.sql.exec<{
      run_id: string;
      call: string;
      args_json: string | null;
    }>(
      `SELECT run_id, call, args_json
         FROM pending_tool_calls
        WHERE dispatch_id = ? AND status IN ('registered', 'pending')`,
      dispatchId,
    )];
    if (rows.length === 0) return null;
    return {
      runId: rows[0].run_id,
      call: rows[0].call,
      args: rows[0].args_json ? JSON.parse(rows[0].args_json) : null,
    };
  }

  isRunResolved(runId: string): boolean {
    const rows = [...this.sql.exec<{ cnt: number }>(
      `SELECT COUNT(*) as cnt
         FROM pending_tool_calls
        WHERE run_id = ? AND status IN ('registered', 'pending')`,
      runId,
    )];
    return (rows[0]?.cnt ?? 0) === 0;
  }

  getResults(runId: string): ToolCallRecord[] {
    return [...this.sql.exec<{
      id: string;
      dispatch_id: string;
      conversation_id: string;
      call: string;
      args_json: string;
      status: string;
      result_json: string | null;
      error: string | null;
      outcome: string | null;
    }>(
      `SELECT id, dispatch_id, conversation_id, call, args_json, status, result_json, error, outcome
         FROM pending_tool_calls
        WHERE run_id = ?
        ORDER BY created_at ASC, rowid ASC`,
      runId,
    )].map((row) => ({
      id: row.id,
      dispatchId: row.dispatch_id,
      conversationId: row.conversation_id,
      call: row.call,
      args: JSON.parse(row.args_json),
      status: row.status as ToolCallStatus,
      result: row.result_json ? JSON.parse(row.result_json) : null,
      error: row.error,
      outcome: normalizeStoredToolResultOutcome(row.outcome),
    }));
  }

  clearRun(runId: string): void {
    this.sql.exec("DELETE FROM pending_tool_calls WHERE run_id = ?", runId);
  }

  clearPendingToolCalls(conversationId?: string): void {
    if (conversationId === undefined) {
      this.sql.exec("DELETE FROM pending_tool_calls");
      return;
    }
    this.sql.exec(
      "DELETE FROM pending_tool_calls WHERE conversation_id = ?",
      normalizeConversationId(conversationId),
    );
  }

  setPendingHil(record: PendingHilRecord): void {
    this.clearPendingHil();
    this.sql.exec(
      `INSERT INTO pending_hil (
        request_id, run_id, conversation_id, owner_dispatch_id, tool_call_id,
        tool_name, syscall, args_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.requestId,
      record.runId,
      normalizeConversationId(record.conversationId),
      record.ownerDispatchId ?? null,
      record.toolCallId,
      record.toolName,
      record.syscall,
      JSON.stringify(record.args),
      record.createdAt,
    );
  }

  getPendingHil(requestId?: string): PendingHilRecord | null {
    const rows = [
      ...this.sql.exec<{
        request_id: string;
        run_id: string;
        conversation_id: string;
        owner_dispatch_id: string | null;
        tool_call_id: string;
        tool_name: string;
        syscall: string;
        args_json: string;
        created_at: number;
      }>(
        requestId
          ? `SELECT * FROM pending_hil WHERE request_id = ? ORDER BY created_at ASC LIMIT 1`
          : `SELECT * FROM pending_hil ORDER BY created_at ASC LIMIT 1`,
        ...(requestId ? [requestId] : []),
      ),
    ];
    if (rows.length === 0) return null;
    const row = rows[0];
    return {
      requestId: row.request_id,
      runId: row.run_id,
      conversationId: row.conversation_id,
      ...(row.owner_dispatch_id ? { ownerDispatchId: row.owner_dispatch_id } : {}),
      toolCallId: row.tool_call_id,
      toolName: row.tool_name,
      syscall: row.syscall,
      args: JSON.parse(row.args_json) as Record<string, unknown>,
      createdAt: row.created_at,
    };
  }

  getPendingHilForRun(runId: string): PendingHilRecord | null {
    const record = this.getPendingHil();
    if (!record || record.runId !== runId) {
      return null;
    }
    return record;
  }

  clearPendingHil(conversationId?: string): void {
    if (conversationId === undefined) {
      this.sql.exec("DELETE FROM pending_hil");
      return;
    }
    this.sql.exec(
      "DELETE FROM pending_hil WHERE conversation_id = ?",
      normalizeConversationId(conversationId),
    );
  }

  appendMessage(
    role: MessageRole,
    content: string,
    opts?: {
      conversationId?: string;
      generation?: number;
      toolCalls?: string;
      toolCallId?: string;
      media?: string;
      origin?: string;
      metadata?: MessageMetadata | string | null;
      runId?: string;
      createdAt?: number;
    },
  ): number {
    const conversationId = normalizeConversationId(opts?.conversationId);
    const generation = opts?.generation ?? this.getConversationGeneration(conversationId);
    const metadataJson = stringifyMessageMetadata(opts?.metadata);
    this.sql.exec(
      `INSERT INTO messages (
        conversation_id, generation, run_id, role, content, tool_calls, tool_call_id, media_json, origin_json, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      conversationId,
      generation,
      opts?.runId ?? null,
      role,
      content,
      opts?.toolCalls ?? null,
      opts?.toolCallId ?? null,
      opts?.media ?? null,
      opts?.origin ?? null,
      metadataJson,
      opts?.createdAt ?? Date.now(),
    );

    const rows = [...this.sql.exec<{ id: number }>("SELECT last_insert_rowid() as id")];
    const messageId = rows[0]?.id ?? -1;

    if (role === "assistant") {
      const metadata = parseMessageMetadata(metadataJson);
      if (metadata?.usage) {
        this.addConversationUsage(conversationId, metadata.usage);
      }
    }

    return messageId;
  }

  updateMessageMedia(messageId: number, runId: string, media: string): void {
    this.sql.exec(
      "UPDATE messages SET media_json = ? WHERE id = ? AND run_id = ?",
      media,
      messageId,
      runId,
    );
  }

  clearMessageMedia(messageId: number, runId: string): void {
    this.sql.exec(
      "UPDATE messages SET media_json = NULL WHERE id = ? AND run_id = ?",
      messageId,
      runId,
    );
  }

  hasMessageMedia(messageId: number, runId: string): boolean {
    return this.sql.exec<{ present: number }>(
      `SELECT media_json IS NOT NULL AS present
         FROM messages
        WHERE id = ? AND run_id = ?`,
      messageId,
      runId,
    ).toArray()[0]?.present === 1;
  }

  referencesMediaKey(key: string): boolean {
    return this.mediaReferences(key).length > 0;
  }

  mediaReferences(key: string): StoredProcessMedia[] {
    const rows = this.sql.exec<{ media_json: string }>(
      `SELECT media_json FROM messages WHERE media_json IS NOT NULL
       UNION ALL
       SELECT media_json FROM message_queue WHERE media_json IS NOT NULL`,
    );
    const references: StoredProcessMedia[] = [];
    for (const row of rows) {
      references.push(...parseStoredProcessMedia(row.media_json).filter((item) => item.key === key));
    }
    return references;
  }

  getMessages(opts?: {
    conversationId?: string;
    limit?: number | null;
    offset?: number;
    beforeMessageId?: number;
    afterMessageId?: number;
    tail?: boolean;
  }): MessageRecord[] {
    const conversationId = normalizeConversationId(opts?.conversationId);
    const limit = opts?.limit === null ? null : opts?.limit ?? DEFAULT_MESSAGE_READ_LIMIT;
    const offset = opts?.offset ?? 0;
    const beforeMessageId = opts?.beforeMessageId;
    const afterMessageId = opts?.afterMessageId;
    const tail = opts?.tail === true;
    const hasLimit = limit !== null;
    const where = ["conversation_id = ?"];
    const args: Array<string | number> = [conversationId];
    if (beforeMessageId !== undefined) {
      where.push("id < ?");
      args.push(beforeMessageId);
    }
    if (afterMessageId !== undefined) {
      where.push("id > ?");
      args.push(afterMessageId);
    }
    const pagination = hasLimit
      ? { clause: "LIMIT ? OFFSET ?", args: [limit, offset] as const }
      : offset > 0
        ? { clause: "LIMIT -1 OFFSET ?", args: [offset] as const }
        : { clause: "", args: [] as const };
    const order = tail || beforeMessageId !== undefined ? "DESC" : "ASC";

    const rows = [...this.sql.exec<MessageRow>(
        `SELECT * FROM messages WHERE ${where.join(" AND ")} ORDER BY id ${order} ${pagination.clause}`,
      ...args,
      ...pagination.args,
    )];
    if (tail || beforeMessageId !== undefined) {
      rows.reverse();
    }

    return rows.map(messageRecordFromRow);
  }

  hasMessageBefore(conversationId: string, messageId: number): boolean {
    const rows = [...this.sql.exec<{ found: number }>(
      "SELECT 1 as found FROM messages WHERE conversation_id = ? AND id < ? LIMIT 1",
      normalizeConversationId(conversationId),
      messageId,
    )];
    return rows.length > 0;
  }

  hasMessageAfter(conversationId: string, messageId: number): boolean {
    const rows = [...this.sql.exec<{ found: number }>(
      "SELECT 1 as found FROM messages WHERE conversation_id = ? AND id > ? LIMIT 1",
      normalizeConversationId(conversationId),
      messageId,
    )];
    return rows.length > 0;
  }

  getMessagesForGeneration(
    conversationId: string = DEFAULT_CONVERSATION_ID,
    generation?: number,
  ): MessageRecord[] {
    const normalizedConversationId = normalizeConversationId(conversationId);
    const normalizedGeneration = generation ?? this.getConversationGeneration(normalizedConversationId);
    return [...this.sql.exec<MessageRow>(
      `SELECT * FROM messages
        WHERE conversation_id = ?
          AND generation = ?
        ORDER BY id ASC`,
      normalizedConversationId,
      normalizedGeneration,
    )].map(messageRecordFromRow);
  }

  getMessagesForGenerationAfter(opts: {
    conversationId?: string;
    generation: number;
    afterMessageId: number;
    throughCreatedAt?: number;
  }): MessageRecord[] {
    const normalizedConversationId = normalizeConversationId(opts.conversationId);
    const args: Array<string | number> = [
      normalizedConversationId,
      opts.generation,
      opts.afterMessageId,
    ];
    const createdAtFilter = opts.throughCreatedAt === undefined
      ? ""
      : "AND created_at <= ?";
    if (opts.throughCreatedAt !== undefined) {
      args.push(opts.throughCreatedAt);
    }

    return [...this.sql.exec<MessageRow>(
      `SELECT * FROM messages
        WHERE conversation_id = ?
          AND generation = ?
          AND id > ?
          ${createdAtFilter}
        ORDER BY id ASC`,
      ...args,
    )].map(messageRecordFromRow);
  }

  messageCount(conversationId: string = DEFAULT_CONVERSATION_ID): number {
    const rows = [...this.sql.exec<{ cnt: number }>(
      "SELECT COUNT(*) as cnt FROM messages WHERE conversation_id = ?",
      normalizeConversationId(conversationId),
    )];
    return rows[0]?.cnt ?? 0;
  }

  messageStats(conversationId: string = DEFAULT_CONVERSATION_ID): {
    count: number;
    firstMessageId: number | null;
    lastMessageId: number | null;
  } {
    const rows = [...this.sql.exec<{ cnt: number; first_id: number | null; last_id: number | null }>(
      "SELECT COUNT(*) as cnt, MIN(id) as first_id, MAX(id) as last_id FROM messages WHERE conversation_id = ?",
      normalizeConversationId(conversationId),
    )];
    return {
      count: rows[0]?.cnt ?? 0,
      firstMessageId: rows[0]?.first_id ?? null,
      lastMessageId: rows[0]?.last_id ?? null,
    };
  }

  clearMessages(conversationId: string = DEFAULT_CONVERSATION_ID): number {
    const normalizedConversationId = normalizeConversationId(conversationId);
    const count = this.messageCount(normalizedConversationId);
    this.sql.exec("DELETE FROM messages WHERE conversation_id = ?", normalizedConversationId);
    this.deleteContextState(normalizedConversationId);
    this.deleteConversationUsage(normalizedConversationId);
    return count;
  }

  // we could use `this.ctx.storage.kv` but the sqlite tables
  // it generates are private and can't see it, so we implement
  // it ourselves so we can inspect the tables.

  getValue(key: string): string | null {
    const rows = [...this.sql.exec<{ value: string }>(
      "SELECT value FROM process_kv WHERE key = ?",
      key,
    )];
    return rows[0]?.value ?? null;
  }

  setValue(key: string, value: string): void {
    this.sql.exec(
      "INSERT OR REPLACE INTO process_kv (key, value) VALUES (?, ?)",
      key,
      value,
    );
  }

  deleteValue(key: string): void {
    this.sql.exec("DELETE FROM process_kv WHERE key = ?", key);
  }

  getAiConfigSnapshot(): ProcAiConfigSnapshot | null {
    const raw = this.getValue(PROCESS_AI_CONFIG_STORE_KEY);
    if (!raw) {
      return null;
    }
    try {
      return normalizeProcessAiConfigSnapshot(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  setAiConfigSnapshot(snapshot: ProcAiConfigSnapshot): void {
    this.setValue(PROCESS_AI_CONFIG_STORE_KEY, JSON.stringify(snapshot));
  }

  clearAiConfigSnapshot(): void {
    this.deleteValue(PROCESS_AI_CONFIG_STORE_KEY);
  }

  getContextState(conversationId: string = DEFAULT_CONVERSATION_ID): ProcContextState | null {
    const raw = this.getValue(contextStateKey(normalizeConversationId(conversationId)));
    if (!raw) {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as ProcContextState;
      return parsed && typeof parsed.conversationId === "string" ? parsed : null;
    } catch {
      return null;
    }
  }

  setContextState(state: ProcContextState): void {
    this.setValue(
      contextStateKey(normalizeConversationId(state.conversationId)),
      JSON.stringify(state),
    );
  }

  deleteContextState(conversationId: string = DEFAULT_CONVERSATION_ID): void {
    this.deleteValue(contextStateKey(normalizeConversationId(conversationId)));
  }

  deleteAllContextStates(): void {
    this.sql.exec("DELETE FROM process_kv WHERE key LIKE 'contextState:%'");
  }

  getConversationUsage(conversationId: string = DEFAULT_CONVERSATION_ID): ProcUsageState | null {
    const raw = this.getValue(conversationUsageKey(normalizeConversationId(conversationId)));
    if (!raw) {
      return null;
    }
    try {
      return normalizeUsageState(JSON.parse(raw)) ?? null;
    } catch {
      return null;
    }
  }

  addConversationUsage(
    conversationId: string = DEFAULT_CONVERSATION_ID,
    usage: ProcUsageState,
  ): ProcUsageState {
    const normalizedConversationId = normalizeConversationId(conversationId);
    const normalizedUsage = normalizeUsageState(usage);
    if (!normalizedUsage) {
      return this.getConversationUsage(normalizedConversationId) ?? emptyUsageState();
    }
    const merged = mergeUsageStates(
      this.getConversationUsage(normalizedConversationId),
      normalizedUsage,
    );
    this.setValue(conversationUsageKey(normalizedConversationId), JSON.stringify(merged));
    return merged;
  }

  deleteConversationUsage(conversationId: string = DEFAULT_CONVERSATION_ID): void {
    this.deleteValue(conversationUsageKey(normalizeConversationId(conversationId)));
  }

  deleteAllConversationUsage(): void {
    this.sql.exec("DELETE FROM process_kv WHERE key LIKE 'conversationUsage:%'");
  }

  getProcessContextFiles(): ProcContextFile[] {
    const raw = this.getValue("processContextFiles");
    if (!raw) {
      return [];
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed.flatMap((entry) => {
        if (!entry || typeof entry !== "object") {
          return [];
        }
        const file = entry as { name?: unknown; text?: unknown };
        if (typeof file.name !== "string" || typeof file.text !== "string") {
          return [];
        }
        return [{ name: file.name, text: file.text }];
      });
    } catch {
      return [];
    }
  }

  setProcessContextFiles(files: ProcContextFile[]): void {
    if (files.length === 0) {
      this.deleteValue("processContextFiles");
      return;
    }
    this.setValue("processContextFiles", JSON.stringify(files));
  }

  // --- Message conversion to pi-ai format ---

  toMessages(opts?: {
    conversationId?: string;
    limit?: number | null;
    offset?: number;
  }): Message[] {
    const records = this.getMessages(opts);
    const messages: Message[] = [];

    for (const r of records) {
      switch (r.role) {
        case "user": {
          const media = parseStoredProcessMedia(r.media);
          if (media.length === 0) {
            messages.push({
              role: "user",
              content: r.content,
              timestamp: r.createdAt,
            } satisfies UserMessage);
            break;
          }

          const content = buildFallbackUserContent(r.content, media);
          messages.push({
            role: "user",
            content,
            timestamp: r.createdAt,
          } satisfies UserMessage);
          break;
        }

        case "system": {
          messages.push({
            role: "user",
            content: `[Process Event]:\n${r.content}`,
            timestamp: r.createdAt,
          } satisfies UserMessage);
          break;
        }

        case "assistant": {
          const content: (TextContent | ThinkingContent | ToolCall)[] = [];
          const meta = parseAssistantMessageMeta(r.toolCalls);
          const metadata = parseMessageMetadata(r.metadata);
          if (meta.thinking) {
            content.push(...meta.thinking);
          }
          if (r.content) {
            content.push({ type: "text", text: r.content });
          }
          if (meta.toolCalls) {
            content.push(...meta.toolCalls);
          }
          messages.push({
            role: "assistant",
            content,
            api: metadata?.provider?.api ?? "",
            provider: metadata?.provider?.provider ?? "",
            model: metadata?.provider?.model ?? "",
            ...(metadata?.provider?.responseModel ? { responseModel: metadata.provider.responseModel } : {}),
            ...(metadata?.provider?.responseId ? { responseId: metadata.provider.responseId } : {}),
            usage: usageStateToPiUsage(metadata?.usage),
            stopReason: normalizeAssistantStopReason(metadata?.provider?.stopReason),
            timestamp: r.createdAt,
          } as AssistantMessage);
          break;
        }

        case "toolResult": {
          const meta: { toolName?: string; isError?: boolean } =
            r.toolCalls ? JSON.parse(r.toolCalls) : {};
          messages.push({
            role: "toolResult",
            toolCallId: r.toolCallId!,
            toolName: meta.toolName ?? "unknown",
            content: [{ type: "text", text: r.content }],
            isError: meta.isError ?? false,
            timestamp: r.createdAt,
          } satisfies ToolResultMessage);
          break;
        }
      }
    }

    return messages;
  }

  /**
   * Append a tool result message. Stores presentation metadata in the
   * tool_calls column so proc.history can expose a structured result.
   */
  appendToolResult(
    toolCallId: string,
    syscallName: string,
    content: string,
    isError: boolean,
    conversationId: string = DEFAULT_CONVERSATION_ID,
    runId?: string,
    outcome?: ProcToolResultOutcome,
  ): number {
    const toolName = SYSCALL_TOOL_NAMES[syscallName] ?? syscallName;
    return this.appendMessage("toolResult", content, {
      conversationId,
      runId,
      toolCallId,
      toolCalls: JSON.stringify({
        toolName,
        isError,
        ...(outcome ? { outcome } : {}),
      }),
    });
  }

  // --- Message queue ---

  enqueue(
    runId: string,
    message: string,
    media?: string,
    conversationId: string = DEFAULT_CONVERSATION_ID,
    origin?: string,
  ): void {
    const normalizedConversationId = normalizeConversationId(conversationId);
    const generation = this.getConversationGeneration(normalizedConversationId);
    this.sql.exec(
      `INSERT INTO message_queue (
        run_id, conversation_id, generation, message, media_json, origin_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      runId,
      normalizedConversationId,
      generation,
      message,
      media ?? null,
      origin ?? null,
      Date.now(),
    );
  }

  dequeue(conversationId?: string): QueuedMessage | null {
    const normalizedConversationId = conversationId === undefined
      ? null
      : normalizeConversationId(conversationId);
    const rows = [
      ...this.sql.exec<{
        id: number;
        run_id: string;
        conversation_id: string;
        generation: number;
        message: string;
        media_json: string | null;
        origin_json: string | null;
      }>(
        normalizedConversationId
          ? `SELECT id, run_id, conversation_id, generation, message, media_json, origin_json
               FROM message_queue
              WHERE conversation_id = ?
              ORDER BY id ASC
              LIMIT 1`
          : `SELECT id, run_id, conversation_id, generation, message, media_json, origin_json
               FROM message_queue
              ORDER BY id ASC
              LIMIT 1`,
        ...(normalizedConversationId ? [normalizedConversationId] : []),
      ),
    ];
    if (rows.length === 0) return null;
    const row = rows[0];
    this.sql.exec("DELETE FROM message_queue WHERE id = ?", row.id);
    return {
      id: row.id,
      runId: row.run_id,
      conversationId: row.conversation_id,
      generation: row.generation,
      message: row.message,
      media: row.media_json,
      origin: row.origin_json,
    };
  }

  drainQueue(conversationId?: string): QueuedMessage[] {
    const normalizedConversationId = conversationId === undefined
      ? null
      : normalizeConversationId(conversationId);
    const rows = [
      ...this.sql.exec<{
        id: number;
        run_id: string;
        conversation_id: string;
        generation: number;
        message: string;
        media_json: string | null;
        origin_json: string | null;
      }>(
        normalizedConversationId
          ? `SELECT id, run_id, conversation_id, generation, message, media_json, origin_json
               FROM message_queue
              WHERE conversation_id = ?
              ORDER BY id ASC`
          : `SELECT id, run_id, conversation_id, generation, message, media_json, origin_json
               FROM message_queue
              ORDER BY id ASC`,
        ...(normalizedConversationId ? [normalizedConversationId] : []),
      ),
    ];
    if (rows.length === 0) return [];
    if (normalizedConversationId) {
      this.sql.exec("DELETE FROM message_queue WHERE conversation_id = ?", normalizedConversationId);
    } else {
      this.sql.exec("DELETE FROM message_queue");
    }
    return rows.map((row) => ({
      id: row.id,
      runId: row.run_id,
      conversationId: row.conversation_id,
      generation: row.generation,
      message: row.message,
      media: row.media_json,
      origin: row.origin_json,
    }));
  }

  clearQueue(conversationId?: string): void {
    if (conversationId === undefined) {
      this.sql.exec("DELETE FROM message_queue");
      return;
    }
    this.sql.exec(
      "DELETE FROM message_queue WHERE conversation_id = ?",
      normalizeConversationId(conversationId),
    );
  }

  queueSize(conversationId?: string): number {
    const normalizedConversationId = conversationId === undefined
      ? null
      : normalizeConversationId(conversationId);
    const rows = [
      ...this.sql.exec<{ cnt: number }>(
        normalizedConversationId
          ? "SELECT COUNT(*) as cnt FROM message_queue WHERE conversation_id = ?"
          : "SELECT COUNT(*) as cnt FROM message_queue",
        ...(normalizedConversationId ? [normalizedConversationId] : []),
      ),
    ];
    return rows[0]?.cnt ?? 0;
  }
}

function normalizeCompactionCut(
  records: MessageRecord[],
  requested: number,
  direction: "backward" | "forward",
): number {
  let cut = Math.max(0, Math.min(records.length, requested));
  for (let start = 0; start < records.length; start += 1) {
    const record = records[start];
    if (record?.role !== "assistant") continue;
    const callIds = new Set(
      parseAssistantMessageMeta(record.toolCalls).toolCalls?.map((call) => call.id) ?? [],
    );
    if (callIds.size === 0) continue;

    const matched = new Set<string>();
    let end = start + 1;
    for (let index = start + 1; index < records.length; index += 1) {
      const candidate = records[index];
      if (candidate?.role === "toolResult" && candidate.toolCallId && callIds.has(candidate.toolCallId)) {
        matched.add(candidate.toolCallId);
        end = index + 1;
        if (matched.size === callIds.size) break;
      }
    }
    if (matched.size < callIds.size) {
      end = records.length;
    }
    if (cut > start && cut < end) {
      cut = direction === "backward" ? start : end;
    }
  }
  return cut;
}

function messageRecordFromRow(row: MessageRow): MessageRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    generation: row.generation,
    runId: row.run_id,
    role: row.role as MessageRole,
    content: row.content,
    toolCalls: row.tool_calls,
    toolCallId: row.tool_call_id,
    media: row.media_json,
    origin: row.origin_json,
    metadata: row.metadata_json ?? null,
    createdAt: row.created_at,
  };
}

export function parseMessageMetadata(raw: string | null | undefined): MessageMetadata | null {
  if (!raw) {
    return null;
  }
  try {
    return normalizeMessageMetadata(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function stringifyMessageMetadata(
  metadata: MessageMetadata | string | null | undefined,
): string | null {
  if (metadata === undefined || metadata === null) {
    return null;
  }
  if (typeof metadata === "string") {
    const normalized = parseMessageMetadata(metadata);
    return normalized ? JSON.stringify(normalized) : null;
  }
  const normalized = normalizeMessageMetadata(metadata);
  return normalized ? JSON.stringify(normalized) : null;
}

export function normalizeMessageMetadata(value: unknown): MessageMetadata | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const provider = normalizeProviderMetadata(record.provider);
  const fallback = normalizeFallbackMetadata(record.fallback);
  const usage = normalizeUsageState(record.usage);
  if (!provider && !fallback && !usage) {
    return null;
  }
  return {
    ...(provider ? { provider } : {}),
    ...(fallback ? { fallback } : {}),
    ...(usage ? { usage } : {}),
  };
}

function normalizeProviderMetadata(value: unknown): MessageProviderMetadata | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const provider: MessageProviderMetadata = {};
  const api = normalizeOptionalNonEmptyString(record.api);
  const providerName = normalizeOptionalNonEmptyString(record.provider);
  const model = normalizeOptionalNonEmptyString(record.model);
  const responseModel = normalizeOptionalNonEmptyString(record.responseModel);
  const responseId = normalizeOptionalNonEmptyString(record.responseId);
  const stopReason = normalizeOptionalNonEmptyString(record.stopReason);
  if (api) provider.api = api;
  if (providerName) provider.provider = providerName;
  if (model) provider.model = model;
  if (responseModel) provider.responseModel = responseModel;
  if (responseId) provider.responseId = responseId;
  if (stopReason) provider.stopReason = stopReason;
  return Object.keys(provider).length > 0 ? provider : null;
}

function normalizeFallbackMetadata(value: unknown): MessageMetadata["fallback"] | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const from = normalizeModelMetadata(record.from);
  const to = normalizeModelMetadata(record.to);
  const reason = normalizeOptionalNonEmptyString(record.reason);
  if (!from && !to && !reason && record.used !== true) {
    return null;
  }
  return {
    used: true,
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(reason ? { reason } : {}),
  };
}

function normalizeModelMetadata(value: unknown): ProcMessageModelMetadata | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const provider = normalizeOptionalNonEmptyString(record.provider);
  const model = normalizeOptionalNonEmptyString(record.model);
  if (!provider && !model) {
    return null;
  }
  return {
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
  };
}

export function normalizeUsageState(value: unknown): ProcUsageState | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const inputTokens = normalizeNonNegativeNumber(record.inputTokens ?? record.input) ?? 0;
  const outputTokens = normalizeNonNegativeNumber(record.outputTokens ?? record.output) ?? 0;
  const cacheReadTokens = normalizeNonNegativeNumber(record.cacheReadTokens ?? record.cacheRead) ?? 0;
  const cacheWriteTokens = normalizeNonNegativeNumber(record.cacheWriteTokens ?? record.cacheWrite) ?? 0;
  const totalTokens = normalizeNonNegativeNumber(record.totalTokens)
    ?? inputTokens + outputTokens;
  const generations = normalizePositiveInteger(record.generations);
  const updatedAt = normalizeNonNegativeNumber(record.updatedAt);

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
    cost: normalizeUsageCost(record.cost),
    ...(generations !== null ? { generations } : {}),
    ...(record.costIncomplete === true ? { costIncomplete: true } : {}),
    ...(updatedAt !== null ? { updatedAt } : {}),
  };
}

function normalizeUsageCost(value: unknown): ProcUsageCost | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const input = normalizeNonNegativeNumber(record.input) ?? 0;
  const output = normalizeNonNegativeNumber(record.output) ?? 0;
  const cacheRead = normalizeNonNegativeNumber(record.cacheRead) ?? 0;
  const cacheWrite = normalizeNonNegativeNumber(record.cacheWrite) ?? 0;
  const total = normalizeNonNegativeNumber(record.total) ?? input + output + cacheRead + cacheWrite;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total,
    currency: "USD",
    source: normalizeUsageCostSource(record.source) ?? "provider",
  };
}

function mergeUsageStates(
  current: ProcUsageState | null,
  next: ProcUsageState,
): ProcUsageState {
  const cost = mergeUsageCosts(current?.cost ?? null, next.cost);
  const currentGenerations = current?.generations ?? 0;
  const nextGenerations = next.generations ?? 1;
  const costIncomplete = current?.costIncomplete === true
    || next.costIncomplete === true
    || next.cost === null
    || (current !== null && current.cost === null);

  return {
    inputTokens: (current?.inputTokens ?? 0) + next.inputTokens,
    outputTokens: (current?.outputTokens ?? 0) + next.outputTokens,
    cacheReadTokens: (current?.cacheReadTokens ?? 0) + next.cacheReadTokens,
    cacheWriteTokens: (current?.cacheWriteTokens ?? 0) + next.cacheWriteTokens,
    totalTokens: (current?.totalTokens ?? 0) + next.totalTokens,
    cost,
    generations: currentGenerations + nextGenerations,
    ...(costIncomplete ? { costIncomplete: true } : {}),
    updatedAt: Date.now(),
  };
}

function mergeUsageCosts(
  current: ProcUsageCost | null,
  next: ProcUsageCost | null,
): ProcUsageCost | null {
  if (!current && !next) {
    return null;
  }
  if (!current) {
    return cloneUsageCost(next!);
  }
  if (!next) {
    return cloneUsageCost(current);
  }
  return {
    input: current.input + next.input,
    output: current.output + next.output,
    cacheRead: current.cacheRead + next.cacheRead,
    cacheWrite: current.cacheWrite + next.cacheWrite,
    total: current.total + next.total,
    currency: "USD",
    source: current.source === next.source ? current.source : "mixed",
  };
}

function cloneUsageCost(cost: ProcUsageCost): ProcUsageCost {
  return {
    input: cost.input,
    output: cost.output,
    cacheRead: cost.cacheRead,
    cacheWrite: cost.cacheWrite,
    total: cost.total,
    currency: "USD",
    source: cost.source,
  };
}

function emptyUsageState(): ProcUsageState {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    cost: null,
    generations: 0,
  };
}

function usageStateToPiUsage(usage: ProcUsageState | null | undefined): AssistantMessage["usage"] {
  return {
    input: usage?.inputTokens ?? 0,
    output: usage?.outputTokens ?? 0,
    cacheRead: usage?.cacheReadTokens ?? 0,
    cacheWrite: usage?.cacheWriteTokens ?? 0,
    totalTokens: usage?.totalTokens ?? 0,
    cost: {
      input: usage?.cost?.input ?? 0,
      output: usage?.cost?.output ?? 0,
      cacheRead: usage?.cost?.cacheRead ?? 0,
      cacheWrite: usage?.cost?.cacheWrite ?? 0,
      total: usage?.cost?.total ?? 0,
    },
  };
}

function normalizeAssistantStopReason(value: unknown): AssistantMessage["stopReason"] {
  return value === "length" || value === "toolUse" || value === "error" || value === "aborted"
    ? value
    : "stop";
}

export function parseAssistantMessageMeta(raw: string | null): AssistantMessageMeta {
  if (!raw) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }

  if (Array.isArray(parsed)) {
    return { toolCalls: parsed as ToolCall[] };
  }
  if (!parsed || typeof parsed !== "object") {
    return {};
  }

  const meta = parsed as Record<string, unknown>;
  return {
    thinking: Array.isArray(meta.thinking)
      ? meta.thinking as ThinkingContent[]
      : undefined,
    toolCalls: Array.isArray(meta.toolCalls)
      ? meta.toolCalls as ToolCall[]
      : undefined,
  };
}

function normalizeNullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function parseConversationArchiveKind(value: string): ConversationArchiveKind {
  if (value === "process-reset" || value === "kill") {
    return value;
  }
  return "reset";
}

function contextStateKey(conversationId: string): string {
  return `contextState:${conversationId}`;
}

function conversationUsageKey(conversationId: string): string {
  return `conversationUsage:${conversationId}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalizeOptionalNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function normalizeNonNegativeNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return value >= 0 ? value : null;
}

function normalizePositiveInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  const normalized = Math.trunc(value);
  return normalized > 0 ? normalized : null;
}

function normalizeUsageCostSource(value: unknown): ProcUsageCostSource | null {
  if (value === "provider" || value === "model-pricing" || value === "mixed") {
    return value;
  }
  return null;
}

function buildFallbackUserContent(
  text: string,
  media: ReturnType<typeof parseStoredProcessMedia>,
): TextContent[] {
  const content: TextContent[] = [];
  if (text.trim().length > 0) {
    content.push({ type: "text", text });
  }

  const fallbackBlocks = buildFallbackMediaBlocks(media);
  if (fallbackBlocks.length > 0) {
    content.push(...fallbackBlocks);
  }

  if (content.length === 0) {
    content.push({
      type: "text",
      text: media.map((item) => describeStoredProcessMedia(item)).join("\n"),
    });
  }

  return content;
}

export function stringifyAssistantMessageMeta(
  meta: AssistantMessageMeta,
): string | undefined {
  const thinking = meta.thinking?.length ? meta.thinking : undefined;
  const toolCalls = meta.toolCalls?.length ? meta.toolCalls : undefined;

  if (!thinking && !toolCalls) {
    return undefined;
  }
  if (!thinking && toolCalls) {
    return JSON.stringify(toolCalls);
  }

  return JSON.stringify({
    thinking,
    toolCalls,
  });
}
