import type { SqlMigration } from "../../schema/runner";

export const PROCESS_V008_SINGLE_PROCESS_HISTORY: SqlMigration = {
  id: 8,
  name: "single_process_history",
  statements: [
    `
      INSERT OR REPLACE INTO process_kv (key, value)
      SELECT 'historyGeneration', CAST(COALESCE((
        SELECT generation FROM conversations WHERE id = 'default'
      ), 1) AS TEXT)
    `,
    `
      INSERT OR REPLACE INTO process_kv (key, value)
      SELECT 'historyUsage', value
      FROM process_kv
      WHERE key = 'conversationUsage:default'
    `,
    `
      INSERT OR REPLACE INTO process_kv (key, value)
      SELECT 'historyPolicy', value
      FROM process_kv
      WHERE key = 'conversationPolicy:default'
    `,
    `
      DELETE FROM process_kv
      WHERE key LIKE 'contextState:%'
         OR key LIKE 'conversationUsage:%'
         OR key LIKE 'conversationPolicy:%'
    `,
    `
      CREATE TABLE messages_v8 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        generation INTEGER NOT NULL DEFAULT 1,
        run_id TEXT,
        role TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        tool_calls TEXT,
        tool_call_id TEXT,
        media_json TEXT,
        origin_json TEXT,
        metadata_json TEXT,
        created_at INTEGER NOT NULL
      )
    `,
    `
      INSERT INTO messages_v8 (
        id, generation, run_id, role, content, tool_calls, tool_call_id,
        media_json, origin_json, metadata_json, created_at
      )
      SELECT
        id, generation, run_id, role, content, tool_calls, tool_call_id,
        media_json, origin_json, metadata_json, created_at
      FROM messages
      WHERE conversation_id = 'default'
    `,
    `DROP TABLE messages`,
    `ALTER TABLE messages_v8 RENAME TO messages`,
    `CREATE INDEX messages_run_id_idx ON messages (run_id)`,
    `
      CREATE TABLE pending_tool_calls_v8 (
        dispatch_id TEXT PRIMARY KEY,
        id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        call TEXT NOT NULL,
        args_json TEXT NOT NULL,
        result_json TEXT,
        error TEXT,
        status TEXT NOT NULL DEFAULT 'registered',
        created_at INTEGER NOT NULL,
        outcome TEXT
      )
    `,
    `
      INSERT INTO pending_tool_calls_v8 (
        dispatch_id, id, run_id, call, args_json, result_json, error,
        status, created_at, outcome
      )
      SELECT
        dispatch_id, id, run_id, call, args_json, result_json, error,
        status, created_at, outcome
      FROM pending_tool_calls
      WHERE conversation_id = 'default'
    `,
    `DROP TABLE pending_tool_calls`,
    `ALTER TABLE pending_tool_calls_v8 RENAME TO pending_tool_calls`,
    `
      CREATE TABLE message_queue_v8 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        generation INTEGER NOT NULL DEFAULT 1,
        message TEXT NOT NULL,
        media_json TEXT,
        overrides_json TEXT,
        origin_json TEXT,
        created_at INTEGER NOT NULL
      )
    `,
    `
      INSERT INTO message_queue_v8 (
        id, run_id, generation, message, media_json, overrides_json,
        origin_json, created_at
      )
      SELECT
        id, run_id, generation, message, media_json, overrides_json,
        origin_json, created_at
      FROM message_queue
      WHERE conversation_id = 'default'
    `,
    `DROP TABLE message_queue`,
    `ALTER TABLE message_queue_v8 RENAME TO message_queue`,
    `
      CREATE TABLE pending_hil_v8 (
        request_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        owner_dispatch_id TEXT,
        tool_call_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        syscall TEXT NOT NULL,
        args_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `,
    `
      INSERT INTO pending_hil_v8 (
        request_id, run_id, owner_dispatch_id, tool_call_id, tool_name,
        syscall, args_json, created_at
      )
      SELECT
        request_id, run_id, owner_dispatch_id, tool_call_id, tool_name,
        syscall, args_json, created_at
      FROM pending_hil
      WHERE conversation_id = 'default'
    `,
    `DROP TABLE pending_hil`,
    `ALTER TABLE pending_hil_v8 RENAME TO pending_hil`,
    `
      CREATE TABLE history_segments (
        id TEXT PRIMARY KEY,
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
      INSERT INTO history_segments (
        id, generation, kind, from_message_id, to_message_id,
        archive_path, summary_message_id, created_at
      )
      SELECT
        id, generation, kind, from_message_id, to_message_id,
        archive_path, summary_message_id, created_at
      FROM conversation_segments
      WHERE conversation_id = 'default'
    `,
    `DROP TABLE conversation_segments`,
    `DROP TABLE conversation_archives`,
    `DROP TABLE conversations`,
  ],
};
