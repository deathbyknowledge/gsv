import type { SqlMigration } from "../../schema/runner";

/** The id after an event's type prefix: a contact message's id, or an owner notice round's. */
const KEY = "substr(s.event_id, instr(s.event_id, ':') + 1)";

/** Events still waiting for a Ship join the log, in the order its Ship would have received them. */
export const KERNEL_V093_SHIP_EVENTS_TO_LOG: SqlMigration = {
  id: 93,
  name: "ship_events_to_log",
  statements: [
    `
      INSERT INTO events (type, owner_uid, subject, actor_json, idempotency_key, body_json, created_at)
      SELECT
        json_extract(s.event_json, '$.type'),
        s.owner_uid,
        CASE json_extract(s.event_json, '$.type')
          WHEN 'contact.message' THEN json_extract(s.event_json, '$.contactId')
          ELSE 'notice:' || ${KEY}
        END,
        CASE json_extract(s.event_json, '$.type')
          WHEN 'contact.message' THEN json_object('kind', 'contact', 'contactId', json_extract(s.event_json, '$.contactId'))
          ELSE json_object('kind', 'kernel')
        END,
        ${KEY},
        json_remove(s.event_json, '$.type'),
        s.created_at
      FROM ship_events s
      ORDER BY s.created_at, s.rowid
    `,
    `
      INSERT INTO deliveries (seq, consumer, lane, state, attempt_count, next_attempt_at, last_error, updated_at)
      SELECT e.seq, 'personal:' || s.owner_uid, 'background', 'pending', s.attempt_count, s.next_attempt_at, s.last_error, s.updated_at
      FROM ship_events s
      JOIN events e ON e.type = json_extract(s.event_json, '$.type') AND e.idempotency_key = ${KEY}
    `,
    "DROP TABLE ship_events",
    // Their task kind is gone; the event runner arms itself from these deliveries when the Kernel starts.
    "DELETE FROM cf_agents_schedules WHERE callback = 'onShipEvents'",
  ],
};
