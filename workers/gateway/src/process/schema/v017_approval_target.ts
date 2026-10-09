import type { SqlMigration } from "../../schema/runner";

export const PROCESS_V017_APPROVAL_TARGET: SqlMigration = {
  id: 17,
  name: "approval_target",
  statements: ["ALTER TABLE pending_hil ADD COLUMN approved_target_json TEXT"],
};
