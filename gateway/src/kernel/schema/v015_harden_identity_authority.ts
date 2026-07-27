import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V015_HARDEN_IDENTITY_AUTHORITY: SqlMigration = {
  id: 15,
  name: "harden_identity_authority",
  statements: [
    "DELETE FROM group_capabilities WHERE gid = 100 AND capability = 'sys.bootstrap'",
    "DELETE FROM group_capabilities WHERE gid <> 0 AND capability = '*'",
    `
      CREATE TABLE IF NOT EXISTS identity_id_allocator (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        next_id   INTEGER NOT NULL CHECK (next_id >= 1000)
      )
    `,
    `
      INSERT INTO identity_id_allocator (singleton, next_id)
      SELECT 1, MAX(1000, COALESCE(MAX(id), 999) + 1)
      FROM (
        SELECT uid AS id FROM passwd
        UNION ALL
        SELECT gid AS id FROM passwd
        UNION ALL
        SELECT gid AS id FROM groups
      )
    `,
  ],
};
