import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V071_SHIP_EVENTS: SqlMigration = {
  id: 71,
  name: "ship_events",
  statements: [
    `
      CREATE TABLE ship_events (
        event_id TEXT PRIMARY KEY,
        owner_uid INTEGER NOT NULL,
        event_json TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        next_attempt_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `,
    "CREATE INDEX ship_events_owner_order ON ship_events (owner_uid, created_at, event_id)",
  ],
};
