import type { SqlMigration } from "../../schema/runner";

export const KERNEL_V071_SCOPED_MESSAGE_ADMISSION: SqlMigration = {
  id: 71, name: "scoped_message_admission",
  statements: [
    `CREATE TABLE process_scope_automation (
      scope_id TEXT PRIMARY KEY, contact_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
      generation TEXT NOT NULL, start_sequence INTEGER NOT NULL,
      accepted_messages INTEGER NOT NULL DEFAULT 0, next_admission_at INTEGER NOT NULL DEFAULT 0,
      paused_reason TEXT
    )`,
    "CREATE INDEX process_scope_automation_contact ON process_scope_automation (contact_id)",
    `CREATE TABLE process_scope_inbox (
      scope_id TEXT NOT NULL, message_id TEXT NOT NULL, message_sequence INTEGER NOT NULL,
      reference_json TEXT NOT NULL, event_id TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL DEFAULT 'pending', next_attempt_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, dispatched_at INTEGER, reply_key TEXT,
      PRIMARY KEY (scope_id, message_id)
    )`,
    "CREATE INDEX process_scope_inbox_pending ON process_scope_inbox (state, next_attempt_at)",
  ],
};
