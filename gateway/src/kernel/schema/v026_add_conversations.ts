import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V026_ADD_CONVERSATIONS: SqlMigration = {
  id: 26,
  name: "add_conversations",
  statements: [
    `
      CREATE TABLE conversations (
        conversation_id TEXT PRIMARY KEY,
        owner_uid INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('home', 'work', 'group')),
        title TEXT,
        handler_pid TEXT NOT NULL,
        latest_sequence INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `,
    `
      CREATE UNIQUE INDEX conversations_home_owner_idx
      ON conversations (owner_uid)
      WHERE kind = 'home'
    `,
    `
      CREATE UNIQUE INDEX conversations_handler_work_idx
      ON conversations (handler_pid)
      WHERE kind = 'work'
    `,
    `
      CREATE TABLE conversation_members (
        conversation_id TEXT NOT NULL,
        member_kind TEXT NOT NULL CHECK (member_kind IN ('account', 'process')),
        member_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('member', 'handler', 'observer')),
        created_at INTEGER NOT NULL,
        PRIMARY KEY (conversation_id, member_kind, member_id)
      )
    `,
    `
      CREATE INDEX conversation_members_member_idx
      ON conversation_members (member_kind, member_id)
    `,
    `
      CREATE TABLE conversation_surfaces (
        surface_key TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL UNIQUE,
        owner_uid INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      )
    `,
  ],
};
