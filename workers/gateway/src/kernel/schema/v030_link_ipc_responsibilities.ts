import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V030_LINK_IPC_RESPONSIBILITIES: SqlMigration = {
  id: 30,
  name: "link_ipc_responsibilities",
  statements: [
    `
      ALTER TABLE ipc_calls ADD COLUMN responsibility_id TEXT
    `,
  ],
};
