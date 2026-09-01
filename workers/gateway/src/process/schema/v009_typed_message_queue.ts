import type { SqlMigration } from "../../schema/runner";

export const PROCESS_V009_TYPED_MESSAGE_QUEUE: SqlMigration = {
  id: 9,
  name: "add_typed_message_queue",
  statements: [
    `
      ALTER TABLE message_queue
      ADD COLUMN role TEXT NOT NULL DEFAULT 'user'
        CHECK (role IN ('user', 'system'))
    `,
    `
      ALTER TABLE message_queue
      ADD COLUMN kind TEXT NOT NULL DEFAULT 'message'
    `,
    `
      ALTER TABLE message_queue
      ADD COLUMN provenance_json TEXT
    `,
    `
      UPDATE message_queue
      SET role = 'system',
          kind = 'schedule.event',
          provenance_json = json_object(
            'source', 'kernel',
            'eventId', run_id,
            'eventType', 'schedule.event'
          )
      WHERE json_valid(origin_json)
        AND json_extract(origin_json, '$.kind') = 'scheduler'
    `,
    `
      UPDATE message_queue
      SET role = 'system',
          kind = 'runtime.wake',
          provenance_json = json_object(
            'source', 'process',
            'eventType', 'runtime.wake'
          )
      WHERE message = 'A runtime event arrived while you were busy. Review the process event above and continue.'
        AND kind = 'message'
    `,
  ],
};
