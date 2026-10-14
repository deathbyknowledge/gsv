import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V068_RETAIN_IPC_RUN_STATUS: SqlMigration = {
  id: 68,
  name: "retain_ipc_run_status",
  statements: [
    "ALTER TABLE ipc_calls ADD COLUMN run_status TEXT CHECK (run_status IN ('ok', 'error', 'aborted'))",
    `UPDATE ipc_calls SET run_status = 'aborted'
      WHERE status = 'completed'
        AND (error = 'Target run was aborted' OR error GLOB 'Target run was aborted: *')`,
  ],
};
