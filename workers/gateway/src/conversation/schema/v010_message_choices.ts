import type { SqlMigration } from "../../schema/runner";

export const CONVERSATION_V010_MESSAGE_CHOICES: SqlMigration = {
  id: 10,
  name: "message_choices",
  statements: ["ALTER TABLE messages ADD COLUMN choices_json TEXT"],
};
