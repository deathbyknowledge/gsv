import type { SqlMigration } from "../../schema/runner";

/**
 * Persist the two halves of the live-credential fence.
 *
 * The Master outbox is populated by a SQLite trigger so revoking a token and
 * making its runtime fence deliverable are one atomic statement. User Kernels
 * store only the non-secret token id after accepting that delivery.
 */
export const KERNEL_V018_FENCE_AUTH_TOKEN_SESSIONS: SqlMigration = {
  id: 18,
  name: "fence_auth_token_sessions",
  statements: [
    `
      CREATE TABLE auth_token_revocation_outbox (
        token_id       TEXT    PRIMARY KEY,
        uid            INTEGER NOT NULL,
        revoked_at     INTEGER NOT NULL,
        attempt_count  INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        next_attempt_at INTEGER NOT NULL,
        last_error     TEXT
      )
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_auth_token_revocation_outbox_due
      ON auth_token_revocation_outbox(next_attempt_at, revoked_at)
    `,
    `
      CREATE TABLE auth_token_revocation_tombstones (
        token_id   TEXT    PRIMARY KEY,
        uid        INTEGER NOT NULL,
        revoked_at INTEGER NOT NULL
      )
    `,
    `
      CREATE TRIGGER auth_tokens_enqueue_revocation
      AFTER UPDATE OF revoked_at ON auth_tokens
      WHEN OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL
      BEGIN
        INSERT INTO auth_token_revocation_outbox (
          token_id, uid, revoked_at, attempt_count, next_attempt_at, last_error
        ) VALUES (
          NEW.token_id, NEW.uid, NEW.revoked_at, 0, NEW.revoked_at, NULL
        )
        ON CONFLICT(token_id) DO UPDATE SET
          uid = excluded.uid,
          revoked_at = excluded.revoked_at,
          attempt_count = 0,
          next_attempt_at = excluded.next_attempt_at,
          last_error = NULL;
      END
    `,
  ],
};
