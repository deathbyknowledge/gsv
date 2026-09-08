import type { SqlMigration } from "../../schema/runner";

export const PROCESS_V014_TYPED_HISTORY_RECORDS: SqlMigration = {
  id: 14,
  name: "typed_history_records",
  statements: [
    "ALTER TABLE messages ADD COLUMN kind TEXT",
    "ALTER TABLE messages ADD COLUMN payload_json TEXT",
    "ALTER TABLE messages ADD COLUMN group_message_id INTEGER",
    "CREATE INDEX messages_group_message_idx ON messages (group_message_id, id)",
    "ALTER TABLE message_queue ADD COLUMN record_json TEXT",
  ],
};
