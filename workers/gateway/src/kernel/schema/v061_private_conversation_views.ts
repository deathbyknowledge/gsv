import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V061_PRIVATE_CONVERSATION_VIEWS: SqlMigration = {
  id: 61,
  name: "private_conversation_views",
  statements: [
    "ALTER TABLE conversations ADD COLUMN read_through_sequence INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE conversations ADD COLUMN archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1))",
    "ALTER TABLE conversations ADD COLUMN view_revision INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE conversations ADD COLUMN latest_incoming_sequence INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE conversations ADD COLUMN preview_sequence INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE conversations ADD COLUMN preview_json TEXT",
    "UPDATE conversations SET read_through_sequence = latest_sequence, latest_incoming_sequence = latest_sequence",
    "CREATE INDEX conversations_inbox ON conversations (owner_uid, kind, archived, updated_at DESC, conversation_id DESC)",
  ],
};
