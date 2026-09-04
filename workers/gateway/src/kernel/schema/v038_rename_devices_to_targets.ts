import type { SqlMigration } from "../../schema/runner";

/** Storage follows the protocol 4 vocabulary: registered peers are targets and routes bind to peer connections. */
export const KERNEL_V038_RENAME_DEVICES_TO_TARGETS: SqlMigration = {
  id: 38,
  name: "rename_devices_to_targets",
  statements: [
    `ALTER TABLE devices RENAME TO targets`,
    `ALTER TABLE targets RENAME COLUMN device_id TO target_id`,
    `ALTER TABLE device_access RENAME TO target_access`,
    `ALTER TABLE target_access RENAME COLUMN device_id TO target_id`,
    `ALTER TABLE routing_table RENAME COLUMN device_id TO target_id`,
    `ALTER TABLE routing_table RENAME COLUMN driver_connection_id TO peer_connection_id`,
    `ALTER TABLE shell_sessions RENAME COLUMN device_id TO target_id`,
    `DROP INDEX IF EXISTS shell_sessions_device_idx`,
    `CREATE INDEX IF NOT EXISTS shell_sessions_target_idx ON shell_sessions (target_id)`,
  ],
};
