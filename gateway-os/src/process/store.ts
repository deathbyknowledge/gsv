/**
 * ProcessStore — SQLite-backed state for a single Process DO.
 *
 * Manages:
 *   - messages: the active conversation (agent loop working memory)
 *   - pending_tool_calls: in-flight tool calls awaiting results
 *   - process_meta: key-value metadata (processId, archiveId, etc.)
 */

import type { SyscallName } from "../syscalls";

export type ToolCallStatus = "pending" | "completed" | "error";

export type ToolCallRecord = {
  id: string;
  runId: string;
  call: string;
  status: ToolCallStatus;
  result: unknown;
  error: string | null;
};

export type MessageRole = "user" | "assistant" | "system";

export type MessageRecord = {
  id: number;
  role: MessageRole;
  content: string;
  toolCalls: string | null;
  toolCallId: string | null;
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
}
