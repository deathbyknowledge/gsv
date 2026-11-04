import type { SqlMigration } from "../../schema/runner";

const NOTICE = "json_extract(s.payload, '$.noticeId')";

/**
 * Failed-delivery notices an older Kernel had yet to hand their processes join the log as
 * `delivery.failed`, each with a pending delivery to its process. One whose process is gone
 * has no one to tell. A notice is keyed as before, so two tasks for one failure append once,
 * and its task kind goes.
 */
export const KERNEL_V101_DELIVERY_NOTICES_TO_LOG: SqlMigration = {
  id: 101,
  name: "delivery_notices_to_log",
  statements: [
    `
      INSERT OR IGNORE INTO events (type, owner_uid, subject, actor_json, idempotency_key, body_json, created_at)
      SELECT
        'delivery.failed',
        COALESCE(p.owner_uid, p.uid),
        'proc:' || p.process_id,
        json_object('kind', 'kernel'),
        ${NOTICE},
        json_patch(
          json_object('pid', p.process_id, 'runId', json_extract(s.payload, '$.runId'), 'message', json_extract(s.payload, '$.message')),
          json_object('requestId', json_extract(s.payload, '$.requestId'))
        ),
        s.created_at * 1000
      FROM cf_agents_schedules s
      JOIN processes p ON p.process_id = json_extract(s.payload, '$.processId')
      WHERE s.callback = 'onProcessDeliveryNotice'
      ORDER BY s.time, s.created_at, s.id
    `,
    `
      INSERT INTO deliveries (seq, consumer, lane, state, attempt_count, next_attempt_at, updated_at)
      SELECT e.seq, 'proc:' || json_extract(e.body_json, '$.pid'), 'background', 'pending', 0, e.created_at, e.created_at
      FROM events e
      WHERE e.type = 'delivery.failed' AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.seq = e.seq)
    `,
    // Their task kind is gone; the event runner arms itself from these deliveries when the Kernel starts.
    "DELETE FROM cf_agents_schedules WHERE callback = 'onProcessDeliveryNotice'",
  ],
};
