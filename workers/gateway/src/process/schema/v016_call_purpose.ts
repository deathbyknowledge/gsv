import type { SqlMigration } from "../../schema/runner";

export const PROCESS_V016_CALL_PURPOSE: SqlMigration = {
  id: 16,
  name: "call_purpose",
  statements: [
    "ALTER TABLE pending_tool_calls ADD COLUMN purpose TEXT",
    "ALTER TABLE pending_hil ADD COLUMN purpose TEXT",
  ],
};
