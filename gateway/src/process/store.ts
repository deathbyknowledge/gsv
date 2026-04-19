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
import type { ProcContextFile } from "../syscalls/proc";
import type {
  Message,
  UserMessage,
  AssistantMessage,
  ToolResultMessage,
  TextContent,
  ThinkingContent,
  ToolCall,
} from "@mariozechner/pi-ai";
import {
  buildFallbackMediaBlocks,
  describeStoredProcessMedia,
  parseStoredProcessMedia,
} from "./media";

export type ToolCallStatus = "pending" | "completed" | "error";

export type ToolCallRecord = {
  id: string;
  runId: string;
  call: string;
  status: ToolCallStatus;
  result: unknown;
  error: string | null;
};

export type MessageRole = "user" | "assistant" | "system" | "toolResult";

export type MessageRecord = {
  id: number;
  role: MessageRole;
  content: string;
  toolCalls: string | null;
  toolCallId: string | null;
  media: string | null;
  createdAt: number;
};

export type AssistantMessageMeta = {
  thinking?: ThinkingContent[];
  toolCalls?: ToolCall[];
};

export type QueuedMessage = {
  id: number;
  runId: string;
  message: string;
  media: string | null;
  overrides: string | null;
};

export type PendingHilRecord = {
  requestId: string;
  runId: string;
  toolCallId: string;
  toolName: string;
  syscall: string;
  args: Record<string, unknown>;
  remainingToolCalls: ToolCall[];
  createdAt: number;
};

export class ProcessStore {
  constructor(private readonly sql: SqlStorage) {}

