import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V066_BROWSER_HANDOFF_LINKS: SqlMigration = {
  id: 66,
  name: "browser_handoff_links",
  statements: [
    `CREATE TABLE browser_handoff_links (
      owner_uid INTEGER NOT NULL, instance_id TEXT NOT NULL, request_id TEXT NOT NULL,
      responsibility_id TEXT NOT NULL, retry_at INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0, diagnostic_ref TEXT, last_error TEXT,
      PRIMARY KEY(owner_uid, instance_id, request_id)
    )`,
  ],
};
