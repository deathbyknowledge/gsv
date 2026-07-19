import { canonicalizeLoginUsername } from "../auth/login";
import {
  normalizeLoginSourceScope,
  type LoginSourceScope,
} from "./login-source";

export type LoginCredentialKind = "password" | "token";

export type LoginAttemptPermit = {
  allowed: true;
  targetScope: string;
  targetWindowStartedAt: number;
  workScope: string;
  workWindowStartedAt: number;
  workLimit: number;
  canonicalUsername: string | null;
};

export type LoginAttemptDenied = {
  allowed: false;
  retryAfterMs: number;
};

export type LoginAttemptReservation = LoginAttemptPermit | LoginAttemptDenied;

type AttemptRow = {
  window_started_at: number;
  attempt_count: number;
  blocked_until: number;
};

export type LoginAttemptPolicy = {
  windowMs: number;
  targetBlockMs: number;
  targetLimit: number;
  globalPasswordLimit: number;
  globalTokenLimit: number;
  globalBlockMs: number;
};

const DEFAULT_POLICY: LoginAttemptPolicy = {
  windowMs: 5 * 60 * 1000,
  targetBlockMs: 15 * 60 * 1000,
  targetLimit: 8,
  globalPasswordLimit: 128,
  globalTokenLimit: 1024,
  globalBlockMs: 5 * 60 * 1000,
};

const INVALID_TARGET_KEY = "invalid";
const TEXT_ENCODER = new TextEncoder();

export const LOGIN_TARGET_ATTEMPT_LIMIT = DEFAULT_POLICY.targetLimit;

/**
 * Durable login work budget for one ship Kernel.
 *
 * Valid target scopes are SHA-256 hashes of canonical ASCII account names.
 * Malformed or oversized names share one fixed invalid scope and never reach
 * username-derived hashing or SQLite lookup. This keeps arbitrary
 * unauthenticated input out of durable state while making short casing and
 * surrounding-whitespace variants unable to bypass a target budget. The
 * source-work scope is split by credential work: password (including Git's
 * password-or-token fallback) is costlier than token verification. Both the
 * target failure budget and work ceiling are source-scoped, so one network
 * source cannot lock out another.
 *
 * A reservation is recorded before credential verification. Synchronous
 * SQLite calls then prevent concurrent requests from all passing the budget
 * check before PBKDF2 yields the Durable Object input gate.
 */
export class LoginAttemptStore {
  constructor(
    private readonly sql: SqlStorage,
    private readonly policy: LoginAttemptPolicy = DEFAULT_POLICY,
  ) {}

  async reserve(
    username: string,
    credentialKind: LoginCredentialKind,
    sourceScope: LoginSourceScope,
    now = Date.now(),
  ): Promise<LoginAttemptReservation> {
    const boundedSourceScope = normalizeLoginSourceScope(sourceScope);
    const canonicalUsername = canonicalizeLoginUsername(username);
    const targetKey = await this.targetKey(canonicalUsername);
    const targetScope = `target:${boundedSourceScope}:${targetKey}`;
    const workScope = `work:${boundedSourceScope}:${credentialKind}`;
    const workLimit = credentialKind === "password"
      ? this.policy.globalPasswordLimit
      : this.policy.globalTokenLimit;

    this.pruneExpired(now);

    const targetRetryAfterMs = this.retryAfterMs(
      targetScope,
      this.policy.targetLimit,
      now,
    );
    const workRetryAfterMs = this.retryAfterMs(workScope, workLimit, now);
    if (targetRetryAfterMs > 0 || workRetryAfterMs > 0) {
      return {
        allowed: false,
        retryAfterMs: Math.max(targetRetryAfterMs, workRetryAfterMs),
      };
    }

    const targetWindowStartedAt = this.reserveScope(
      targetScope,
      this.policy.targetLimit,
      0,
      now,
    );
    const workWindowStartedAt = this.reserveScope(
      workScope,
      workLimit,
      this.policy.globalBlockMs,
      now,
    );

    return {
      allowed: true,
      targetScope,
      targetWindowStartedAt,
      workScope,
      workWindowStartedAt,
      workLimit,
      canonicalUsername,
    };
  }

