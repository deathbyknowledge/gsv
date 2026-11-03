import type { SqlMigration } from "../../schema/runner";

/**
 * Wake batches still on their way to a Ship join the log. A batch that failed retries at
 * once, as the wake timer would have; the timer itself stays.
 */
export const KERNEL_V094_RESPONSIBILITY_WAKES_TO_LOG: SqlMigration = {
  id: 94,
  name: "responsibility_wakes_to_log",
  statements: [
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
      SELECT e.seq, 'personal:' || b.owner_uid, 'background', 'pending', b.attempt_count, b.updated_at, b.last_error, b.updated_at
      FROM responsibility_wake_batches b
      JOIN events e ON e.type = 'responsibility.ready' AND e.idempotency_key = b.batch_id
    `,
    "DROP TABLE responsibility_wake_batches",
  ],
};
