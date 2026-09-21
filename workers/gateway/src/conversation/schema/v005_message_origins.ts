import type { SqlMigration } from "../../schema/runner";

export const CONVERSATION_V005_MESSAGE_ORIGINS: SqlMigration = {
  id: 5,
  name: "message_origins",
  statements: [
    "ALTER TABLE messages ADD COLUMN social_json TEXT",
    `CREATE TABLE message_origins (
      ship_id TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      origin_message_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      message_id TEXT NOT NULL UNIQUE,
      sequence INTEGER NOT NULL UNIQUE,
      PRIMARY KEY (ship_id, subject_id, origin_message_id, thread_id)
    )`,
  ],
};
