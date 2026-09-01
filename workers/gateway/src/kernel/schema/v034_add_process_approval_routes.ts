import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V034_ADD_PROCESS_APPROVAL_ROUTES: SqlMigration = {
  id: 34,
  name: "add_process_approval_routes",
  statements: [
    `
      CREATE TABLE process_approval_routes (
        process_id TEXT PRIMARY KEY,
        uid INTEGER NOT NULL,
        route_kind TEXT NOT NULL CHECK (route_kind IN ('connection', 'adapter')),
        connection_id TEXT,
        adapter TEXT,
        account_id TEXT,
        actor_id TEXT,
        surface_kind TEXT,
        surface_id TEXT,
        thread_id TEXT,
        reply_to_id TEXT,
        route_generation TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        CHECK (
          (route_kind = 'connection'
            AND connection_id IS NOT NULL
            AND adapter IS NULL
            AND account_id IS NULL
            AND actor_id IS NULL
            AND surface_kind IS NULL
            AND surface_id IS NULL)
          OR
          (route_kind = 'adapter'
            AND connection_id IS NULL
            AND adapter IS NOT NULL
            AND account_id IS NOT NULL
            AND actor_id IS NOT NULL
            AND surface_kind IS NOT NULL
            AND surface_id IS NOT NULL)
        )
      )
    `,
    `
      CREATE INDEX process_approval_routes_expiry_idx
      ON process_approval_routes (expires_at)
    `,
  ],
};
