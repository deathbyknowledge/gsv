import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V024_ADD_SURFACE_ROUTE_MODES: SqlMigration = {
  id: 24,
  name: "add_surface_route_modes",
  statements: [
    `
      ALTER TABLE surface_routes
        ADD COLUMN route_mode TEXT NOT NULL DEFAULT 'legacy'
          CHECK (route_mode IN ('legacy', 'work', 'surface'))
    `,
    `
      UPDATE surface_routes
      SET route_mode = 'surface'
      WHERE surface_kind != 'dm'
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_surface_routes_mode_pid
      ON surface_routes(route_mode, pid)
    `,
  ],
};
