import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V011_RECOVER_INTERRUPTED_SETUP: SqlMigration = {
  id: 11,
  name: "recover_interrupted_setup",
  statements: [
    `
      CREATE TABLE IF NOT EXISTS setup_recovery (
        scope INTEGER PRIMARY KEY CHECK (scope = 1),
        username TEXT NOT NULL,
        uid INTEGER NOT NULL,
        gid INTEGER NOT NULL,
        plan_fingerprint TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `,
  ],
};
