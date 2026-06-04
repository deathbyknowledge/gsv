import type { SqlMigration } from "../../schema/runner";

export const PROCESS_V002_MESSAGE_RUN_ID: SqlMigration = {
  id: 2,
  name: "add_message_run_id",
  statements: [
    `
      ALTER TABLE messages
      ADD COLUMN run_id TEXT
    `,
    `
      CREATE INDEX IF NOT EXISTS messages_run_id_idx
      ON messages (run_id)
    `,
  ],
};
