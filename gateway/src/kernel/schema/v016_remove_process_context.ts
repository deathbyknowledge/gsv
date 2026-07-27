import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V016_REMOVE_PROCESS_CONTEXT: SqlMigration = {
  id: 16,
  name: "remove_process_context",
  statements: [
    `
      ALTER TABLE processes DROP COLUMN context_files_json
    `,
  ],
};
