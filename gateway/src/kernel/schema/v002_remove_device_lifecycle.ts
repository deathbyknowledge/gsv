import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V002_REMOVE_DEVICE_LIFECYCLE: SqlMigration = {
  id: 2,
  name: "remove_device_lifecycle",
  statements: [
    `
      DELETE FROM routing_table
      WHERE device_id IN (
        SELECT device_id FROM devices WHERE lifecycle = 'ephemeral'
      )
    `,
    `
      DELETE FROM shell_sessions
      WHERE device_id IN (
        SELECT device_id FROM devices WHERE lifecycle = 'ephemeral'
      )
    `,
    `
      DELETE FROM device_access
      WHERE device_id IN (
        SELECT device_id FROM devices WHERE lifecycle = 'ephemeral'
      )
    `,
    `
      DELETE FROM devices
      WHERE lifecycle = 'ephemeral'
    `,
    `
      ALTER TABLE devices DROP COLUMN lifecycle
    `,
  ],
};
