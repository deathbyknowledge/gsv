import type { SqlMigration } from "../../schema/runner";

/**
 * Bind durable executions to the package profile security surface that
 * authorized their creation. Null is retained only for non-package and legacy
 * rows; package runtime authorization treats a missing revision as invalid.
 */
export const KERNEL_V020_BIND_PACKAGE_SECURITY_REVISIONS: SqlMigration = {
  id: 20,
  name: "bind_package_security_revisions",
  statements: [
    `
      ALTER TABLE processes
      ADD COLUMN package_security_revision TEXT
    `,
    `
      ALTER TABLE schedules
      ADD COLUMN package_security_revision TEXT
    `,
  ],
};
