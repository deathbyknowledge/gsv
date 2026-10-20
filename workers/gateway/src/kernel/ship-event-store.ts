import { resourceBlockSchema, type ResourceBlock } from "@humansandmachines/gsv/protocol";
import { z } from "zod";
import type { ProcessContactMessageRuntimeEvent } from "../protocol/process-frames";

/** An event addressed to an owner's Ship rather than to one of its replaceable pids. */
export type ShipEvent = ProcessContactMessageRuntimeEvent;

export type QueuedShipEvent = {
  eventId: string;
  ownerUid: number;
  event: ShipEvent;
  attemptCount: number;
  nextAttemptAtMs: number;
};

type ShipEventRow = {
  event_id: string;
  owner_uid: number;
  event_json: string;
  attempt_count: number;
  next_attempt_at: number;
};

const shipEventSchema = z.object({
  type: z.literal("contact.message"),
  contactId: z.string(),
  conversationId: z.string(),
  messageId: z.string(),
  from: z.string(),
  text: z.string(),
  media: z.array(z.custom<ResourceBlock>((value) => resourceBlockSchema.safeParse(value).success)).optional(),
  responsibilityId: z.string(),
  ledgerRevision: z.number().int().nonnegative(),
});

/** Durable, ordered Ship events per owner; a row leaves the queue once its Ship admits it. */
export class ShipEventStore {
  private readonly sql: SqlStorage;
  constructor(storage: DurableObjectStorage) { this.sql = storage.sql; }

  /** Queue an event once; replaying the same id keeps the original. Call inside the producer's transaction. */
  enqueue(ownerUid: number, eventId: string, event: ShipEvent, now: number): void {
    this.sql.exec(
      `INSERT OR IGNORE INTO ship_events (
        event_id, owner_uid, event_json, attempt_count, last_error, next_attempt_at, created_at, updated_at
      ) VALUES (?, ?, ?, 0, NULL, ?, ?, ?)`,
      eventId, ownerUid, JSON.stringify(event), now, now, now,
    );
  }

  next(ownerUid: number): QueuedShipEvent | null {
    const row = this.sql.exec<ShipEventRow>(
      `SELECT event_id, owner_uid, event_json, attempt_count, next_attempt_at FROM ship_events
       WHERE owner_uid = ? ORDER BY created_at, rowid LIMIT 1`,
      ownerUid,
    ).toArray()[0];
    if (!row) return null;
    return {
      eventId: row.event_id,
      ownerUid: row.owner_uid,
      event: shipEventSchema.parse(JSON.parse(row.event_json)),
      attemptCount: row.attempt_count,
      nextAttemptAtMs: row.next_attempt_at,
    };
  }

  delivered(eventId: string): void {
    this.sql.exec("DELETE FROM ship_events WHERE event_id = ?", eventId);
  }

  failed(eventId: string, error: string, nextAttemptAtMs: number, now: number): void {
    this.sql.exec(
      `UPDATE ship_events SET attempt_count = attempt_count + 1, last_error = ?, next_attempt_at = ?, updated_at = ?
       WHERE event_id = ?`,
      error.slice(0, 1_000), nextAttemptAtMs, now, eventId,
    );
  }

  ownersWithEvents(): number[] {
    return this.sql.exec<{ owner_uid: number }>("SELECT DISTINCT owner_uid FROM ship_events")
      .toArray().map(({ owner_uid }) => owner_uid);
  }
}
