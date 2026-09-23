import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V072_SHIP_ATTENTION: SqlMigration = {
  id: 72,
  name: "ship_attention",
  statements: [
    "DROP TABLE process_scope_inbox",
    "DROP TABLE process_scope_automation",
    "ALTER TABLE federation_contacts ADD COLUMN ship_attention INTEGER NOT NULL DEFAULT 0 CHECK (ship_attention IN (0, 1))",
  ],
};
