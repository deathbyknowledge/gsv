import { describe, expect, it } from "vitest";
import { runWithRealKernelSql } from "../../test-support/real-kernel-sql";
import { EVENT_BODY_RETENTION_MS, EVENT_KEY_RETENTION_MS, EventStore, type EventInput, type EventRoute } from "./store";

const SHIP = "personal:1000";
const ship = (lane: string): EventRoute => ({ consumer: SHIP, lane });

function input(key: string, body: EventInput["body"] = { key }): EventInput {
  return { type: "fixture.happened", ownerUid: 1000, subject: `fixture:${key}`, actor: { kind: "kernel" }, key, body };
}

describe("event store", () => {
  it("appends an event once per type and key, with one delivery per route", async () => {
    await runWithRealKernelSql((_sql, storage) => {
      const events = new EventStore(storage);
      const first = events.append(input("one"), [ship("background"), { consumer: "proc:proc:watcher", lane: "watch" }], 100);
      expect(first).toMatchObject({ appended: true, event: { id: `evt_${first.event.seq}`, type: "fixture.happened", body: { key: "one" }, createdAt: 100 } });
      const repeat = events.append({ ...input("one"), body: { key: "changed" } }, [ship("background")], 200);
      expect(repeat).toEqual({ appended: false, event: first.event });
      expect(events.append({ ...input("one"), type: "fixture.other" }, [], 300).appended).toBe(true);
      expect(events.dueHeads(100).map(({ consumer, lane, event }) => [consumer, lane, event.seq])).toEqual([
        [SHIP, "background", first.event.seq],
        ["proc:proc:watcher", "watch", first.event.seq],
      ]);
    });
  });

  it("never reuses a sequence number once its event is gone", async () => {
    await runWithRealKernelSql((_sql, storage) => {
      const events = new EventStore(storage);
      const old = events.append(input("old"), [], 0).event;
      events.prune(EVENT_KEY_RETENTION_MS);
      expect(events.append(input("new"), [], EVENT_KEY_RETENTION_MS).event.seq).toBeGreaterThan(old.seq);
    });
  });

  it("refuses an inline body over 64 KiB", async () => {
    await runWithRealKernelSql((_sql, storage) => {
      const events = new EventStore(storage);
      expect(() => events.append(input("large", "x".repeat(64 * 1024)), [], 0)).toThrow("Event body exceeds 65536 bytes");
      expect(events.dueHeads(0)).toEqual([]);
    });
  });

  it("offers each lane's oldest pending delivery, holds a lane behind a waiting head, and leaves unlaned rows to their time", async () => {
    await runWithRealKernelSql((_sql, storage) => {
      const events = new EventStore(storage);
      const first = events.append(input("first"), [ship("background")], 0).event;
      const second = events.append(input("second"), [ship("background")], 0).event;
      const person = events.append(input("person"), [ship("person")], 0).event;
      const loose = events.append(input("loose"), [{ consumer: SHIP, lane: null }], 0).event;
      const heads = () => events.dueHeads(1_000).map(({ event }) => event.seq);
      expect(heads()).toEqual([first.seq, person.seq, loose.seq]);

      events.failed(first.seq, SHIP, "Process is restarting", 5_000, 1_000);
      expect(heads()).toEqual([person.seq, loose.seq]);
      expect(events.dueHead(SHIP, "background", 1_000)).toBeNull();
      expect(events.nextDueAt()).toBe(0);

      events.delivered(person.seq, SHIP, { runId: "run:person", outcome: { pid: "proc:ship", queued: false } }, 1_000);
      events.withdrawn(loose.seq, SHIP, "subject withdrew it", 1_000);
      expect(events.nextDueAt()).toBe(5_000);
      expect(events.dueHeads(5_000).map(({ event, attemptCount }) => [event.seq, attemptCount])).toEqual([[first.seq, 1]]);

      events.delivered(first.seq, SHIP, { runId: null, outcome: {} }, 5_000);
      expect(events.dueHead(SHIP, "background", 5_000)?.event.seq).toBe(second.seq);
      expect(events.delivery(person.seq, SHIP)).toMatchObject({ state: "delivered", runId: "run:person", outcome: { pid: "proc:ship", queued: false } });
      expect(events.delivery(loose.seq, SHIP)).toMatchObject({ state: "withdrawn", lastError: "subject withdrew it" });
      expect(events.delivery(first.seq, SHIP)).toMatchObject({ state: "delivered", attemptCount: 1, lastError: "Process is restarting" });
    });
  });

  it("ends a delivery that runs out of attempts as failed", async () => {
    await runWithRealKernelSql((_sql, storage) => {
      const events = new EventStore(storage);
      const event = events.append(input("doomed"), [ship("background")], 0).event;
      events.failed(event.seq, SHIP, "no such consumer", null, 10);
      expect(events.delivery(event.seq, SHIP)).toMatchObject({ state: "failed", attemptCount: 1, lastError: "no such consumer" });
      expect(events.nextDueAt()).toBeNull();
    });
  });

  it("keeps a key after its body, and an event while a delivery is pending", async () => {
    await runWithRealKernelSql((_sql, storage) => {
      const events = new EventStore(storage);
      const done = events.append(input("done"), [ship("background")], 0).event;
      const waiting = events.append(input("waiting"), [ship("person")], 0).event;
      events.delivered(done.seq, SHIP, { runId: null, outcome: {} }, 1);
      expect(events.nextPruneAt()).toBe(EVENT_BODY_RETENTION_MS);

      events.prune(EVENT_BODY_RETENTION_MS);
      expect(events.delivery(done.seq, SHIP)).toBeNull();
      expect(events.event(done.seq)).toMatchObject({ key: "done", body: null });
      expect(events.append(input("done"), [ship("background")], EVENT_BODY_RETENTION_MS).appended).toBe(false);
      expect(events.event(waiting.seq)).toMatchObject({ body: { key: "waiting" } });
      expect(events.delivery(waiting.seq, SHIP)).toMatchObject({ state: "pending" });
      expect(events.nextPruneAt()).toBe(EVENT_KEY_RETENTION_MS);

      events.prune(EVENT_KEY_RETENTION_MS);
      expect(events.event(done.seq)).toBeNull();
      expect(events.event(waiting.seq)).not.toBeNull();
      expect(events.append(input("done"), [], EVENT_KEY_RETENTION_MS).appended).toBe(true);
    });
  });

  it("appends nothing when the producer's transaction fails", async () => {
    await runWithRealKernelSql((_sql, storage) => {
      const events = new EventStore(storage);
      expect(() => storage.transactionSync(() => {
        events.append(input("rolled-back"), [ship("background")], 0);
        throw new Error("domain write failed");
      })).toThrow("domain write failed");
      expect(events.dueHeads(0)).toEqual([]);
      expect(events.append(input("rolled-back"), [], 0).appended).toBe(true);
    });
  });
});
