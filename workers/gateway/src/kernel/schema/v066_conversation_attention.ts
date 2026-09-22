import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V066_CONVERSATION_ATTENTION: SqlMigration = {
  id: 66,
  name: "conversation_attention",
  statements: [
    "ALTER TABLE conversations ADD COLUMN attention_processed_sequence INTEGER NOT NULL DEFAULT 0",
    "UPDATE conversations SET attention_processed_sequence = latest_sequence",
    `CREATE TABLE conversation_attention (
      conversation_id TEXT PRIMARY KEY, owner_uid INTEGER NOT NULL,
      contact_id TEXT NOT NULL, contact_generation TEXT NOT NULL,
      sequence INTEGER NOT NULL, policy TEXT NOT NULL CHECK (policy IN ('notify', 'digest')),
      available_at INTEGER NOT NULL, announced INTEGER NOT NULL DEFAULT 0,
      preview_json TEXT NOT NULL
    )`,
    "CREATE INDEX conversation_attention_owner ON conversation_attention (owner_uid, available_at DESC, conversation_id DESC)",
    "CREATE INDEX conversation_attention_alarm ON conversation_attention (announced, policy, available_at)",
  ],
};
