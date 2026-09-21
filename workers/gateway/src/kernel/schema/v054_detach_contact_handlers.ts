import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V054_DETACH_CONTACT_HANDLERS: SqlMigration = {
  id: 54,
  name: "detach_contact_handlers",
  statements: [
    `CREATE TABLE conversations_v054 (
      conversation_id TEXT PRIMARY KEY,
      owner_uid INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('ship', 'work', 'group', 'contact')),
      title TEXT,
      handler_pid TEXT,
      latest_sequence INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      CHECK (kind = 'contact' OR handler_pid IS NOT NULL)
    )`,
    `INSERT INTO conversations_v054
      SELECT conversation_id, owner_uid, kind, title,
        CASE WHEN kind = 'contact' THEN NULL ELSE handler_pid END,
        latest_sequence, created_at, updated_at FROM conversations`,
    `UPDATE conversation_members SET role = 'observer'
      WHERE member_kind = 'process' AND role = 'handler'
        AND conversation_id IN (SELECT conversation_id FROM conversations WHERE kind = 'contact')`,
    "DROP TABLE conversations",
    "ALTER TABLE conversations_v054 RENAME TO conversations",
    "CREATE UNIQUE INDEX conversations_ship_owner_idx ON conversations (owner_uid) WHERE kind = 'ship'",
    "CREATE UNIQUE INDEX conversations_handler_work_idx ON conversations (handler_pid) WHERE kind = 'work'",
  ],
};
