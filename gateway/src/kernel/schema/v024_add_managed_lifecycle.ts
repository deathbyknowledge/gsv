import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V024_ADD_MANAGED_LIFECYCLE: SqlMigration = {
  id: 24,
  name: "add_managed_lifecycle",
  statements: [
    `
      CREATE TABLE IF NOT EXISTS managed_installation_lifecycle (
        record_id          INTEGER PRIMARY KEY CHECK (record_id = 1),
        installation_id    TEXT NOT NULL UNIQUE,
        state              TEXT NOT NULL CHECK (state = 'deleting'),
        operation_id       TEXT NOT NULL,
        recoverable_until  INTEGER NOT NULL,
        created_at         INTEGER NOT NULL
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS managed_resource_lifecycle (
        operation_id  TEXT NOT NULL,
        resource_kind TEXT NOT NULL CHECK (
          resource_kind IN ('process_suspended', 'repository_deleted')
        ),
        resource_id   TEXT NOT NULL,
        completed_at  INTEGER NOT NULL,
        PRIMARY KEY (operation_id, resource_kind, resource_id)
      )
    `,
  ],
};
