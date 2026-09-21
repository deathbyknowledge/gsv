import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V069_PROCESS_SPAWN_RECEIPTS: SqlMigration = {
  id: 69, name: "process_spawn_receipts",
  statements: [
    `CREATE TABLE process_spawn_receipts (
      owner_uid INTEGER NOT NULL, intent_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
      process_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (owner_uid, intent_id)
    )`,
    "CREATE INDEX process_spawn_receipts_expiry ON process_spawn_receipts (created_at)",
  ],
};
