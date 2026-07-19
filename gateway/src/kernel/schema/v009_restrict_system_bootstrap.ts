import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V009_RESTRICT_SYSTEM_BOOTSTRAP: SqlMigration = {
  id: 9,
  name: "restrict_system_bootstrap",
  statements: [
    `
      DELETE FROM group_capabilities
      WHERE gid = 100 AND capability = 'sys.bootstrap'
    `,
  ],
};
