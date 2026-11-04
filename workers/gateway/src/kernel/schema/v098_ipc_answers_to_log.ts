import type { SqlMigration } from "../../schema/runner";

/** A call ended by its target's run, rather than by the Kernel when its target was reset or killed. */
const ANSWERED_BY_TARGET = "c.status = 'completed' AND c.run_status IS NOT NULL";

/**
 * Calls that ended but whose caller hasn't heard yet join the log as `ipc.reply` or
 * `ipc.timeout`, each with a pending delivery to its caller. The log reads the answer
 * from the call's row when it delivers, and removes the row once that ends, so the
 * row's own delivery claim and its task kind go.
 */
export const KERNEL_V098_IPC_ANSWERS_TO_LOG: SqlMigration = {
  id: 98,
  name: "ipc_answers_to_log",
  statements: [
    `
      INSERT INTO events (type, owner_uid, subject, actor_json, idempotency_key, body_json, created_at)
      SELECT
        CASE c.status WHEN 'timed_out' THEN 'ipc.timeout' ELSE 'ipc.reply' END,
        c.uid,
        'ipc:' || c.call_id,
        CASE WHEN ${ANSWERED_BY_TARGET} THEN json_object('kind', 'process', 'pid', c.target_pid) ELSE json_object('kind', 'kernel') END,
        c.call_id,
        json_object('callId', c.call_id, 'sourcePid', c.source_pid),
        c.updated_at
      FROM ipc_calls c
      WHERE c.status IN ('completed', 'timed_out')
      ORDER BY c.updated_at, c.call_id
    `,
    `
      INSERT INTO deliveries (seq, consumer, lane, state, attempt_count, next_attempt_at, updated_at)
      SELECT e.seq, 'proc:' || c.source_pid, 'background', 'pending', 0, e.created_at, e.created_at
      FROM ipc_calls c
      JOIN events e ON e.type IN ('ipc.reply', 'ipc.timeout') AND e.idempotency_key = c.call_id
      WHERE c.status IN ('completed', 'timed_out')
    `,
    "ALTER TABLE ipc_calls DROP COLUMN delivery_started_at",
    // Their task kind is gone; the event runner arms itself from these deliveries when the Kernel starts.
    "DELETE FROM cf_agents_schedules WHERE callback = 'onIpcCallDelivery'",
  ],
};
