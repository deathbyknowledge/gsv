import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V025_ADD_PRIVATE_ADAPTER_DESTINATIONS: SqlMigration = {
  id: 25,
  name: "add_private_adapter_destinations",
  statements: [
    `
      CREATE TABLE private_adapter_destinations (
        uid        INTEGER PRIMARY KEY,
        adapter    TEXT NOT NULL,
        account_id TEXT NOT NULL,
        actor_id   TEXT NOT NULL,
        surface_id TEXT NOT NULL,
        thread_id  TEXT NOT NULL DEFAULT '',
        message_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `,
  ],
};
