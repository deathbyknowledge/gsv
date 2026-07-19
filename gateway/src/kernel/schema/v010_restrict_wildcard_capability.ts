import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V010_RESTRICT_WILDCARD_CAPABILITY: SqlMigration = {
  id: 10,
  name: "restrict_wildcard_capability",
  statements: [
    `
      DELETE FROM group_capabilities
      WHERE gid <> 0 AND capability = '*'
    `,
  ],
};
