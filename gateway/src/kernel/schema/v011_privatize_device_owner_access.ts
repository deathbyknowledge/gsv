import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V011_PRIVATIZE_DEVICE_OWNER_ACCESS: SqlMigration = {
  id: 11,
  name: "privatize_device_owner_access",
  statements: [
    `
      INSERT OR IGNORE INTO device_access (device_id, gid)
      SELECT device_id, owner_uid
      FROM devices
      WHERE owner_uid >= 1000
    `,
    `
      DELETE FROM device_access
      WHERE gid = 100
        AND device_id IN (
          SELECT device_id
          FROM devices
          WHERE owner_uid >= 1000
        )
    `,
  ],
};
