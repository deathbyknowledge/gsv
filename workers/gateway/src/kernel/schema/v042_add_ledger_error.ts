import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V042_ADD_LEDGER_ERROR: SqlMigration = {
  id: 42,
  name: "add_ledger_error",
  statements: ["ALTER TABLE ledger_window ADD COLUMN error TEXT"],
};