  complete(permit: LoginAttemptPermit, success: boolean, now = Date.now()): void {
    if (!success) {
      this.sql.exec(
        `UPDATE auth_login_attempts
         SET blocked_until = MAX(blocked_until, ?)
         WHERE scope = ?
           AND window_started_at = ?
           AND attempt_count >= ?`,
        now + this.policy.targetBlockMs,
        permit.targetScope,
        permit.targetWindowStartedAt,
        this.policy.targetLimit,
      );
      return;
    }

    this.releaseScope(
      permit.targetScope,
      permit.targetWindowStartedAt,
      this.policy.targetLimit,
    );
    this.releaseScope(
      permit.workScope,
      permit.workWindowStartedAt,
      permit.workLimit,
    );
  }

  private releaseScope(scope: string, windowStartedAt: number, limit: number): void {
    const row = this.get(scope);
    if (!row || row.window_started_at !== windowStartedAt) {
      return;
    }

    const attemptCount = Math.max(0, row.attempt_count - 1);
    if (attemptCount === 0) {
      this.sql.exec(
        `DELETE FROM auth_login_attempts
         WHERE scope = ? AND window_started_at = ?`,
        scope,
        windowStartedAt,
      );
      return;
    }

    this.sql.exec(
      `UPDATE auth_login_attempts
       SET attempt_count = ?,
           blocked_until = CASE WHEN ? < ? THEN 0 ELSE blocked_until END
       WHERE scope = ? AND window_started_at = ?`,
      attemptCount,
      attemptCount,
      limit,
      scope,
      windowStartedAt,
    );
  }

  private retryAfterMs(scope: string, limit: number, now: number): number {
    const row = this.get(scope);
    if (!row) return 0;
    if (row.blocked_until > now) return row.blocked_until - now;

    const windowEndsAt = row.window_started_at + this.policy.windowMs;
    if (windowEndsAt <= now) {
      this.sql.exec("DELETE FROM auth_login_attempts WHERE scope = ?", scope);
      return 0;
    }
    return row.attempt_count >= limit ? windowEndsAt - now : 0;
  }

  private reserveScope(
    scope: string,
    limit: number,
    blockMs: number,
    now: number,
  ): number {
    const row = this.get(scope);
    if (!row || row.window_started_at + this.policy.windowMs <= now) {
      const blockedUntil = limit <= 1 && blockMs > 0 ? now + blockMs : 0;
      this.sql.exec(
        `INSERT INTO auth_login_attempts
         (scope, window_started_at, attempt_count, blocked_until)
         VALUES (?, ?, 1, ?)
         ON CONFLICT(scope) DO UPDATE SET
           window_started_at = excluded.window_started_at,
           attempt_count = 1,
           blocked_until = excluded.blocked_until`,
        scope,
        now,
        blockedUntil,
      );
      return now;
    }

    const attemptCount = row.attempt_count + 1;
    const blockedUntil = blockMs > 0 && attemptCount >= limit
      ? Math.max(row.blocked_until, now + blockMs)
      : row.blocked_until;
    this.sql.exec(
      `UPDATE auth_login_attempts
       SET attempt_count = ?, blocked_until = ?
       WHERE scope = ?`,
      attemptCount,
      blockedUntil,
      scope,
    );
    return row.window_started_at;
  }

  private get(scope: string): AttemptRow | null {
    return this.sql.exec<AttemptRow>(
      `SELECT window_started_at, attempt_count, blocked_until
       FROM auth_login_attempts
       WHERE scope = ?`,
      scope,
    ).toArray()[0] ?? null;
  }

  private pruneExpired(now: number): void {
    this.sql.exec(
      `DELETE FROM auth_login_attempts
       WHERE blocked_until <= ? AND window_started_at <= ?`,
      now,
      now - this.policy.windowMs,
    );
  }

  private async targetKey(canonicalUsername: string | null): Promise<string> {
    if (canonicalUsername === null) {
      return INVALID_TARGET_KEY;
    }
    const digest = await crypto.subtle.digest(
      "SHA-256",
      TEXT_ENCODER.encode(canonicalUsername),
    );
    const hex = Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    return hex;
  }
}
