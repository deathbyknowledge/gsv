import type { JsonObject, JsonValue } from "@humansandmachines/gsv/protocol";

/** An event stays whole for 30 days; its key then refuses a late duplicate until day 180. */
export const EVENT_BODY_RETENTION_MS = 30 * 24 * 60 * 60_000;
export const EVENT_KEY_RETENTION_MS = 180 * 24 * 60 * 60_000;
const MAX_INLINE_BODY_BYTES = 64 * 1024;
const MAX_ERROR_LENGTH = 1_000;

/** Who caused an event. */
export type EventActor =
  | { kind: "person"; uid: number }
  | { kind: "process"; pid: string }
  | { kind: "contact"; contactId: string }
  | { kind: "schedule"; scheduleId: string }
  | { kind: "source"; sourceId: string }
  | { kind: "kernel" };

/** What a producer appends. */
export type EventInput = {
  type: string;
  /** Whose event it is: who may see it, and whose Ship receives it. */
  ownerUid: number;
  /** What it is about, such as `contact:<id>` or `proc:<pid>`. */
  subject: string;
  actor: EventActor;
  /** The producer's idempotency key; a repeated type and key appends nothing. */
  key: string;
  /** Inline JSON up to 64 KiB, or a reference into the store that accepted larger content. */
  body?: JsonValue;
};

/** An appended event as the log holds it. */
export type LoggedEvent = Omit<EventInput, "body"> & {
  seq: number;
  /** `evt_<seq>`: stable for the event's life and never reused. */
  id: string;
  /** Null once retention keeps only the event's key. */
  body: JsonValue | null;
  createdAt: number;
};

/** One consumer an event goes to, and the lane that orders it there; an unlaned delivery goes whenever it is due. */
export type EventRoute = { consumer: string; lane: string | null };

export type PendingDelivery = {
  event: LoggedEvent;
  consumer: string;
  lane: string | null;
  attemptCount: number;
};

export type DeliveryRecord = {
  state: "pending" | "delivered" | "withdrawn" | "failed";
  lane: string | null;
  attemptCount: number;
  nextAttemptAt: number;
  /** The last failed attempt's error, or why the delivery was withdrawn. */
  lastError: string | null;
  runId: string | null;
  outcome: JsonObject | null;
};

type EventRow = {
  seq: number;
  type: string;
  owner_uid: number;
  subject: string;
  actor_json: string;
  idempotency_key: string;
  body_json: string | null;
  created_at: number;
};

type PendingRow = EventRow & { consumer: string; lane: string | null; attempt_count: number; next_attempt_at: number };

type DeliveryRow = {
  state: DeliveryRecord["state"];
  lane: string | null;
  attempt_count: number;
  next_attempt_at: number;
  last_error: string | null;
  run_id: string | null;
  outcome_json: string | null;
};

const PENDING_COLUMNS = "e.*, d.consumer, d.lane, d.attempt_count, d.next_attempt_at";

/** A pending delivery that may go now: unlaned, or the oldest pending row of its lane. */
const LANE_HEAD = `(d.lane IS NULL OR d.seq = (
  SELECT MIN(x.seq) FROM deliveries x
  WHERE x.state = 'pending' AND x.consumer = d.consumer AND x.lane = d.lane
))`;

/** An event none of whose deliveries is still pending. */
const SETTLED = "NOT EXISTS (SELECT 1 FROM deliveries p WHERE p.seq = e.seq AND p.state = 'pending')";

/** The Kernel's event log and the delivery rows its consumers work through. */
export class EventStore {
  private readonly sql: SqlStorage;

  constructor(private readonly storage: DurableObjectStorage) {
    this.sql = storage.sql;
  }

