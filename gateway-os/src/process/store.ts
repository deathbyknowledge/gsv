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
import type {
  Message,
  UserMessage,
  AssistantMessage,
  ToolResultMessage,
  TextContent,
  ToolCall,
} from "@mariozechner/pi-ai";

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
  createdAt: number;
};

export type QueuedMessage = {
  id: number;
  runId: string;
  message: string;
  media: string | null;
  overrides: string | null;
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

  appendMessage(
    role: MessageRole,
    content: string,
    opts?: { toolCalls?: string; toolCallId?: string },
  ): number {
    this.sql.exec(
      `INSERT INTO messages (role, content, tool_calls, tool_call_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      role,
      content,
      opts?.toolCalls ?? null,
      opts?.toolCallId ?? null,
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
      created_at: number;
    }>(
      "SELECT * FROM messages ORDER BY id ASC",
    )].map((row) => ({
      id: row.id,
      role: row.role as MessageRole,
      content: row.content,
      toolCalls: row.tool_calls,
      toolCallId: row.tool_call_id,
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

  // --- Message conversion to pi-ai format ---

  toMessages(opts?: { limit?: number; offset?: number }): Message[] {
    const records = this.getMessages(opts);
    const messages: Message[] = [];

    for (const r of records) {
      switch (r.role) {
        case "user":
          messages.push({
            role: "user",
            content: r.content,
            timestamp: r.createdAt,
          } satisfies UserMessage);
          break;

        case "assistant": {
          const content: (TextContent | ToolCall)[] = [];
          if (r.content) {
            content.push({ type: "text", text: r.content });
          }
          if (r.toolCalls) {
            const toolCalls = JSON.parse(r.toolCalls) as ToolCall[];
            content.push(...toolCalls);
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
}
