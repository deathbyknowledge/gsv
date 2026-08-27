import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V035_ADD_ADAPTER_LIFECYCLE_IDS: SqlMigration = {
  id: 35,
  name: "add_adapter_lifecycle_ids",
  statements: [
    `
      ALTER TABLE adapter_status ADD COLUMN lifecycle_id TEXT
    `,
    `
      UPDATE adapter_status
      SET lifecycle_id = 'adapter-account:' || LOWER(HEX(randomblob(16)))
      WHERE lifecycle_id IS NULL
    `,
    `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_adapter_status_lifecycle_id
      ON adapter_status(lifecycle_id)
    `,
  ],
};
