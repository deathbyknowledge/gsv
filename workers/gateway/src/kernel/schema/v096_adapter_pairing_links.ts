import type { SqlMigration } from "../../schema/runner";

/**
 * A messenger link carries a single-use code the Kernel minted for one owner. Only the
 * code's hash is kept, with that owner and their credential epoch, so a password change
 * retires the codes they made before it.
 */
export const KERNEL_V096_ADAPTER_PAIRING_LINKS: SqlMigration = {
  id: 96,
  name: "adapter_pairing_links",
  statements: [
    `
      CREATE TABLE adapter_pairing_links (
        code_hash TEXT PRIMARY KEY,
        adapter TEXT NOT NULL,
        owner_uid INTEGER NOT NULL,
        credential_epoch INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        cancelled_at INTEGER,
        redeemed_at INTEGER
      )
    `,
    "CREATE INDEX adapter_pairing_links_owner ON adapter_pairing_links (owner_uid, adapter, created_at)",
  ],
};
