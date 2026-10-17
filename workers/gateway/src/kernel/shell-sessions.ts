import type { ShellExecResult } from "@humansandmachines/gsv/protocol";

export type ShellSessionStatus = "running" | "completed" | "failed";

export type ShellSessionRecord = {
  sessionId: string;
  targetId: string;
  status: ShellSessionStatus;
  exitCode: number | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
};

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export class ShellSessionStore {
  constructor(private readonly sql: SqlStorage) {}

  rememberDeviceSession(
    sessionId: string,
    targetId: string,
    status: ShellSessionStatus = "running",
    options?: { exitCode?: number | null; error?: string | null; ttlMs?: number },
  ): void {
    const now = Date.now();
    const existing = this.get(sessionId);
    // Responses and status events may race, but a session cannot change targets or restart.
    if (existing && (existing.targetId !== targetId || (existing.status !== "running" && status === "running"))) return;
    const createdAt = existing?.createdAt ?? now;
    const expiresAt = now + (options?.ttlMs ?? DEFAULT_TTL_MS);
    this.sql.exec(
      `INSERT OR REPLACE INTO shell_sessions
        (session_id, target_id, status, exit_code, error, created_at, updated_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      sessionId,
      targetId,
      status,
      options?.exitCode !== undefined ? options.exitCode : existing?.exitCode ?? null,
      options?.error !== undefined ? options.error : existing?.error ?? null,
      createdAt,
      now,
      expiresAt,
    );
  }

  recordResult(targetId: string, result: ShellExecResult | undefined): void {
    const sessionId = result?.sessionId?.trim();
    if (!sessionId || !result) return;
    this.rememberDeviceSession(sessionId, targetId, normalizeStatus(result.status), {
      exitCode: result.status === "running" ? null : result.exitCode ?? null,
      error: result.status === "failed" ? result.error : null,
    });
  }

  recordEvent(targetId: string, event: { sessionId: string; event: string; exitCode?: number; signal?: string }): void {
    const status = event.event === "finished" ? "completed"
      : event.event === "failed" || event.event === "timed_out" ? "failed" : "running";
    this.rememberDeviceSession(event.sessionId, targetId, status, {
      exitCode: event.exitCode ?? null,
      error: event.signal ?? null,
    });
  }

  get(sessionId: string): ShellSessionRecord | null {
    const rows = this.sql.exec<{
      session_id: string;
      target_id: string;
      status: string;
      exit_code: number | null;
      error: string | null;
      created_at: number;
      updated_at: number;
      expires_at: number | null;
    }>(
      `SELECT * FROM shell_sessions WHERE session_id = ?`,
      sessionId,
    ).toArray();

    if (rows.length === 0) return null;
    const row = rows[0];
    if (row.expires_at !== null && row.expires_at <= Date.now()) {
      this.sql.exec(
        `DELETE FROM shell_sessions WHERE session_id = ?`,
        sessionId,
      );
      return null;
    }

    return {
      sessionId: row.session_id,
      targetId: row.target_id,
      status: normalizeStatus(row.status),
      exitCode: row.exit_code,
      error: row.error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      expiresAt: row.expires_at,
    };
  }

  updateStatus(
    sessionId: string,
    status: ShellSessionStatus,
    options?: { exitCode?: number | null; error?: string | null },
  ): void {
    const now = Date.now();
    this.sql.exec(
      `UPDATE shell_sessions
       SET status = ?, exit_code = ?, error = ?, updated_at = ?
       WHERE session_id = ?`,
      status,
      options?.exitCode ?? null,
      options?.error ?? null,
      now,
      sessionId,
    );
  }

  pruneExpired(now = Date.now()): void {
    this.sql.exec(
      `DELETE FROM shell_sessions WHERE expires_at IS NOT NULL AND expires_at <= ?`,
      now,
    );
  }
}

function normalizeStatus(value: string): ShellSessionStatus {
  if (value === "completed" || value === "failed") {
    return value;
  }
  return "running";
}
