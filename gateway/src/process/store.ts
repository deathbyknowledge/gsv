/**
 * ProcessStore — SQLite-backed state for a single Process DO.
 *
 * Manages:
 *   - messages: the active conversation (agent loop working memory)
 *   - pending_tool_calls: in-flight tool calls awaiting results
 *   - message_queue: FIFO queue for messages arriving during an active run
 *   - process_kv: key-value metadata (processId, archiveId, etc.)
 */

import type { SyscallName } from "../syscalls";
import { SYSCALL_TOOL_NAMES } from "../syscalls/constants";
import type { ProcContextFile, ProcContextState } from "../syscalls/proc";
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

const DEFAULT_MESSAGE_READ_LIMIT = 200;

export type ToolCallStatus = "pending" | "completed" | "error";

export type ToolCallRecord = {
  id: string;
  runId: string;
  conversationId: string;
  generation: number;
  call: string;
  status: ToolCallStatus;
  result: unknown;
  error: string | null;
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
  createdAt: number;
};

export type AssistantMessageMeta = {
  thinking?: ThinkingContent[];
  toolCalls?: ToolCall[];
};

export type QueuedMessage = {
  id: number;
  runId: string;
  conversationId: string;
  generation: number;
  message: string;
  media: string | null;
  overrides: string | null;
  origin?: string | null;
};

