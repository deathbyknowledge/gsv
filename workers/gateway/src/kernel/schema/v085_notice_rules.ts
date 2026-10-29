import type { SqlMigration } from "../../schema/runner";

/**
 * An owner's changes to where each kind of notice goes. A kind without a row
 * keeps its default, so this holds only what someone changed.
 */
export const KERNEL_V085_NOTICE_RULES: SqlMigration = {
  id: 85,
  name: "notice_rules",
  statements: [
    `
      CREATE TABLE notice_rules (
        owner_uid INTEGER NOT NULL,
        kind TEXT NOT NULL,
        notify TEXT NOT NULL CHECK (notify IN ('none', 'messenger')),
        changed_by TEXT NOT NULL CHECK (changed_by IN ('person', 'ship')),
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (owner_uid, kind)
      )
    `,
  ],
};
