import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V044_ADD_ACCOUNT_RECOVERY: SqlMigration = {
  id: 44,
  name: "add_account_recovery",
  statements: [
    `CREATE TABLE account_access (
      uid INTEGER PRIMARY KEY,
      credential_epoch INTEGER NOT NULL DEFAULT 0,
      disabled_at INTEGER
    )`,
    `CREATE TABLE account_recovery_claims (
      id TEXT PRIMARY KEY,
      purpose TEXT NOT NULL CHECK (purpose = 'root-password-reset'),
      secret_hash TEXT NOT NULL,
      credential_epoch INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      redeemed_at INTEGER,
      redemption_hash TEXT
    )`,
    `CREATE TABLE account_owner_links (
      id TEXT PRIMARY KEY,
      secret_hash TEXT NOT NULL,
      credential_epoch INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    )`,
  ],
};
