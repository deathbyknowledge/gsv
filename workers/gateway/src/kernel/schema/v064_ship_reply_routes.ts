import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V064_SHIP_REPLY_ROUTES: SqlMigration = {
  id: 64,
  name: "ship_reply_routes",
  statements: [
    "ALTER TABLE run_routes ADD COLUMN follows_ship INTEGER NOT NULL DEFAULT 0 CHECK (follows_ship IN (0, 1))",
    `CREATE TABLE message_reply_routes (
      message_id TEXT PRIMARY KEY,
      route_json TEXT,
      expires_at INTEGER NOT NULL
    )`,
    "CREATE INDEX message_reply_routes_expiry ON message_reply_routes (expires_at)",
  ],
};
