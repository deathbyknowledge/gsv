import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V015_RATE_LIMIT_LOGINS: SqlMigration = {
  id: 15,
  name: "rate_limit_logins",
  statements: [
    `
      CREATE TABLE IF NOT EXISTS auth_login_attempts (
        scope             TEXT    PRIMARY KEY,
        window_started_at INTEGER NOT NULL,
        attempt_count     INTEGER NOT NULL CHECK (attempt_count >= 0),
        blocked_until     INTEGER NOT NULL DEFAULT 0
      )
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_auth_login_attempts_expiry
      ON auth_login_attempts (blocked_until, window_started_at)
    `,
  ],
};
