import type { SqlMigration } from "../../schema/runner";

export const CONVERSATION_V004_SELECTED_TARGET: SqlMigration = {
  id: 4,
  name: "selected_target",
  statements: ["ALTER TABLE messages ADD COLUMN selected_target TEXT"],
};
