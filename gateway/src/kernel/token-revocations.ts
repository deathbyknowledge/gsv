export type TokenRevocationNotice = {
  tokenId: string;
  uid: number;
  revokedAt: number;
};

export type TokenRevocationOutboxRecord = TokenRevocationNotice & {
  attemptCount: number;
  nextAttemptAt: number;
  lastError: string | null;
};

type TokenRevocationOutboxRow = {
  token_id: string;
  uid: number;
  revoked_at: number;
  attempt_count: number;
  next_attempt_at: number;
  last_error: string | null;
};

const MAX_RETRY_DELAY_MS = 5 * 60_000;

/** Durable, non-secret coordination state for invalidating live token sessions. */
export class TokenRevocationStore {
  constructor(private readonly sql: SqlStorage) {}

  remember(notice: TokenRevocationNotice): void {
    this.sql.exec(
      `INSERT INTO auth_token_revocation_tombstones (token_id, uid, revoked_at)
       VALUES (?, ?, ?)
       ON CONFLICT(token_id) DO UPDATE SET
         uid = excluded.uid,
         revoked_at = MIN(auth_token_revocation_tombstones.revoked_at, excluded.revoked_at)`,
      notice.tokenId,
      notice.uid,
      notice.revokedAt,
    );
  }

  rememberAll(notices: readonly TokenRevocationNotice[]): void {
    for (const notice of notices) {
      this.remember(notice);
    }
  }

  isRevoked(tokenId: string): boolean {
    return this.sql.exec<{ present: number }>(
      `SELECT 1 AS present
       FROM auth_token_revocation_tombstones
       WHERE token_id = ?
       LIMIT 1`,
      tokenId,
    ).toArray().length > 0;
  }

  listDue(now = Date.now(), limit = 32): TokenRevocationOutboxRecord[] {
    const boundedLimit = Math.max(1, Math.min(256, Math.floor(limit)));
    return this.sql.exec<TokenRevocationOutboxRow>(
      `SELECT token_id, uid, revoked_at, attempt_count, next_attempt_at, last_error
       FROM auth_token_revocation_outbox
       WHERE next_attempt_at <= ?
       ORDER BY next_attempt_at, revoked_at
       LIMIT ?`,
      now,
      boundedLimit,
    ).toArray().map(mapOutboxRow);
  }

  nextAttemptAt(): number | null {
    const row = this.sql.exec<{ next_attempt_at: number | null }>(
      "SELECT MIN(next_attempt_at) AS next_attempt_at FROM auth_token_revocation_outbox",
    ).toArray()[0];
    return row?.next_attempt_at ?? null;
  }

  acknowledge(tokenId: string, uid?: number): boolean {
    const rows = typeof uid === "number"
      ? this.sql.exec<{ token_id: string }>(
          `DELETE FROM auth_token_revocation_outbox
           WHERE token_id = ? AND uid = ?
           RETURNING token_id`,
          tokenId,
          uid,
        ).toArray()
      : this.sql.exec<{ token_id: string }>(
          `DELETE FROM auth_token_revocation_outbox
           WHERE token_id = ?
           RETURNING token_id`,
          tokenId,
        ).toArray();
    return rows.length > 0;
  }

  recordFailure(tokenId: string, _error: unknown, now = Date.now()): void {
    const current = this.sql.exec<{ attempt_count: number }>(
      `SELECT attempt_count
       FROM auth_token_revocation_outbox
       WHERE token_id = ?
       LIMIT 1`,
      tokenId,
    ).toArray()[0];
    if (!current) return;

    const attemptCount = current.attempt_count + 1;
    const retryDelay = Math.min(MAX_RETRY_DELAY_MS, 1_000 * (2 ** Math.min(8, attemptCount - 1)));
    this.sql.exec(
      `UPDATE auth_token_revocation_outbox
       SET attempt_count = ?, next_attempt_at = ?, last_error = ?
       WHERE token_id = ?`,
      attemptCount,
      now + retryDelay,
      "delivery failed",
      tokenId,
    );
  }
}

function mapOutboxRow(row: TokenRevocationOutboxRow): TokenRevocationOutboxRecord {
  return {
    tokenId: row.token_id,
    uid: row.uid,
    revokedAt: row.revoked_at,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error,
  };
}
