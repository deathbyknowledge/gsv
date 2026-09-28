import type { SqlMigration } from "../../schema/runner";

export const CONVERSATION_V005_SEARCH: SqlMigration = {
  id: 5,
  name: "index_conversation_text",
  statements: [
    "CREATE VIRTUAL TABLE message_search USING fts5(text, content='')",
  ],
};
