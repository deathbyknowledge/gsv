import type { SqlMigration } from "./runner";

export const INFERENCE_V002_ADD_MANAGED_LIFECYCLE: SqlMigration = {
  id: 2,
  name: "add_managed_inference_lifecycle",
  statements: [
    `
      CREATE TABLE managed_inference_lifecycle (
        record_id          INTEGER PRIMARY KEY CHECK (record_id = 1),
        installation_id    TEXT NOT NULL UNIQUE,
        operation_id       TEXT NOT NULL,
        recoverable_until  INTEGER NOT NULL,
        created_at         INTEGER NOT NULL
      )
    `,
  ],
};
