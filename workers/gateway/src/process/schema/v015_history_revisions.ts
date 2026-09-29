import type { SqlMigration } from "../../schema/runner";

export const PROCESS_V015_HISTORY_REVISIONS: SqlMigration = {
  id: 15,
  name: "history_revisions",
  statements: [
    "ALTER TABLE messages ADD COLUMN history_revision INTEGER NOT NULL DEFAULT 0",
    "CREATE INDEX messages_history_revision_idx ON messages (history_revision, id) WHERE group_message_id IS NULL",
    "INSERT INTO process_kv (key, value) VALUES ('historyRevision', '0')",
    "INSERT INTO process_kv (key, value) VALUES ('historyResetRevision', '0')",
  ],
};
