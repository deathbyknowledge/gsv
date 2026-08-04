import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V022_ADD_MANAGED_TELEGRAM_LINKS: SqlMigration = {
  id: 22,
  name: "add_managed_telegram_links",
  statements: [
    `
      CREATE TABLE IF NOT EXISTS managed_telegram_link_operations (
        operation_id TEXT PRIMARY KEY,
        action       TEXT NOT NULL CHECK (action IN ('link', 'unlink')),
        principal_id TEXT,
        actor_id     TEXT NOT NULL,
        surface_id   TEXT NOT NULL,
        local_uid    INTEGER NOT NULL,
        result_removed INTEGER CHECK (result_removed IN (0, 1)),
        created_at   INTEGER NOT NULL,
        CHECK (
          (action = 'link' AND principal_id IS NOT NULL AND result_removed IS NULL)
          OR (action = 'unlink' AND principal_id IS NULL AND result_removed IS NOT NULL)
        )
      )
    `,
    `
      CREATE INDEX IF NOT EXISTS managed_telegram_link_actor_idx
      ON managed_telegram_link_operations (actor_id, created_at)
    `,
  ],
};
