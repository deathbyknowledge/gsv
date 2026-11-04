import type { SqlMigration } from "../../schema/runner";

/**
 * What arrived from each event source moves into the Kernel log as `source.event` rows,
 * which go to no one; a source's list and its check for repeats read them there. A body
 * the log can't hold keeps its event without the body, as a webhook's does. The log's
 * retention then forgets each row on the schedule `event_log` kept.
 */
export const KERNEL_V097_SOURCE_EVENTS_TO_LOG: SqlMigration = {
  id: 97,
  name: "source_events_to_log",
  statements: [
    "CREATE INDEX events_type_subject_created ON events (type, subject, created_at)",
    "CREATE INDEX events_type_owner_created ON events (type, owner_uid, created_at)",
    `
      INSERT INTO events (type, owner_uid, subject, actor_json, idempotency_key, body_json, created_at)
      SELECT 'source.event', owner_uid, 'source:' || source_id, json_object('kind', 'source', 'sourceId', source_id),
        source_id || ':' || event_id,
        CASE WHEN length(CAST(stored AS BLOB)) <= 65536 THEN stored ELSE json_remove(stored, '$.body') END,
        received_at
      FROM (
        SELECT source_id, event_id, owner_uid, received_at,
          json_remove(
            json_object('eventId', event_id, 'title', title, 'preview', preview, 'body', body, 'emittedBy', emitted_by),
            CASE WHEN preview IS NULL THEN '$.preview' ELSE '$.absent' END,
            CASE WHEN body IS NULL THEN '$.body' ELSE '$.absent' END
          ) AS stored
        FROM event_log
      )
      ORDER BY received_at, source_id, event_id
    `,
    "DROP TABLE event_log",
  ],
};
