import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V070_CONTACT_DRAFTS: SqlMigration = {
  id: 70, name: "contact_drafts",
  statements: [
    `CREATE TABLE social_drafts (
      id TEXT PRIMARY KEY, owner_uid INTEGER NOT NULL, contact_id TEXT NOT NULL,
      intent_id TEXT NOT NULL, fingerprint TEXT NOT NULL, process_id TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1, state TEXT NOT NULL DEFAULT 'review',
      content_json TEXT NOT NULL, result_json TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      UNIQUE (owner_uid, intent_id)
    )`,
    "CREATE INDEX social_drafts_owner_contact ON social_drafts (owner_uid, contact_id, id)",
    "CREATE INDEX social_drafts_expiry ON social_drafts (expires_at)",
  ],
};
