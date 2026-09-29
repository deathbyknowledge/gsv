import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V043_ADD_DEVICE_PAIRINGS: SqlMigration = {
  id: 43,
  name: "add_device_pairings",
  statements: [
    `CREATE TABLE device_pairings (
      id TEXT PRIMARY KEY,
      owner_uid INTEGER NOT NULL,
      target_id TEXT NOT NULL,
      label TEXT NOT NULL,
      replaces_target INTEGER NOT NULL DEFAULT 0,
      secret_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      cancelled_at INTEGER,
      redeemed_at INTEGER,
      redemption_hash TEXT,
      token_id TEXT
    )`,
    "CREATE INDEX device_pairings_owner ON device_pairings(owner_uid, created_at)",
    "CREATE UNIQUE INDEX device_pairings_pending_target ON device_pairings(target_id) WHERE cancelled_at IS NULL AND redeemed_at IS NULL",
  ],
};
