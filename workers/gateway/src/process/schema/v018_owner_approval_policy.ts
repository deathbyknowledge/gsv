import type { SqlMigration } from "../../schema/runner";

export const PROCESS_V018_DROP_TOOL_APPROVAL_OVERRIDES: SqlMigration = {
  id: 18,
  name: "drop_tool_approval_overrides",
  statements: ["DELETE FROM process_kv WHERE key = 'toolApprovalOverrides'"],
};
