import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V006_ADD_IPC_DELIVERY_STATE: SqlMigration = {
  id: 6,
  name: "add_ipc_delivery_state",
  statements: [
    `
      ALTER TABLE ipc_calls ADD COLUMN source_run_id TEXT
    `,
    `
      ALTER TABLE ipc_calls ADD COLUMN delivery_started_at INTEGER
    `,
    `
      DELETE FROM ipc_calls
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_ipc_calls_source_run
      ON ipc_calls(uid, source_pid, source_run_id)
    `,
  ],
};