  /** Appends an event and one delivery per route, once per type and key. Call inside the producer's transaction. */
  append(input: EventInput, routes: readonly EventRoute[], now: number): { event: LoggedEvent; appended: boolean } {
    const bodyJson = input.body === undefined ? null : JSON.stringify(input.body);
    if (bodyJson !== null && new TextEncoder().encode(bodyJson).byteLength > MAX_INLINE_BODY_BYTES) {
      throw new Error(`Event body exceeds ${MAX_INLINE_BODY_BYTES} bytes`);
    }
    return this.storage.transactionSync(() => {
      const existing = this.sql.exec<EventRow>(
        "SELECT * FROM events WHERE type = ? AND idempotency_key = ?",
        input.type, input.key,
      ).toArray()[0];
      if (existing) return { event: eventFromRow(existing), appended: false };
      const row = this.sql.exec<EventRow>(
        `INSERT INTO events (type, owner_uid, subject, actor_json, idempotency_key, body_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
        input.type, input.ownerUid, input.subject, JSON.stringify(input.actor), input.key, bodyJson, now,
      ).one();
      for (const route of routes) {
        this.sql.exec(
          `INSERT INTO deliveries (seq, consumer, lane, state, attempt_count, next_attempt_at, updated_at)
           VALUES (?, ?, ?, 'pending', 0, ?, ?)`,
          row.seq, route.consumer, route.lane, now, now,
        );
      }
      return { event: eventFromRow(row), appended: true };
    });
  }

  event(seq: number): LoggedEvent | null {
    const row = this.sql.exec<EventRow>("SELECT * FROM events WHERE seq = ?", seq).toArray()[0];
    return row ? eventFromRow(row) : null;
  }

  delivery(seq: number, consumer: string): DeliveryRecord | null {
    const row = this.sql.exec<DeliveryRow>(
      `SELECT state, lane, attempt_count, next_attempt_at, last_error, run_id, outcome_json
       FROM deliveries WHERE seq = ? AND consumer = ?`,
      seq, consumer,
    ).toArray()[0];
    if (!row) return null;
    return {
      state: row.state,
      lane: row.lane,
      attemptCount: row.attempt_count,
      nextAttemptAt: row.next_attempt_at,
      lastError: row.last_error,
      runId: row.run_id,
      // SAFETY: delivered() writes outcome_json only from a JsonObject.
      outcome: row.outcome_json === null ? null : JSON.parse(row.outcome_json) as JsonObject,
    };
  }

  /** The oldest pending delivery of each lane, and every unlaned one, whose attempt is due. */
  dueHeads(now: number): PendingDelivery[] {
    return this.sql.exec<PendingRow>(
      `SELECT ${PENDING_COLUMNS} FROM deliveries d JOIN events e ON e.seq = d.seq
       WHERE d.state = 'pending' AND d.next_attempt_at <= ? AND ${LANE_HEAD}
       ORDER BY d.seq, d.consumer`,
      now,
    ).toArray().map(pendingFromRow);
  }

  /** A lane's oldest pending delivery, once its attempt is due. */
  dueHead(consumer: string, lane: string, now: number): PendingDelivery | null {
    const row = this.sql.exec<PendingRow>(
      `SELECT ${PENDING_COLUMNS} FROM deliveries d JOIN events e ON e.seq = d.seq
       WHERE d.state = 'pending' AND d.consumer = ? AND d.lane = ?
       ORDER BY d.seq LIMIT 1`,
      consumer, lane,
    ).toArray()[0];
    return row && row.next_attempt_at <= now ? pendingFromRow(row) : null;
  }

  /** When the next attempt falls due; a delivery behind its lane's head waits for the head. */
  nextDueAt(): number | null {
    return this.sql.exec<{ at: number | null }>(
      `SELECT MIN(d.next_attempt_at) AS at FROM deliveries d WHERE d.state = 'pending' AND ${LANE_HEAD}`,
    ).one().at;
  }

  delivered(seq: number, consumer: string, result: { runId: string | null; outcome: JsonObject }, now: number): void {
    this.sql.exec(
      `UPDATE deliveries SET state = 'delivered', run_id = ?, outcome_json = ?, updated_at = ?
       WHERE seq = ? AND consumer = ? AND state = 'pending'`,
      result.runId, JSON.stringify(result.outcome), now, seq, consumer,
    );
  }

  /** Ends a delivery whose consumer or subject no longer wants it, without a call. */
  withdrawn(seq: number, consumer: string, reason: string, now: number): void {
    this.sql.exec(
      `UPDATE deliveries SET state = 'withdrawn', last_error = ?, updated_at = ?
       WHERE seq = ? AND consumer = ? AND state = 'pending'`,
      reason.slice(0, MAX_ERROR_LENGTH), now, seq, consumer,
    );
  }

  /** Records a failed attempt, retried at `nextAttemptAt` or ended as failed when it is null. */
  failed(seq: number, consumer: string, error: string, nextAttemptAt: number | null, now: number): void {
    this.sql.exec(
      `UPDATE deliveries SET attempt_count = attempt_count + 1, last_error = ?, state = ?, next_attempt_at = ?, updated_at = ?
       WHERE seq = ? AND consumer = ? AND state = 'pending'`,
      error.slice(0, MAX_ERROR_LENGTH), nextAttemptAt === null ? "failed" : "pending", nextAttemptAt ?? now, now, seq, consumer,
    );
  }

  /** When retention next has work: a settled event's body and outcomes at 30 days, a bare key at 180. */
  nextPruneAt(): number | null {
    const { body, key } = this.sql.exec<{ body: number | null; key: number | null }>(
      `SELECT
         (SELECT MIN(e.created_at) FROM events e WHERE ${SETTLED}
            AND (e.body_json IS NOT NULL OR EXISTS (SELECT 1 FROM deliveries d WHERE d.seq = e.seq))) AS body,
         (SELECT MIN(e.created_at) FROM events e
            WHERE NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.seq = e.seq)) AS key`,
    ).one();
    const due = [body === null ? null : body + EVENT_BODY_RETENTION_MS, key === null ? null : key + EVENT_KEY_RETENTION_MS]
      .filter((at): at is number => at !== null);
    return due.length ? Math.min(...due) : null;
  }

  /** Drops a settled event's body and outcomes after 30 days and its key after 180; a pending delivery keeps both. */
  prune(now: number): void {
    const bodyBefore = now - EVENT_BODY_RETENTION_MS;
    this.storage.transactionSync(() => {
      this.sql.exec(
        `DELETE FROM deliveries WHERE seq IN (SELECT e.seq FROM events e WHERE e.created_at <= ? AND ${SETTLED})`,
        bodyBefore,
      );
      this.sql.exec(
        `UPDATE events SET body_json = NULL WHERE seq IN (
           SELECT e.seq FROM events e WHERE e.created_at <= ? AND e.body_json IS NOT NULL AND ${SETTLED}
         )`,
        bodyBefore,
      );
      this.sql.exec(
        "DELETE FROM events WHERE created_at <= ? AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.seq = events.seq)",
        now - EVENT_KEY_RETENTION_MS,
      );
    });
  }
}

function eventFromRow(row: EventRow): LoggedEvent {
  return {
    seq: row.seq,
    id: `evt_${row.seq}`,
    type: row.type,
    ownerUid: row.owner_uid,
    subject: row.subject,
    // SAFETY: append() writes actor_json only from a typed EventActor.
    actor: JSON.parse(row.actor_json) as EventActor,
    key: row.idempotency_key,
    // SAFETY: append() writes body_json only by serializing a JsonValue.
    body: row.body_json === null ? null : JSON.parse(row.body_json) as JsonValue,
    createdAt: row.created_at,
  };
}

function pendingFromRow(row: PendingRow): PendingDelivery {
  return { event: eventFromRow(row), consumer: row.consumer, lane: row.lane, attemptCount: row.attempt_count };
}
