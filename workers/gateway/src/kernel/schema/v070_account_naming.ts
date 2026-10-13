import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V070_ACCOUNT_NAMING: SqlMigration = {
  id: 70,
  name: "account_naming",
  statements: [
    "INSERT OR IGNORE INTO group_capabilities (gid, capability) SELECT gid, 'account.update' FROM group_capabilities WHERE gid = 100 AND capability = 'account.list'",
  ],
};
