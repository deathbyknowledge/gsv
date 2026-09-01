import type { SqlMigration } from "../../schema/runner";

export const PROCESS_V003_MESSAGE_METADATA: SqlMigration = {
  id: 3,
  name: "add_message_metadata",
  statements: [
    `
      ALTER TABLE messages
      ADD COLUMN metadata_json TEXT
    `,
  ],
};
