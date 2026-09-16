import type { SqlMigration } from "../../schema/runner";

export const PROCESS_V016_PENDING_HIL_REASON: SqlMigration = {
  id: 16,
  name: "pending_hil_reason",
  statements: [
    "ALTER TABLE pending_hil ADD COLUMN reason TEXT",
  ],
};
