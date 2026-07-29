/**
 * ProcessStore — SQLite-backed state for a single Process DO.
 *
 * Manages:
 *   - messages: the process history (agent loop working memory)
 *   - pending_tool_calls: in-flight tool calls awaiting results
 *   - message_queue: FIFO queue for messages arriving during an active run
 *   - process_kv: key-value metadata (processId, archiveId, etc.)
 */

import { SYSCALL_TOOL_NAMES } from "../syscalls/constants";
import type {
  ProcAiConfigSnapshot,
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
} from "./media";
import {
  INITIAL_HISTORY_GENERATION,
  type HistorySegmentKind,
  type ProcessHistorySegmentRecord,
} from "./history";
import {
  PROCESS_AI_CONFIG_STORE_KEY,
  normalizeProcessAiConfigSnapshot,
} from "./ai-config";

const DEFAULT_MESSAGE_READ_LIMIT = 200;

export type ToolCallStatus = "registered" | "pending" | "completed" | "error";

export type ToolCallRecord = {
  id: string;
  dispatchId: string;
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

type MessageRow = {
  id: number;
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
  generation: number;
  message: string;
  media: string | null;
  origin?: string | null;
};

export type PendingHilRecord = {
  requestId: string;
  runId: string;
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

  // --- History ---

  getHistoryGeneration(): number {
    const stored = Number.parseInt(this.getValue("historyGeneration") ?? "", 10);
    return Number.isSafeInteger(stored) && stored > 0
      ? stored
      : INITIAL_HISTORY_GENERATION;
  }

  resetHistory(): number {
    const generation = this.getHistoryGeneration() + 1;
    this.clearMessages();
    this.setValue("historyGeneration", String(generation));
    return generation;
  }

  getHistoryPrefixMessages(opts: {
    keepLast?: number;
    throughMessageId?: number;
  }): MessageRecord[] {
    const records = this.getMessagesForGeneration();

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

  compactHistoryPrefix(opts: {
    generation: number;
    fromMessageId: number;
    toMessageId: number;
    summary: string;
  }): number {
    const summaryMessageId = opts.fromMessageId;
    const now = Date.now();

    this.sql.exec(
      `DELETE FROM messages
        WHERE generation = ?
          AND id >= ?
          AND id <= ?`,
      opts.generation,
      opts.fromMessageId,
      opts.toMessageId,
    );
    this.sql.exec(
      `INSERT INTO messages (
        id, generation, role, content, tool_calls, tool_call_id,
        media_json, origin_json, metadata_json, created_at
      ) VALUES (?, ?, 'system', ?, NULL, NULL, NULL, NULL, NULL, ?)`,
      summaryMessageId,
      opts.generation,
      opts.summary,
      now,
    );

    return summaryMessageId;
  }

  recordHistorySegment(input: {
    id: string;
    generation: number;
    kind: HistorySegmentKind;
    fromMessageId: number;
    toMessageId: number;
    archivePath: string;
    summaryMessageId?: number | null;
  }): ProcessHistorySegmentRecord {
    const createdAt = Date.now();
    this.sql.exec(
      `INSERT INTO history_segments (
        id, generation, kind, from_message_id, to_message_id,
        archive_path, summary_message_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      input.id,
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
      generation: input.generation,
      kind: input.kind,
      fromMessageId: input.fromMessageId,
      toMessageId: input.toMessageId,
      archivePath: input.archivePath,
      summaryMessageId: input.summaryMessageId ?? null,
      createdAt,
    };
  }

  listHistorySegments(): ProcessHistorySegmentRecord[] {
    return [...this.sql.exec<{
      id: string;
      generation: number;
      kind: string;
      from_message_id: number;
      to_message_id: number;
      archive_path: string;
      summary_message_id: number | null;
      created_at: number;
    }>(
      `SELECT id, generation, kind, from_message_id, to_message_id,
              archive_path, summary_message_id, created_at
         FROM history_segments
        ORDER BY created_at ASC, id ASC`,
    )].map((row) => ({
      id: row.id,
      generation: row.generation,
      kind: "compaction",
      fromMessageId: row.from_message_id,
      toMessageId: row.to_message_id,
      archivePath: row.archive_path,
      summaryMessageId: row.summary_message_id,
      createdAt: row.created_at,
    }));
  }

  getHistorySegment(segmentId: string): ProcessHistorySegmentRecord | null {
    const rows = [...this.sql.exec<{
      id: string;
      generation: number;
      kind: string;
      from_message_id: number;
      to_message_id: number;
      archive_path: string;
      summary_message_id: number | null;
      created_at: number;
    }>(
      `SELECT id, generation, kind, from_message_id, to_message_id,
              archive_path, summary_message_id, created_at
         FROM history_segments
        WHERE id = ?
        LIMIT 1`,
      segmentId,
    )];
    const row = rows[0];
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      generation: row.generation,
      kind: "compaction",
      fromMessageId: row.from_message_id,
      toMessageId: row.to_message_id,
      archivePath: row.archive_path,
      summaryMessageId: row.summary_message_id,
      createdAt: row.created_at,
    };
  }

  // --- Tool calls ---

  register(
    dispatchId: string,
    id: string,
    runId: string,
    call: string,
    args: unknown,
  ): void {
    this.sql.exec(
      `INSERT INTO pending_tool_calls (
        dispatch_id, id, run_id, call, args_json, status, created_at
      ) VALUES (?, ?, ?, ?, ?, 'registered', ?)`,
      dispatchId,
      id,
      runId,
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
      call: string;
      args_json: string;
      status: string;
      result_json: string | null;
      error: string | null;
      outcome: string | null;
    }>(
      `SELECT id, dispatch_id, call, args_json, status, result_json, error, outcome
         FROM pending_tool_calls
        WHERE run_id = ?
        ORDER BY created_at ASC, rowid ASC`,
      runId,
    )].map((row) => ({
      id: row.id,
      dispatchId: row.dispatch_id,
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

  clearPendingToolCalls(): void {
    this.sql.exec("DELETE FROM pending_tool_calls");
  }

  setPendingHil(record: PendingHilRecord): void {
    this.clearPendingHil();
    this.sql.exec(
      `INSERT INTO pending_hil (
        request_id, run_id, owner_dispatch_id, tool_call_id,
        tool_name, syscall, args_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      record.requestId,
      record.runId,
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

  clearPendingHil(): void {
    this.sql.exec("DELETE FROM pending_hil");
  }

  appendMessage(
    role: MessageRole,
    content: string,
    opts?: {
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
    const generation = opts?.generation ?? this.getHistoryGeneration();
    const metadataJson = stringifyMessageMetadata(opts?.metadata);
    this.sql.exec(
      `INSERT INTO messages (
        generation, run_id, role, content, tool_calls, tool_call_id,
        media_json, origin_json, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        this.addHistoryUsage(metadata.usage);
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
    const rows = this.sql.exec<{ media_json: string }>(
      `SELECT media_json FROM messages WHERE media_json IS NOT NULL
       UNION ALL
       SELECT media_json FROM message_queue WHERE media_json IS NOT NULL`,
    );
    for (const row of rows) {
      if (parseStoredProcessMedia(row.media_json).some((item) => item.key === key)) {
        return true;
      }
    }
    return false;
  }

  getMessages(opts?: {
    limit?: number | null;
    offset?: number;
    beforeMessageId?: number;
    afterMessageId?: number;
    tail?: boolean;
  }): MessageRecord[] {
    const limit = opts?.limit === null ? null : opts?.limit ?? DEFAULT_MESSAGE_READ_LIMIT;
    const offset = opts?.offset ?? 0;
    const beforeMessageId = opts?.beforeMessageId;
    const afterMessageId = opts?.afterMessageId;
    const tail = opts?.tail === true;
    const hasLimit = limit !== null;
    const where: string[] = [];
    const args: Array<number> = [];
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
    const filter = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

    const rows = [...this.sql.exec<MessageRow>(
        `SELECT * FROM messages ${filter} ORDER BY id ${order} ${pagination.clause}`,
      ...args,
      ...pagination.args,
    )];
    if (tail || beforeMessageId !== undefined) {
      rows.reverse();
    }

    return rows.map(messageRecordFromRow);
  }

  hasMessageBefore(messageId: number): boolean {
    const rows = [...this.sql.exec<{ found: number }>(
      "SELECT 1 as found FROM messages WHERE id < ? LIMIT 1",
      messageId,
    )];
    return rows.length > 0;
  }

  hasMessageAfter(messageId: number): boolean {
    const rows = [...this.sql.exec<{ found: number }>(
      "SELECT 1 as found FROM messages WHERE id > ? LIMIT 1",
      messageId,
    )];
    return rows.length > 0;
  }

  getMessagesForGeneration(generation: number = this.getHistoryGeneration()): MessageRecord[] {
    return [...this.sql.exec<MessageRow>(
      `SELECT * FROM messages
        WHERE generation = ?
        ORDER BY id ASC`,
      generation,
    )].map(messageRecordFromRow);
  }

  getMessagesForGenerationAfter(opts: {
    generation: number;
    afterMessageId: number;
    throughCreatedAt?: number;
  }): MessageRecord[] {
    const args: number[] = [opts.generation, opts.afterMessageId];
    const createdAtFilter = opts.throughCreatedAt === undefined
      ? ""
      : "AND created_at <= ?";
    if (opts.throughCreatedAt !== undefined) {
      args.push(opts.throughCreatedAt);
    }

    return [...this.sql.exec<MessageRow>(
      `SELECT * FROM messages
        WHERE generation = ?
          AND id > ?
          ${createdAtFilter}
        ORDER BY id ASC`,
      ...args,
    )].map(messageRecordFromRow);
  }

  messageCount(): number {
    const rows = [...this.sql.exec<{ cnt: number }>(
      "SELECT COUNT(*) as cnt FROM messages",
    )];
    return rows[0]?.cnt ?? 0;
  }

  messageStats(): {
    count: number;
    firstMessageId: number | null;
    lastMessageId: number | null;
  } {
    const rows = [...this.sql.exec<{ cnt: number; first_id: number | null; last_id: number | null }>(
      "SELECT COUNT(*) as cnt, MIN(id) as first_id, MAX(id) as last_id FROM messages",
    )];
    return {
      count: rows[0]?.cnt ?? 0,
      firstMessageId: rows[0]?.first_id ?? null,
      lastMessageId: rows[0]?.last_id ?? null,
    };
  }

  clearMessages(): number {
    const count = this.messageCount();
    this.sql.exec("DELETE FROM messages");
    this.deleteContextState();
    this.deleteHistoryUsage();
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

  getContextState(): ProcContextState | null {
    const raw = this.getValue("contextState");
    if (!raw) {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as ProcContextState
        : null;
    } catch {
      return null;
    }
  }

  setContextState(state: ProcContextState): void {
    this.setValue("contextState", JSON.stringify(state));
  }

  deleteContextState(): void {
    this.deleteValue("contextState");
  }

  getHistoryUsage(): ProcUsageState | null {
    const raw = this.getValue("historyUsage");
    if (!raw) {
      return null;
    }
    try {
      return normalizeUsageState(JSON.parse(raw)) ?? null;
    } catch {
      return null;
    }
  }

  addHistoryUsage(usage: ProcUsageState): ProcUsageState {
    const normalizedUsage = normalizeUsageState(usage);
    if (!normalizedUsage) {
      return this.getHistoryUsage() ?? emptyUsageState();
    }
    const merged = mergeUsageStates(
      this.getHistoryUsage(),
      normalizedUsage,
    );
    this.setValue("historyUsage", JSON.stringify(merged));
    return merged;
  }

  deleteHistoryUsage(): void {
    this.deleteValue("historyUsage");
  }

  // --- Message conversion to pi-ai format ---

  toMessages(opts?: {
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
    runId?: string,
    outcome?: ProcToolResultOutcome,
  ): number {
    const toolName = SYSCALL_TOOL_NAMES[syscallName] ?? syscallName;
    return this.appendMessage("toolResult", content, {
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
    origin?: string,
  ): void {
    const generation = this.getHistoryGeneration();
    this.sql.exec(
      `INSERT INTO message_queue (
        run_id, generation, message, media_json, origin_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      runId,
      generation,
      message,
      media ?? null,
      origin ?? null,
      Date.now(),
    );
  }

  dequeue(): QueuedMessage | null {
    const rows = [
      ...this.sql.exec<{
        id: number;
        run_id: string;
        generation: number;
        message: string;
        media_json: string | null;
        origin_json: string | null;
      }>(
        `SELECT id, run_id, generation, message, media_json, origin_json
           FROM message_queue
          ORDER BY id ASC
          LIMIT 1`,
      ),
    ];
    if (rows.length === 0) return null;
    const row = rows[0];
    this.sql.exec("DELETE FROM message_queue WHERE id = ?", row.id);
    return {
      id: row.id,
      runId: row.run_id,
      generation: row.generation,
      message: row.message,
      media: row.media_json,
      origin: row.origin_json,
    };
  }

  drainQueue(): QueuedMessage[] {
    const rows = [
      ...this.sql.exec<{
        id: number;
        run_id: string;
        generation: number;
        message: string;
        media_json: string | null;
        origin_json: string | null;
      }>(
        `SELECT id, run_id, generation, message, media_json, origin_json
           FROM message_queue
          ORDER BY id ASC`,
      ),
    ];
    if (rows.length === 0) return [];
    this.sql.exec("DELETE FROM message_queue");
    return rows.map((row) => ({
      id: row.id,
      runId: row.run_id,
      generation: row.generation,
      message: row.message,
      media: row.media_json,
      origin: row.origin_json,
    }));
  }

  clearQueue(): void {
    this.sql.exec("DELETE FROM message_queue");
  }

  queueSize(): number {
    const rows = [...this.sql.exec<{ cnt: number }>(
      "SELECT COUNT(*) as cnt FROM message_queue",
    )];
    return rows[0]?.cnt ?? 0;
  }

  locateRunAdmission(runId: string): "queued" | "recorded" | null {
    const queued = this.sql.exec<{ present: number }>(
      "SELECT 1 AS present FROM message_queue WHERE run_id = ? LIMIT 1",
      runId,
    ).toArray()[0]?.present === 1;
    if (queued) return "queued";

    const recorded = this.sql.exec<{ present: number }>(
      "SELECT 1 AS present FROM messages WHERE run_id = ? LIMIT 1",
      runId,
    ).toArray()[0]?.present === 1;
    return recorded ? "recorded" : null;
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
