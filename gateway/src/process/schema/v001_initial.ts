import type { SqlMigration } from "../../kernel/schema/runner";

// Current Process Durable Object SQLite schema for fresh v1 installations.
export const PROCESS_V001_INITIAL_SCHEMA: SqlMigration = {
  id: 1,
  name: "initial_process_schema",
  statements: [
    `
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        generation INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'open',
        title TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL DEFAULT 'default',
        generation INTEGER NOT NULL DEFAULT 1,
        role TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        tool_calls TEXT,
        tool_call_id TEXT,
        media_json TEXT,
        origin_json TEXT,
        created_at INTEGER NOT NULL
      )
    `,
    `
      CREATE INDEX IF NOT EXISTS messages_conversation_id_id_idx
      ON messages (conversation_id, id)
    `,
    `
      CREATE TABLE IF NOT EXISTS pending_tool_calls (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL DEFAULT 'default',
        generation INTEGER NOT NULL DEFAULT 1,
        call TEXT NOT NULL,
        args_json TEXT NOT NULL,
        result_json TEXT,
        error TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS process_kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS message_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL DEFAULT 'default',
        generation INTEGER NOT NULL DEFAULT 1,
        message TEXT NOT NULL,
        media_json TEXT,
        overrides_json TEXT,
        origin_json TEXT,
        created_at INTEGER NOT NULL
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS pending_hil (
        request_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL DEFAULT 'default',
        generation INTEGER NOT NULL DEFAULT 1,
        tool_call_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        syscall TEXT NOT NULL,
        args_json TEXT NOT NULL,
        remaining_tool_calls_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS conversation_segments (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        kind TEXT NOT NULL,
        from_message_id INTEGER NOT NULL,
        to_message_id INTEGER NOT NULL,
        archive_path TEXT NOT NULL,
        summary_message_id INTEGER,
        created_at INTEGER NOT NULL
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS conversation_archives (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        kind TEXT NOT NULL,
        messages INTEGER NOT NULL,
        archive_path TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `,
    `
      CREATE INDEX IF NOT EXISTS conversation_archives_conversation_generation_idx
      ON conversation_archives (conversation_id, generation)
    `,
  ],
};
