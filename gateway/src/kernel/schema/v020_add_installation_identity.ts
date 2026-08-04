import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V020_ADD_INSTALLATION_IDENTITY: SqlMigration = {
  id: 20,
  name: "add_installation_identity",
  statements: [
    `
      CREATE TABLE IF NOT EXISTS installation_identity (
        record_id        INTEGER PRIMARY KEY CHECK (record_id = 1),
        installation_id  TEXT    NOT NULL UNIQUE,
        handle           TEXT,
        canonical_origin TEXT,
        CHECK ((handle IS NULL) = (canonical_origin IS NULL))
      )
    `,
  ],
};
