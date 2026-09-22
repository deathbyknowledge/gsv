import type { SqlMigration } from "../../schema/runner";

export const CONVERSATION_V006_TEXT_SEARCH: SqlMigration = {
  id: 6,
  name: "conversation_text_search",
  statements: [
    `CREATE VIRTUAL TABLE message_search USING fts5(message_id UNINDEXED, text, created_at UNINDEXED, tokenize = 'unicode61')`,
    `CREATE TABLE message_search_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      backfill_before INTEGER NOT NULL,
      indexed_messages INTEGER NOT NULL DEFAULT 0,
      indexed_bytes INTEGER NOT NULL DEFAULT 0,
      truncated_messages INTEGER NOT NULL DEFAULT 0,
      omitted_messages INTEGER NOT NULL DEFAULT 0,
      capacity_reached INTEGER NOT NULL DEFAULT 0,
      backfill_failed INTEGER NOT NULL DEFAULT 0
    )`,
    `INSERT INTO message_search_state (id, backfill_before)
      SELECT 1, MAX(COALESCE((SELECT MAX(sequence) FROM messages), 0),
        COALESCE((SELECT MAX(to_sequence) FROM archive_segments), 0)) + 1`,
  ],
};
