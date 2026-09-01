import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V036_SUPERVISE_DELEGATED_IPC_CALLS: SqlMigration = {
  id: 36,
  name: "supervise_delegated_ipc_calls",
  statements: [
    `
      ALTER TABLE ipc_calls
      ADD COLUMN supervised INTEGER NOT NULL DEFAULT 0
      CHECK (supervised IN (0, 1))
    `,
    `
      UPDATE ipc_calls
      SET supervised = 1
      WHERE status = 'pending'
        AND EXISTS (
          SELECT 1
          FROM cf_agents_schedules AS task
          WHERE task.callback = 'onIpcCallTimeout'
            AND task.owner_path_key IS NULL
            AND json_extract(task.payload, '$.callId') = ipc_calls.call_id
            AND json_extract(task.payload, '$.terminateTargetOnTimeout') = 1
        )
    `,
  ],
};
