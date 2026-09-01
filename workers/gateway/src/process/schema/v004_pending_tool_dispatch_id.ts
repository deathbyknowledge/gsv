import type { SqlMigration } from "../../schema/runner";

export const PROCESS_V004_PENDING_TOOL_DISPATCH_ID: SqlMigration = {
  id: 4,
  name: "rebuild_pending_tool_dispatch_state",
  statements: [
    `
      CREATE TABLE pending_tool_calls_v4 (
        dispatch_id TEXT PRIMARY KEY,
        id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL DEFAULT 'default',
        call TEXT NOT NULL,
        args_json TEXT NOT NULL,
        result_json TEXT,
        error TEXT,
        status TEXT NOT NULL DEFAULT 'registered',
        created_at INTEGER NOT NULL
      )
    `,
    `
      INSERT INTO pending_tool_calls_v4 (
        dispatch_id, id, run_id, conversation_id, call, args_json,
        result_json, error, status, created_at
      )
      SELECT
        id, id, run_id, conversation_id, call, args_json,
        result_json,
        CASE
          WHEN status = 'pending' THEN 'Tool execution interrupted by the 0.4 upgrade'
          ELSE error
        END,
        CASE WHEN status = 'pending' THEN 'error' ELSE status END,
        created_at
      FROM pending_tool_calls
    `,
    `
      DROP TABLE pending_tool_calls
    `,
    `
      ALTER TABLE pending_tool_calls_v4 RENAME TO pending_tool_calls
    `,
    `
      DELETE FROM pending_hil
      WHERE EXISTS (
        SELECT 1
        FROM pending_tool_calls AS outer_call
        WHERE outer_call.run_id = pending_hil.run_id
          AND outer_call.call = 'codemode.exec'
          AND outer_call.status = 'error'
          AND outer_call.error = 'Tool execution interrupted by the 0.4 upgrade'
      )
    `,
    `
      INSERT INTO pending_tool_calls (
        dispatch_id, id, run_id, conversation_id, call, args_json,
        error, status, created_at
      )
      SELECT
        'upgrade-hil:' || request_id,
        tool_call_id,
        run_id,
        conversation_id,
        syscall,
        args_json,
        'Tool approval interrupted by the 0.4 upgrade',
        'error',
        created_at
      FROM pending_hil
    `,
    `
      INSERT INTO pending_tool_calls (
        dispatch_id, id, run_id, conversation_id, call, args_json,
        error, status, created_at
      )
      SELECT
        'upgrade-hil:' || pending_hil.request_id || ':' || remaining.key,
        json_extract(remaining.value, '$.id'),
        pending_hil.run_id,
        pending_hil.conversation_id,
        json_extract(remaining.value, '$.name'),
        json_extract(remaining.value, '$.arguments'),
        'Tool approval interrupted by the 0.4 upgrade',
        'error',
        pending_hil.created_at + CAST(remaining.key AS INTEGER) + 1
      FROM pending_hil, json_each(pending_hil.remaining_tool_calls_json) AS remaining
    `,
    `
      DELETE FROM pending_hil
    `,
    `
      ALTER TABLE pending_hil DROP COLUMN remaining_tool_calls_json
    `,
    `
      ALTER TABLE pending_hil DROP COLUMN generation
    `,
  ],
};
