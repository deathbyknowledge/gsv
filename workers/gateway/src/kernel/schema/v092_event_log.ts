import type { SqlMigration } from "../../schema/runner";

/** The id after a Ship event's type prefix: a contact message's id, or an owner notice round's. */
const SHIP_EVENT_KEY = "substr(s.event_id, instr(s.event_id, ':') + 1)";

/** A call ended by its target's run, rather than by the Kernel when its target was reset or killed. */
const ANSWERED_BY_TARGET = "c.status = 'completed' AND c.run_status IS NOT NULL";

/**
 * One log of Kernel events, and one delivery row per event and consumer.
 *
 * What an older Kernel still had on its way joins the log in the order each producer kept,
 * with the retry state it had: Ship events, wake batches, call answers and failed-delivery
 * notices. What arrived from each event source moves in too, going to no one. The tables,
 * columns and task kinds the log replaces go.
 */
export const KERNEL_V092_EVENT_LOG: SqlMigration = {
  id: 92,
  name: "event_log",
  statements: [
    `
      CREATE TABLE events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        owner_uid INTEGER NOT NULL,
        subject TEXT NOT NULL,
        actor_json TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        body_json TEXT,
        created_at INTEGER NOT NULL,
        UNIQUE (type, idempotency_key)
      )
    `,
    "CREATE INDEX events_created ON events (created_at)",
    "CREATE INDEX events_type_subject_created ON events (type, subject, created_at)",
    "CREATE INDEX events_type_owner_created ON events (type, owner_uid, created_at)",
    `
      CREATE TABLE deliveries (
        seq INTEGER NOT NULL REFERENCES events (seq) ON DELETE CASCADE,
        consumer TEXT NOT NULL,
        lane TEXT,
        state TEXT NOT NULL CHECK (state IN ('pending', 'delivered', 'withdrawn', 'failed')),
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL,
        last_error TEXT,
        run_id TEXT,
        outcome_json TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (seq, consumer)
      )
    `,
    "CREATE INDEX deliveries_due ON deliveries (next_attempt_at) WHERE state = 'pending'",
    "CREATE INDEX deliveries_lane ON deliveries (consumer, lane, seq) WHERE state = 'pending' AND lane IS NOT NULL",

    // Contact messages and owner notices waiting for a Ship, on its background lane.
    `
      INSERT INTO events (type, owner_uid, subject, actor_json, idempotency_key, body_json, created_at)
      SELECT
        json_extract(s.event_json, '$.type'),
        s.owner_uid,
        CASE json_extract(s.event_json, '$.type')
          WHEN 'contact.message' THEN json_extract(s.event_json, '$.contactId')
          ELSE 'notice:' || ${SHIP_EVENT_KEY}
        END,
        CASE json_extract(s.event_json, '$.type')
          WHEN 'contact.message' THEN json_object('kind', 'contact', 'contactId', json_extract(s.event_json, '$.contactId'))
          ELSE json_object('kind', 'kernel')
        END,
        ${SHIP_EVENT_KEY},
        json_remove(s.event_json, '$.type'),
        s.created_at
      FROM ship_events s
      ORDER BY s.created_at, s.rowid
    `,
    `
      INSERT INTO deliveries (seq, consumer, lane, state, attempt_count, next_attempt_at, last_error, updated_at)
      SELECT e.seq, 'personal:' || s.owner_uid, 'background', 'pending', s.attempt_count, s.next_attempt_at, s.last_error, s.updated_at
      FROM ship_events s
      JOIN events e ON e.type = json_extract(s.event_json, '$.type') AND e.idempotency_key = ${SHIP_EVENT_KEY}
    `,
    "DROP TABLE ship_events",

    // Wake batches on their way to a Ship, due whenever, outside its lanes. One that failed
    // retries at once, as the wake timer would have; the timer itself stays.
    `
      INSERT INTO events (type, owner_uid, subject, actor_json, idempotency_key, body_json, created_at)
      SELECT
        'responsibility.ready',
        b.owner_uid,
        'owner:' || b.owner_uid,
        json_object('kind', 'kernel'),
        b.batch_id,
        json_object('responsibilityIds', json(b.responsibility_ids_json), 'ledgerRevision', b.through_revision),
        b.created_at
      FROM responsibility_wake_batches b
      ORDER BY b.created_at, b.rowid
    `,
    `
      INSERT INTO deliveries (seq, consumer, lane, state, attempt_count, next_attempt_at, last_error, updated_at)
      SELECT e.seq, 'personal:' || b.owner_uid, NULL, 'pending', b.attempt_count, b.updated_at, b.last_error, b.updated_at
      FROM responsibility_wake_batches b
      JOIN events e ON e.type = 'responsibility.ready' AND e.idempotency_key = b.batch_id
    `,
    "DROP TABLE responsibility_wake_batches",

    // What arrived from each event source, which goes to no one. A body the log can't hold
    // keeps its event without the body, as a webhook's does.
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

    // Answers their callers haven't heard yet move into their events, which carry them from
    // now on, and their calls' rows go: a call's row lasts only while the call is in flight.
    // An answer an older Kernel held keeps its whole text, as its row did.
    `
      INSERT INTO events (type, owner_uid, subject, actor_json, idempotency_key, body_json, created_at)
      SELECT
        CASE c.status WHEN 'timed_out' THEN 'ipc.timeout' ELSE 'ipc.reply' END,
        c.uid,
        'ipc:' || c.call_id,
        CASE WHEN ${ANSWERED_BY_TARGET} THEN json_object('kind', 'process', 'pid', c.target_pid) ELSE json_object('kind', 'kernel') END,
        c.call_id,
        json_remove(
          json_object(
            'sourcePid', c.source_pid, 'callId', c.call_id, 'targetPid', c.target_pid, 'sourceRunId', c.source_run_id,
            'createdAt', c.created_at, 'deadlineAt', c.deadline_at, 'response', json(c.response_json), 'error', c.error
          ),
          CASE WHEN c.source_run_id IS NULL THEN '$.sourceRunId' ELSE '$.absent' END,
          CASE WHEN c.response_json = 'null' THEN '$.response' ELSE '$.absent' END,
          CASE WHEN c.error IS NULL THEN '$.error' ELSE '$.absent' END
        ),
        c.updated_at
      FROM ipc_calls c
      WHERE c.status IN ('completed', 'timed_out')
      ORDER BY c.updated_at, c.call_id
    `,
    `
      INSERT INTO deliveries (seq, consumer, lane, state, attempt_count, next_attempt_at, updated_at)
      SELECT seq, 'proc:' || json_extract(body_json, '$.sourcePid'), 'background', 'pending', 0, created_at, created_at
      FROM events WHERE type IN ('ipc.reply', 'ipc.timeout')
    `,
    "DELETE FROM ipc_calls WHERE status <> 'pending'",
    "DROP INDEX idx_ipc_calls_target_run",
    "DROP INDEX idx_ipc_calls_deadline",
    "ALTER TABLE ipc_calls DROP COLUMN status",
    "ALTER TABLE ipc_calls DROP COLUMN run_status",
    "ALTER TABLE ipc_calls DROP COLUMN response_json",
    "ALTER TABLE ipc_calls DROP COLUMN error",
    "ALTER TABLE ipc_calls DROP COLUMN delivery_started_at",
    "CREATE INDEX idx_ipc_calls_target_run ON ipc_calls (uid, target_pid, target_run_id)",

    // Failed-delivery notices for processes that are still there; one whose process is gone
    // has no one to tell. Each is keyed as before, so two tasks for one failure append once.
    `
      INSERT OR IGNORE INTO events (type, owner_uid, subject, actor_json, idempotency_key, body_json, created_at)
      SELECT
        'delivery.failed',
        COALESCE(p.owner_uid, p.uid),
        'proc:' || p.process_id,
        json_object('kind', 'kernel'),
        json_extract(s.payload, '$.noticeId'),
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
      SELECT seq, 'proc:' || json_extract(body_json, '$.pid'), 'background', 'pending', 0, created_at, created_at
      FROM events WHERE type = 'delivery.failed'
    `,

    // A schedule aimed at a Ship's pid becomes the Ship responsibility new ones are stored as,
    // so every firing for a process goes on the log. Its reply destination goes: the Ship
    // replies where its owner last spoke.
    `
      UPDATE schedules
      SET target_json = CASE
        WHEN json_type(target_json, '$.data') IS NULL
          THEN json_object('kind', 'responsibility', 'message', json_extract(target_json, '$.message'))
        ELSE json_object('kind', 'responsibility', 'message', json_extract(target_json, '$.message'), 'data', target_json -> '$.data')
      END
      WHERE json_extract(target_json, '$.kind') = 'process.event'
        AND json_extract(target_json, '$.pid') IN (SELECT process_id FROM processes WHERE is_personal_controller = 1)
    `,

    // A /ship records its return on the log, keyed by its ingress receipt, so one an older
    // Kernel left checkpointed starts afresh when its adapter retries.
    `UPDATE adapter_ingress_receipts SET progress_json = NULL
      WHERE state = 'in_progress' AND json_extract(progress_json, '$.kind') = 'work_return'`,

    // The task kinds the log replaces; the event runner arms itself from pending deliveries
    // when the Kernel starts. Settling a memory review admits the next one, and staged
    // approval notices return at once.
    `DELETE FROM cf_agents_schedules
      WHERE callback IN ('onShipEvents', 'onIpcCallDelivery', 'onProcessDeliveryNotice', 'onMemoryReview', 'onProcessApprovalNotice')`,
  ],
};