  init(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        tool_calls TEXT,
        tool_call_id TEXT,
        media_json TEXT,
        created_at INTEGER NOT NULL
      )
    `);

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS pending_tool_calls (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        call TEXT NOT NULL,
        args_json TEXT NOT NULL,
        result_json TEXT,
        error TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL
      )
    `);

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS process_kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS message_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        message TEXT NOT NULL,
        media_json TEXT,
        overrides_json TEXT,
        created_at INTEGER NOT NULL
      )
    `);

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS pending_hil (
        request_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        tool_call_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        syscall TEXT NOT NULL,
        args_json TEXT NOT NULL,
        remaining_tool_calls_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);

    // TODO: get a proper migration strat
    this.ensureColumn(
      "messages",
      "media_json",
      "ALTER TABLE messages ADD COLUMN media_json TEXT",
    );
    this.ensureColumn(
      "message_queue",
      "media_json",
      "ALTER TABLE message_queue ADD COLUMN media_json TEXT",
    );
    this.ensureColumn(
      "message_queue",
      "overrides_json",
      "ALTER TABLE message_queue ADD COLUMN overrides_json TEXT",
    );
  }

  // --- Tool calls ---

  register(id: string, runId: string, call: SyscallName, args: unknown): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO pending_tool_calls (id, run_id, call, args_json, status, created_at)
       VALUES (?, ?, ?, ?, 'pending', ?)`,
      id,
      runId,
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
      call: string;
      status: string;
      result_json: string | null;
      error: string | null;
    }>(
      "SELECT id, run_id, call, status, result_json, error FROM pending_tool_calls WHERE run_id = ?",
      runId,
    )].map((row) => ({
      id: row.id,
      runId: row.run_id,
      call: row.call,
      status: row.status as ToolCallStatus,
      result: row.result_json ? JSON.parse(row.result_json) : null,
      error: row.error,
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
        request_id, run_id, tool_call_id, tool_name, syscall,
        args_json, remaining_tool_calls_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      record.requestId,
      record.runId,
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

  clearPendingHil(): void {
    this.sql.exec("DELETE FROM pending_hil");
  }

  appendMessage(
    role: MessageRole,
    content: string,
    opts?: { toolCalls?: string; toolCallId?: string; media?: string },
  ): number {
    this.sql.exec(
      `INSERT INTO messages (role, content, tool_calls, tool_call_id, media_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      role,
      content,
      opts?.toolCalls ?? null,
      opts?.toolCallId ?? null,
      opts?.media ?? null,
      Date.now(),
    );

    const rows = [...this.sql.exec<{ id: number }>("SELECT last_insert_rowid() as id")];
    return rows[0]?.id ?? -1;
  }

  getMessages(opts?: { limit?: number; offset?: number }): MessageRecord[] {
    const limit = opts?.limit ?? 200;
    const offset = opts?.offset ?? 0;

    return [...this.sql.exec<{
      id: number;
      role: string;
        content: string;
        tool_calls: string | null;
        tool_call_id: string | null;
        media_json: string | null;
        created_at: number;
      }>(
        "SELECT * FROM messages ORDER BY id ASC LIMIT ? OFFSET ?",
      limit,
      offset,
    )].map((row) => ({
      id: row.id,
      role: row.role as MessageRole,
      content: row.content,
      toolCalls: row.tool_calls,
      toolCallId: row.tool_call_id,
      media: row.media_json,
      createdAt: row.created_at,
    }));
  }

  messageCount(): number {
    const rows = [...this.sql.exec<{ cnt: number }>(
      "SELECT COUNT(*) as cnt FROM messages",
    )];
    return rows[0]?.cnt ?? 0;
  }

  allMessagesForArchive(): MessageRecord[] {
    return [...this.sql.exec<{
      id: number;
      role: string;
        content: string;
        tool_calls: string | null;
        tool_call_id: string | null;
        media_json: string | null;
        created_at: number;
      }>(
        "SELECT * FROM messages ORDER BY id ASC",
    )].map((row) => ({
      id: row.id,
      role: row.role as MessageRole,
      content: row.content,
      toolCalls: row.tool_calls,
      toolCallId: row.tool_call_id,
      media: row.media_json,
      createdAt: row.created_at,
    }));
  }

  clearMessages(): number {
    const count = this.messageCount();
    this.sql.exec("DELETE FROM messages");
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

  toMessages(opts?: { limit?: number; offset?: number }): Message[] {
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
  ): number {
    const toolName = SYSCALL_TOOL_NAMES[syscallName] ?? syscallName;
    return this.appendMessage("toolResult", content, {
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
  ): void {
    this.sql.exec(
      `INSERT INTO message_queue (run_id, message, media_json, overrides_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      runId,
      message,
      media ?? null,
      overrides ?? null,
      Date.now(),
    );
  }

  dequeue(): QueuedMessage | null {
    const rows = [
      ...this.sql.exec<{
        id: number;
        run_id: string;
        message: string;
        media_json: string | null;
        overrides_json: string | null;
      }>(
        "SELECT id, run_id, message, media_json, overrides_json FROM message_queue ORDER BY id ASC LIMIT 1",
      ),
    ];
    if (rows.length === 0) return null;
    const row = rows[0];
    this.sql.exec("DELETE FROM message_queue WHERE id = ?", row.id);
    return {
      id: row.id,
      runId: row.run_id,
      message: row.message,
      media: row.media_json,
      overrides: row.overrides_json,
    };
  }

  drainQueue(): QueuedMessage[] {
    const rows = [
      ...this.sql.exec<{
        id: number;
        run_id: string;
        message: string;
        media_json: string | null;
        overrides_json: string | null;
      }>(
        "SELECT id, run_id, message, media_json, overrides_json FROM message_queue ORDER BY id ASC",
      ),
    ];
    if (rows.length === 0) return [];
    this.sql.exec("DELETE FROM message_queue");
    return rows.map((row) => ({
      id: row.id,
      runId: row.run_id,
      message: row.message,
      media: row.media_json,
      overrides: row.overrides_json,
    }));
  }

  clearQueue(): void {
    this.sql.exec("DELETE FROM message_queue");
  }

  queueSize(): number {
    const rows = [
      ...this.sql.exec<{ cnt: number }>(
        "SELECT COUNT(*) as cnt FROM message_queue",
      ),
    ];
    return rows[0]?.cnt ?? 0;
  }

  private ensureColumn(table: string, column: string, sql: string): void {
    const rows = [...this.sql.exec<{ name: string }>(`PRAGMA table_info(${table})`)];
    if (rows.some((row) => row.name === column)) {
      return;
    }
    this.sql.exec(sql);
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
