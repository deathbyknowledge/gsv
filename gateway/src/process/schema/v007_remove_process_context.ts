import type { SqlMigration } from "../../schema/runner";

export const PROCESS_V007_REMOVE_PROCESS_CONTEXT: SqlMigration = {
  id: 7,
  name: "remove_process_context",
  statements: [
    `
      DELETE FROM process_kv WHERE key = 'processContextFiles'
    `,
  ],
};
