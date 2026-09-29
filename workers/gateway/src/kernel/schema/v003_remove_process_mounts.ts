import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V003_REMOVE_PROCESS_MOUNTS: SqlMigration = {
  id: 3,
  name: "remove_process_mounts",
  statements: [
    `
      ALTER TABLE processes DROP COLUMN mounts
    `,
  ],
};
