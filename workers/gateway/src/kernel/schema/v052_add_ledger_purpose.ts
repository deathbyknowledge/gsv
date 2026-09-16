import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V052_ADD_LEDGER_PURPOSE: SqlMigration = {
  id: 52,
  name: "add_ledger_purpose",
  statements: ["ALTER TABLE ledger_window ADD COLUMN purpose TEXT"],
};
