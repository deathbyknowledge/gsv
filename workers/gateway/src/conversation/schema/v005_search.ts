import type { SqlMigration } from "../../schema/runner";

export const CONVERSATION_V005_SEARCH: SqlMigration = {
  id: 5,
  name: "index_conversation_text",
  statements: [
    `CREATE VIRTUAL TABLE message_search USING fts5(
      text, message_id UNINDEXED, author_json UNINDEXED, created_at UNINDEXED
    )`,
    `INSERT INTO message_search (rowid, text, message_id, author_json, created_at)
     SELECT sequence, text, message_id, author_json, created_at FROM messages`,
    "ALTER TABLE archive_segments ADD COLUMN search_indexed INTEGER NOT NULL DEFAULT 0",
    "CREATE INDEX archive_search_pending_idx ON archive_segments (search_indexed, from_sequence)",
  ],
};
