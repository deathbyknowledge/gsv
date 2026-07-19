import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V012_RATE_LIMIT_LINK_CHALLENGES: SqlMigration = {
  id: 12,
  name: "rate_limit_link_challenges",
  statements: [
    `
      CREATE TABLE IF NOT EXISTS link_challenge_attempts (
        scope             TEXT    PRIMARY KEY,
        window_started_at INTEGER NOT NULL,
        failed_count      INTEGER NOT NULL,
        blocked_until     INTEGER NOT NULL DEFAULT 0
      )
    `,
  ],
};
