import type { SqlMigration } from "../../schema/runner";

export const PROCESS_V005_TOOL_RESULT_OUTCOME: SqlMigration = {
  id: 5,
  name: "add_tool_result_outcome",
  statements: [
    `
      ALTER TABLE pending_tool_calls
      ADD COLUMN outcome TEXT
    `,
    `
      UPDATE pending_tool_calls
      SET outcome = CASE
        WHEN status = 'completed'
          AND CASE
            WHEN json_valid(result_json) THEN json_extract(result_json, '$.status')
            ELSE NULL
          END = 'failed'
          THEN 'failed'
        WHEN status = 'completed' THEN 'completed'
        WHEN status = 'error' AND error = 'Tool execution denied by user' THEN 'denied'
        WHEN status = 'error' THEN 'failed'
        ELSE NULL
      END
      WHERE status IN ('completed', 'error')
    `,
  ],
};
