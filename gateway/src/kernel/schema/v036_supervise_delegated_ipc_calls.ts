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
  ],
};
