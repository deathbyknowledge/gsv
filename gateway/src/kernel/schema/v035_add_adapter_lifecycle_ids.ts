import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V035_ADD_ADAPTER_LIFECYCLE_IDS: SqlMigration = {
  id: 35,
  name: "add_adapter_lifecycle_ids",
  statements: [
    `
      ALTER TABLE adapter_status ADD COLUMN lifecycle_id TEXT
    `,
    `
      ALTER TABLE adapter_status ADD COLUMN ready_owner_uid INTEGER
    `,
    `
      UPDATE adapter_status
      SET lifecycle_id = 'adapter-account:' || LOWER(HEX(randomblob(16)))
      WHERE lifecycle_id IS NULL
    `,
    `
      UPDATE adapter_status
      SET ready_owner_uid = owner_uid
      WHERE connected = 1
        AND authenticated = 1
        AND owner_uid >= 1000
        AND NOT EXISTS (
          SELECT 1
          FROM personal_agents
          WHERE personal_agents.agent_uid = adapter_status.owner_uid
        )
    `,
    `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_adapter_status_lifecycle_id
      ON adapter_status(lifecycle_id)
    `,
  ],
};
