/**
 * ProcessStore — SQLite-backed state for a single Process DO.
 *
 * Manages pending tool calls and key-value metadata. This is the
 * process's "working memory" — active conversation and tool state
 * that lives in the DO's SQLite, not in R2.
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

export class ProcessStore {
  constructor(private readonly sql: SqlStorage) {}

  init(): void {
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
      CREATE TABLE IF NOT EXISTS process_meta (
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

  // --- Metadata ---

  getMeta(key: string): string | null {
    const rows = [...this.sql.exec<{ value: string }>(
      "SELECT value FROM process_meta WHERE key = ?",
      key,
    )];
    return rows[0]?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.sql.exec(
      "INSERT OR REPLACE INTO process_meta (key, value) VALUES (?, ?)",
      key,
      value,
    );
  }

  deleteMeta(key: string): void {
    this.sql.exec("DELETE FROM process_meta WHERE key = ?", key);
  }
}
