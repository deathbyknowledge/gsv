import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V010_SCOPE_ADAPTER_DESTINATIONS: SqlMigration = {
  id: 10,
  name: "scope_adapter_destinations",
  statements: [
    // Legacy rows did not identify the linked actor and used a globally unique
    // surface key, so they cannot be migrated without granting guessed access.
    `
      DROP TABLE surface_routes
    `,
    `
      CREATE TABLE surface_routes (
        adapter        TEXT NOT NULL,
        account_id     TEXT NOT NULL,
        actor_id       TEXT NOT NULL,
        surface_kind   TEXT NOT NULL,
        surface_id     TEXT NOT NULL,
        thread_id      TEXT NOT NULL DEFAULT '',
        uid            INTEGER NOT NULL,
        pid            TEXT NOT NULL,
        updated_at     INTEGER NOT NULL,
        updated_by_uid INTEGER NOT NULL,
        PRIMARY KEY (adapter, account_id, actor_id, surface_kind, surface_id, thread_id)
      )
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_surface_routes_uid
      ON surface_routes(uid)
    `,
    `
      ALTER TABLE run_routes ADD COLUMN reply_to_id TEXT
    `,
  ],
};
