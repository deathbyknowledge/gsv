import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V045_ADD_HUMAN_INVITATIONS: SqlMigration = {
  id: 45,
  name: "add_human_invitations",
  statements: [
    `CREATE TABLE human_invitations (
      id TEXT PRIMARY KEY,
      purpose TEXT NOT NULL CHECK (purpose = 'human-account'),
      issuer_uid INTEGER NOT NULL,
      issuer_epoch INTEGER NOT NULL,
      username TEXT NOT NULL,
      secret_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      cancelled_at INTEGER,
      redeemed_at INTEGER,
      redemption_hash TEXT,
      enrolled_uid INTEGER
    )`,
    `CREATE INDEX human_invitations_pending ON human_invitations(issuer_uid, expires_at)
      WHERE redeemed_at IS NULL AND cancelled_at IS NULL`,
  ],
};
