import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V031_ADD_RESPONSIBILITY_SOURCE_POLICIES: SqlMigration = {
  id: 31,
  name: "add_responsibility_source_policies",
  statements: [
    `
      CREATE TABLE responsibility_source_policies (
        owner_uid INTEGER NOT NULL,
        source_id TEXT NOT NULL,
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (owner_uid, source_id)
      )
    `,
  ],
};
