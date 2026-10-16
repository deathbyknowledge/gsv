import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V070_SITES: SqlMigration = {
  id: 70,
  name: "sites",
  statements: [
    `CREATE TABLE sites (
      id TEXT PRIMARY KEY,
      owner_uid INTEGER NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      origin TEXT,
      created_at INTEGER NOT NULL
    )`,
    "CREATE INDEX sites_owner ON sites (owner_uid)",
  ],
};
