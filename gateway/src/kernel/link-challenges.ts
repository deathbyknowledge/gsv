import type { AdapterSurfaceKind } from "../adapter-interface";

export type LinkChallengeRecord = {
  code: string;
  adapter: string;
  accountId: string;
  actorId: string;
  surfaceKind: AdapterSurfaceKind;
  surfaceId: string;
  createdAt: number;
  expiresAt: number;
  usedAt: number | null;
  usedByUid: number | null;
};

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const ATTEMPT_WINDOW_MS = 5 * 60 * 1000;
const ATTEMPT_BLOCK_MS = 15 * 60 * 1000;
const USER_ATTEMPT_LIMIT = 8;
const GLOBAL_ATTEMPT_LIMIT = 256;
const GLOBAL_ATTEMPT_SCOPE = "global";
const LINK_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;

export class LinkChallengeStore {
  constructor(private readonly sql: SqlStorage) {}

  issue(input: {
    adapter: string;
    accountId: string;
    actorId: string;
    surfaceKind: AdapterSurfaceKind;
    surfaceId: string;
    ttlMs?: number;
  }): LinkChallengeRecord {
    this.pruneExpired();

    const existing = this.findActive(input.adapter, input.accountId, input.actorId);
    if (existing) {
      return existing;
    }

    const now = Date.now();
    const expiresAt = now + (input.ttlMs ?? DEFAULT_TTL_MS);
    const code = this.generateCode();

    this.sql.exec(
      `INSERT INTO link_challenges
       (code, adapter, account_id, actor_id, surface_kind, surface_id, created_at, expires_at, used_at, used_by_uid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
      code,
      input.adapter,
      input.accountId,
      input.actorId,
      input.surfaceKind,
      input.surfaceId,
      now,
      expiresAt,
    );

    return {
      code,
      adapter: input.adapter,
      accountId: input.accountId,
      actorId: input.actorId,
      surfaceKind: input.surfaceKind,
      surfaceId: input.surfaceId,
      createdAt: now,
      expiresAt,
      usedAt: null,
      usedByUid: null,
    };
  }

  consume(code: string, uid: number): LinkChallengeRecord | null {
    this.pruneExpired();
    const now = Date.now();
    const userScope = `uid:${uid}`;

    if (
      this.isAttemptBlocked(userScope, USER_ATTEMPT_LIMIT, now)
      || this.isAttemptBlocked(GLOBAL_ATTEMPT_SCOPE, GLOBAL_ATTEMPT_LIMIT, now)
    ) {
      return null;
    }

    if (!LINK_CODE_PATTERN.test(code)) {
      this.recordFailedAttempt(userScope, USER_ATTEMPT_LIMIT, now);
      this.recordFailedAttempt(GLOBAL_ATTEMPT_SCOPE, GLOBAL_ATTEMPT_LIMIT, now);
      return null;
    }

    const row = this.sql.exec<RowShape>(
      `SELECT code, adapter, account_id, actor_id, surface_kind, surface_id,
              created_at, expires_at, used_at, used_by_uid
       FROM link_challenges
       WHERE code = ?
       LIMIT 1`,
      code,
    ).toArray()[0];

    if (!row || row.used_at !== null) {
      this.recordFailedAttempt(userScope, USER_ATTEMPT_LIMIT, now);
      this.recordFailedAttempt(GLOBAL_ATTEMPT_SCOPE, GLOBAL_ATTEMPT_LIMIT, now);
      return null;
    }
    if (row.expires_at <= now) {
      this.sql.exec("DELETE FROM link_challenges WHERE code = ?", code);
      this.recordFailedAttempt(userScope, USER_ATTEMPT_LIMIT, now);
      this.recordFailedAttempt(GLOBAL_ATTEMPT_SCOPE, GLOBAL_ATTEMPT_LIMIT, now);
      return null;
    }

    const usedAt = now;
    this.sql.exec(
      `UPDATE link_challenges SET used_at = ?, used_by_uid = ? WHERE code = ?`,
      usedAt,
      uid,
      code,
    );
    this.sql.exec("DELETE FROM link_challenge_attempts WHERE scope = ?", userScope);

    return {
      code: row.code,
      adapter: row.adapter,
      accountId: row.account_id,
      actorId: row.actor_id,
      surfaceKind: row.surface_kind as AdapterSurfaceKind,
      surfaceId: row.surface_id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      usedAt,
      usedByUid: uid,
    };
  }

  pruneExpired(now = Date.now()): number {
    const rows = this.sql.exec<{ cnt: number }>(
      "SELECT COUNT(*) as cnt FROM link_challenges WHERE expires_at <= ? OR (used_at IS NOT NULL AND used_at <= ?)",
      now,
      now - (24 * 60 * 60 * 1000),
    ).toArray();
    const count = rows[0]?.cnt ?? 0;
    if (count > 0) {
      this.sql.exec(
        "DELETE FROM link_challenges WHERE expires_at <= ? OR (used_at IS NOT NULL AND used_at <= ?)",
        now,
        now - (24 * 60 * 60 * 1000),
      );
    }
    return count;
  }

  private findActive(adapter: string, accountId: string, actorId: string): LinkChallengeRecord | null {
    const row = this.sql.exec<RowShape>(
      `SELECT code, adapter, account_id, actor_id, surface_kind, surface_id,
              created_at, expires_at, used_at, used_by_uid
       FROM link_challenges
       WHERE adapter = ? AND account_id = ? AND actor_id = ? AND used_at IS NULL AND expires_at > ?
       ORDER BY created_at DESC
       LIMIT 1`,
      adapter,
      accountId,
      actorId,
      Date.now(),
    ).toArray()[0];

    if (!row) return null;
    return {
      code: row.code,
      adapter: row.adapter,
      accountId: row.account_id,
      actorId: row.actor_id,
      surfaceKind: row.surface_kind as AdapterSurfaceKind,
      surfaceId: row.surface_id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      usedAt: row.used_at,
      usedByUid: row.used_by_uid,
    };
  }

  private isAttemptBlocked(scope: string, limit: number, now: number): boolean {
    const row = this.sql.exec<AttemptRow>(
      `SELECT window_started_at, failed_count, blocked_until
       FROM link_challenge_attempts
       WHERE scope = ?`,
      scope,
    ).toArray()[0];
    if (!row) return false;
    if (row.blocked_until > now) return true;
    if (now - row.window_started_at >= ATTEMPT_WINDOW_MS) {
      this.sql.exec("DELETE FROM link_challenge_attempts WHERE scope = ?", scope);
      return false;
    }
    return row.failed_count >= limit;
  }

  private recordFailedAttempt(scope: string, limit: number, now: number): void {
    const row = this.sql.exec<AttemptRow>(
      `SELECT window_started_at, failed_count, blocked_until
       FROM link_challenge_attempts
       WHERE scope = ?`,
      scope,
    ).toArray()[0];

    if (!row || now - row.window_started_at >= ATTEMPT_WINDOW_MS) {
      this.sql.exec(
        `INSERT INTO link_challenge_attempts
         (scope, window_started_at, failed_count, blocked_until)
         VALUES (?, ?, 1, 0)
         ON CONFLICT(scope) DO UPDATE SET
           window_started_at = excluded.window_started_at,
           failed_count = 1,
           blocked_until = 0`,
        scope,
        now,
      );
      return;
    }

    const failedCount = row.failed_count + 1;
    const blockedUntil = failedCount >= limit ? now + ATTEMPT_BLOCK_MS : row.blocked_until;
    this.sql.exec(
      `UPDATE link_challenge_attempts
       SET failed_count = ?, blocked_until = ?
       WHERE scope = ?`,
      failedCount,
      blockedUntil,
      scope,
    );
  }

  private generateCode(): string {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const random = crypto.getRandomValues(new Uint8Array(8));
    const code = [...random].map((value) => alphabet[value & 31]).join("");
    return `${code.slice(0, 4)}-${code.slice(4)}`;
  }
}

type RowShape = {
  code: string;
  adapter: string;
  account_id: string;
  actor_id: string;
  surface_kind: string;
  surface_id: string;
  created_at: number;
  expires_at: number;
  used_at: number | null;
  used_by_uid: number | null;
};

type AttemptRow = {
  window_started_at: number;
  failed_count: number;
  blocked_until: number;
};
