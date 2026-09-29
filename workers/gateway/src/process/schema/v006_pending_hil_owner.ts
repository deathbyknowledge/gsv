import type { SqlMigration } from "../../schema/runner";

export const PROCESS_V006_PENDING_HIL_OWNER: SqlMigration = {
  id: 6,
  name: "add_pending_hil_owner",
  statements: [
    `
      ALTER TABLE pending_hil
      ADD COLUMN owner_dispatch_id TEXT
    `,
    `
      UPDATE pending_hil
      SET owner_dispatch_id = (
        SELECT outer_call.dispatch_id
        FROM pending_tool_calls AS outer_call
        WHERE outer_call.run_id = pending_hil.run_id
          AND outer_call.call = 'codemode.exec'
          AND outer_call.status = 'pending'
        LIMIT 1
      )
      WHERE NOT EXISTS (
        SELECT 1
        FROM pending_tool_calls AS direct_call
        WHERE direct_call.run_id = pending_hil.run_id
          AND direct_call.id = pending_hil.tool_call_id
          AND direct_call.status = 'registered'
      )
        AND 1 = (
          SELECT COUNT(*)
          FROM pending_tool_calls AS outer_call
          WHERE outer_call.run_id = pending_hil.run_id
            AND outer_call.call = 'codemode.exec'
            AND outer_call.status = 'pending'
        )
    `,
    `
      UPDATE pending_tool_calls
      SET status = 'error',
          error = 'CodeMode approval interrupted while upgrading approval ownership',
          outcome = 'failed'
      WHERE call = 'codemode.exec'
        AND status = 'pending'
        AND EXISTS (
          SELECT 1
          FROM pending_hil
          WHERE pending_hil.run_id = pending_tool_calls.run_id
            AND pending_hil.owner_dispatch_id IS NULL
            AND NOT EXISTS (
              SELECT 1
              FROM pending_tool_calls AS direct_call
              WHERE direct_call.run_id = pending_hil.run_id
                AND direct_call.id = pending_hil.tool_call_id
                AND direct_call.status = 'registered'
            )
        )
    `,
    `
      DELETE FROM pending_hil
      WHERE owner_dispatch_id IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM pending_tool_calls AS direct_call
          WHERE direct_call.run_id = pending_hil.run_id
            AND direct_call.id = pending_hil.tool_call_id
            AND direct_call.status = 'registered'
        )
    `,
  ],
};