export type PendingHilRecord = {
  requestId: string;
  runId: string;
  conversationId: string;
  generation: number;
  toolCallId: string;
  toolName: string;
  syscall: string;
  args: Record<string, unknown>;
  remainingToolCalls: ToolCall[];
  createdAt: number;
};

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
      const compactCount = records.length - keepLast;
      return compactCount > 0 ? records.slice(0, compactCount) : [];
    }

    if (opts.throughMessageId !== undefined) {
      const throughMessageId = Math.trunc(opts.throughMessageId);
      return records.filter((record) => record.id <= throughMessageId);
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
      kind: row.kind === "compaction" ? "compaction" : "compaction",
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
      kind: row.kind === "compaction" ? "compaction" : "compaction",
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
    id: string,
    runId: string,
    call: SyscallName,
    args: unknown,
    conversationId: string = DEFAULT_CONVERSATION_ID,
  ): void {
    const normalizedConversationId = normalizeConversationId(conversationId);
    const generation = this.getConversationGeneration(normalizedConversationId);
    this.sql.exec(
      `INSERT OR REPLACE INTO pending_tool_calls (
        id, run_id, conversation_id, generation, call, args_json, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
      id,
      runId,
      normalizedConversationId,
      generation,
      call,
      JSON.stringify(args),
      Date.now(),
    );
  }

  resolve(id: string, result: unknown): void {
    this.sql.exec(
      "UPDATE pending_tool_calls SET status = 'completed', result_json = ? WHERE id = ?",
      JSON.stringify(result ?? null),
      id,
    );
  }

  fail(id: string, error: string): void {
    this.sql.exec(
      "UPDATE pending_tool_calls SET status = 'error', error = ? WHERE id = ?",
      error,
      id,
    );
  }

  getPending(id: string): { id: string; runId: string } | null {
    const rows = [...this.sql.exec<{ id: string; run_id: string }>(
      "SELECT id, run_id FROM pending_tool_calls WHERE id = ? AND status = 'pending'",
      id,
    )];
    if (rows.length === 0) return null;
    return { id: rows[0].id, runId: rows[0].run_id };
  }

  isRunResolved(runId: string): boolean {
    const rows = [...this.sql.exec<{ cnt: number }>(
      "SELECT COUNT(*) as cnt FROM pending_tool_calls WHERE run_id = ? AND status = 'pending'",
      runId,
    )];
    return (rows[0]?.cnt ?? 0) === 0;
  }

  getResults(runId: string): ToolCallRecord[] {
    return [...this.sql.exec<{
      id: string;
      run_id: string;
      conversation_id: string;
      generation: number;
      call: string;
      status: string;
      result_json: string | null;
      error: string | null;
    }>(
      `SELECT id, run_id, conversation_id, generation, call, status, result_json, error
         FROM pending_tool_calls
        WHERE run_id = ?`,
      runId,
    )].map((row) => ({
      id: row.id,
      runId: row.run_id,
      conversationId: row.conversation_id,
      generation: row.generation,
      call: row.call,
      status: row.status as ToolCallStatus,
      result: row.result_json ? JSON.parse(row.result_json) : null,
      error: row.error,
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
        request_id, run_id, conversation_id, generation, tool_call_id, tool_name, syscall,
        args_json, remaining_tool_calls_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.requestId,
      record.runId,
      normalizeConversationId(record.conversationId),
      record.generation,
      record.toolCallId,
      record.toolName,
      record.syscall,
      JSON.stringify(record.args),
      JSON.stringify(record.remainingToolCalls),
      record.createdAt,
    );
  }

  getPendingHil(requestId?: string): PendingHilRecord | null {
    const rows = [
      ...this.sql.exec<{
        request_id: string;
        run_id: string;
        conversation_id: string;
        generation: number;
        tool_call_id: string;
        tool_name: string;
        syscall: string;
        args_json: string;
        remaining_tool_calls_json: string;
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
      generation: row.generation,
      toolCallId: row.tool_call_id,
      toolName: row.tool_name,
      syscall: row.syscall,
      args: JSON.parse(row.args_json) as Record<string, unknown>,
      remainingToolCalls: JSON.parse(row.remaining_tool_calls_json) as ToolCall[],
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
      runId?: string;
      createdAt?: number;
    },
  ): number {
    const conversationId = normalizeConversationId(opts?.conversationId);
    const generation = opts?.generation ?? this.getConversationGeneration(conversationId);
    this.sql.exec(
      `INSERT INTO messages (
        conversation_id, generation, run_id, role, content, tool_calls, tool_call_id, media_json, origin_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      conversationId,
      generation,
      opts?.runId ?? null,
      role,
      content,
      opts?.toolCalls ?? null,
      opts?.toolCallId ?? null,
      opts?.media ?? null,
      opts?.origin ?? null,
      opts?.createdAt ?? Date.now(),
    );

    const rows = [...this.sql.exec<{ id: number }>("SELECT last_insert_rowid() as id")];
    return rows[0]?.id ?? -1;
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

    const rows = [...this.sql.exec<{
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
      created_at: number;
      }>(
        `SELECT * FROM messages WHERE ${where.join(" AND ")} ORDER BY id ${order} ${pagination.clause}`,
      ...args,
      ...pagination.args,
    )];
    if (tail || beforeMessageId !== undefined) {
      rows.reverse();
    }

    return rows.map((row) => ({
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
      createdAt: row.created_at,
    }));
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
    return [...this.sql.exec<{
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
      created_at: number;
    }>(
      `SELECT * FROM messages
        WHERE conversation_id = ?
          AND generation = ?
        ORDER BY id ASC`,
      normalizedConversationId,
      normalizedGeneration,
    )].map((row) => ({
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
      createdAt: row.created_at,
    }));
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

    return [...this.sql.exec<{
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
      created_at: number;
    }>(
      `SELECT * FROM messages
        WHERE conversation_id = ?
          AND generation = ?
          AND id > ?
          ${createdAtFilter}
        ORDER BY id ASC`,
      ...args,
    )].map((row) => ({
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
      createdAt: row.created_at,
    }));
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

  allMessagesForArchive(conversationId: string = DEFAULT_CONVERSATION_ID): MessageRecord[] {
    const normalizedConversationId = normalizeConversationId(conversationId);
    return [...this.sql.exec<{
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
      created_at: number;
      }>(
        "SELECT * FROM messages WHERE conversation_id = ? ORDER BY id ASC",
      normalizedConversationId,
    )].map((row) => ({
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
      createdAt: row.created_at,
    }));
  }

  clearMessages(conversationId: string = DEFAULT_CONVERSATION_ID): number {
    const normalizedConversationId = normalizeConversationId(conversationId);
    const count = this.messageCount(normalizedConversationId);
    this.sql.exec("DELETE FROM messages WHERE conversation_id = ?", normalizedConversationId);
    this.deleteContextState(normalizedConversationId);
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
            api: "",
            provider: "",
            model: "",
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: "stop",
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
   * Append a tool result message. Stores the toolName and isError flag
   * in the tool_calls column as JSON metadata.
   */
  appendToolResult(
    toolCallId: string,
    syscallName: string,
    content: string,
    isError: boolean,
    conversationId: string = DEFAULT_CONVERSATION_ID,
    runId?: string,
  ): number {
    const toolName = SYSCALL_TOOL_NAMES[syscallName] ?? syscallName;
    return this.appendMessage("toolResult", content, {
      conversationId,
      runId,
      toolCallId,
      toolCalls: JSON.stringify({ toolName, isError }),
    });
  }

  // --- Message queue ---

  enqueue(
    runId: string,
    message: string,
    media?: string,
    overrides?: string,
    conversationId: string = DEFAULT_CONVERSATION_ID,
    origin?: string,
  ): void {
    const normalizedConversationId = normalizeConversationId(conversationId);
    const generation = this.getConversationGeneration(normalizedConversationId);
    this.sql.exec(
      `INSERT INTO message_queue (
        run_id, conversation_id, generation, message, media_json, overrides_json, origin_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      runId,
      normalizedConversationId,
      generation,
      message,
      media ?? null,
      overrides ?? null,
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
        overrides_json: string | null;
        origin_json: string | null;
      }>(
        normalizedConversationId
          ? `SELECT id, run_id, conversation_id, generation, message, media_json, overrides_json, origin_json
               FROM message_queue
              WHERE conversation_id = ?
              ORDER BY id ASC
              LIMIT 1`
          : `SELECT id, run_id, conversation_id, generation, message, media_json, overrides_json, origin_json
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
      overrides: row.overrides_json,
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
        overrides_json: string | null;
        origin_json: string | null;
      }>(
        normalizedConversationId
          ? `SELECT id, run_id, conversation_id, generation, message, media_json, overrides_json, origin_json
               FROM message_queue
              WHERE conversation_id = ?
              ORDER BY id ASC`
          : `SELECT id, run_id, conversation_id, generation, message, media_json, overrides_json, origin_json
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
      overrides: row.overrides_json,
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
