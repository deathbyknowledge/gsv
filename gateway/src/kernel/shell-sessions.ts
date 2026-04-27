export type ShellSessionStatus = "running" | "completed" | "failed";

export type ShellSessionRecord = {
  sessionId: string;
  deviceId: string;
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

  init(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS shell_sessions (
        session_id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL,
        status TEXT NOT NULL,
        exit_code INTEGER,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER
      )
    `);

    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS shell_sessions_device_idx
      ON shell_sessions (device_id)
    `);
  }

  rememberDeviceSession(
    sessionId: string,
    deviceId: string,
    status: ShellSessionStatus = "running",
    options?: { exitCode?: number | null; error?: string | null; ttlMs?: number },
  ): void {
    const now = Date.now();
    const existing = this.get(sessionId);
    const createdAt = existing?.createdAt ?? now;
    const expiresAt = now + (options?.ttlMs ?? DEFAULT_TTL_MS);
    this.sql.exec(
      `INSERT OR REPLACE INTO shell_sessions
        (session_id, device_id, status, exit_code, error, created_at, updated_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      sessionId,
      deviceId,
      status,
      options?.exitCode ?? existing?.exitCode ?? null,
      options?.error ?? existing?.error ?? null,
      createdAt,
      now,
      expiresAt,
    );
  }

  get(sessionId: string): ShellSessionRecord | null {
    const rows = this.sql.exec<{
      session_id: string;
      device_id: string;
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
    return {
      sessionId: row.session_id,
      deviceId: row.device_id,
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

  failForDevice(deviceId: string, error: string): void {
    const now = Date.now();
    this.sql.exec(
      `UPDATE shell_sessions
       SET status = 'failed', error = ?, updated_at = ?
       WHERE device_id = ? AND status = 'running'`,
      error,
      now,
      deviceId,
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
