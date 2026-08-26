import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V023_ADD_PERSONAL_CONTROLLER_SLOT: SqlMigration = {
  id: 23,
  name: "add_personal_controller_slot",
  statements: [
    `ALTER TABLE processes
       ADD COLUMN is_personal_controller INTEGER NOT NULL DEFAULT 0
       CHECK (is_personal_controller IN (0, 1))`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_processes_personal_controller_owner
       ON processes(owner_uid)
       WHERE is_personal_controller = 1`,
  ],
};
