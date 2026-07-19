import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V013_ADD_UNIX_ID_ALLOCATOR: SqlMigration = {
  id: 13,
  name: "add_unix_id_allocator",
  statements: [
    `
      CREATE TABLE IF NOT EXISTS unix_id_allocator (
        singleton  INTEGER PRIMARY KEY CHECK (singleton = 1),
        high_water INTEGER NOT NULL CHECK (high_water >= 0)
      )
    `,
    `
      INSERT OR IGNORE INTO unix_id_allocator (singleton, high_water)
      SELECT 1, MAX(
        COALESCE((SELECT MAX(uid) FROM passwd), 0),
        COALESCE((SELECT MAX(gid) FROM passwd), 0),
        COALESCE((SELECT MAX(gid) FROM groups), 0)
      )
    `,
  ],
};
