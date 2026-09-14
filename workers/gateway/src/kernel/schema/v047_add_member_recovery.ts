import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V047_ADD_MEMBER_RECOVERY: SqlMigration = {
  id: 47,
  name: "add_member_recovery",
  statements: [
    `CREATE TABLE member_recovery_claims (
      id TEXT PRIMARY KEY,
      uid INTEGER NOT NULL,
      proof_hash TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      credential_epoch INTEGER NOT NULL,
      adapter TEXT NOT NULL,
      account_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      surface_id TEXT NOT NULL,
      route_generation TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      failed_attempts INTEGER NOT NULL DEFAULT 0,
      redeemed_at INTEGER,
      redemption_hash TEXT
    )`,
    `CREATE INDEX member_recovery_claims_uid ON member_recovery_claims(uid, created_at)`,
  ],
};
