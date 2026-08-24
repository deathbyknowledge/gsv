import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V028_RENAME_HOME_CONVERSATION_TO_SHIP: SqlMigration = {
  id: 28,
  name: "rename_home_conversation_to_ship",
  statements: [
    `
      CREATE TABLE conversations_v028 (
        conversation_id TEXT PRIMARY KEY,
        owner_uid INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('ship', 'work', 'group')),
        title TEXT,
        handler_pid TEXT NOT NULL,
        latest_sequence INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `,
    `
      INSERT INTO conversations_v028 (
        conversation_id, owner_uid, kind, title, handler_pid,
        latest_sequence, created_at, updated_at
      )
      SELECT
        conversation_id,
        owner_uid,
        CASE kind WHEN 'home' THEN 'ship' ELSE kind END,
        CASE WHEN kind = 'home' AND title = 'Home' THEN 'Ship' ELSE title END,
        handler_pid,
        latest_sequence,
        created_at,
        updated_at
      FROM conversations
    `,
    "DROP TABLE conversations",
    "ALTER TABLE conversations_v028 RENAME TO conversations",
    `
      CREATE UNIQUE INDEX conversations_ship_owner_idx
      ON conversations (owner_uid)
      WHERE kind = 'ship'
    `,
    `
      CREATE UNIQUE INDEX conversations_handler_work_idx
      ON conversations (handler_pid)
      WHERE kind = 'work'
    `,
  ],
};
