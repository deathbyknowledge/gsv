import type { SqlMigration } from "../../schema/runner";

export const CONVERSATION_V007_MESSAGE_ACTION: SqlMigration = {
  id: 7,
  name: "message_action",
  statements: ["ALTER TABLE messages ADD COLUMN action_json TEXT"],
};
