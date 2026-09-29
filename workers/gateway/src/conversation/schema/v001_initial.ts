import type { SqlMigration } from "../../schema/runner";

export const CONVERSATION_V001_INITIAL_SCHEMA: SqlMigration = {
  id: 1,
  name: "initial_conversation_schema",
  statements: [
    `
      CREATE TABLE conversation_meta (
        conversation_id TEXT PRIMARY KEY,
        owner_uid INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('home', 'work', 'group')),
        created_at INTEGER NOT NULL
      )
    `,
    `
      CREATE TABLE messages (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL UNIQUE,
        idempotency_key TEXT NOT NULL UNIQUE,
        author_json TEXT NOT NULL,
        text TEXT NOT NULL,
        media_json TEXT,
        origin_json TEXT NOT NULL,
        process_id TEXT,
        run_id TEXT,
        created_at INTEGER NOT NULL
      )
    `,
    `
      CREATE TABLE message_receipts (
        idempotency_key TEXT PRIMARY KEY,
        message_id TEXT NOT NULL UNIQUE,
        sequence INTEGER NOT NULL UNIQUE,
        payload_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `,
    `
      CREATE INDEX messages_created_at_idx
      ON messages (created_at)
    `,
    `
      CREATE TABLE archive_segments (
        segment_id TEXT PRIMARY KEY,
        from_sequence INTEGER NOT NULL,
        to_sequence INTEGER NOT NULL,
        message_count INTEGER NOT NULL,
        object_key TEXT NOT NULL UNIQUE,
        checksum TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `,
    `
      CREATE UNIQUE INDEX archive_segments_range_idx
      ON archive_segments (from_sequence, to_sequence)
    `,
  ],
};
