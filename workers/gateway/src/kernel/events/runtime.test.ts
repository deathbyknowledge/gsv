import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { DurableTaskOptions } from "../../shared/durable-tasks";
import * as processTransport from "../../shared/utils";
import { runWithRealKernelSql } from "../../test-support/real-kernel-sql";
import * as personalController from "../personal-controller";
import { ResponsibilityStore } from "../responsibility-store";
import { processConsumer, shipConsumer } from "./consumers";
import type { EventRegistry, Withdrawn } from "./registry";
import { EventRuntime, type EventRuntimeHost } from "./runtime";
import { EVENT_BODY_RETENTION_MS, EventStore, type EventInput } from "./store";

const OWNER = 1000;
const WATCHER = "proc:watcher";
let subjectWanted = true;
let prepared: { text: string } | Withdrawn = { text: "prepared" };
const settledKeys: string[] = [];

const NOTICE_ADMISSION = { idle: "record", busy: "join" } as const;
const WATCH_ADMISSION = { idle: "start", busy: "join" } as const;
const actor = { kind: "system", component: "test" } as const;

/** Fixture types: two for the owner's Ship, one for a watching process. */
const REGISTRY = {
  "fixture.noticed": {
    routes: (event) => [{ consumer: shipConsumer(event.ownerUid), lane: event.subject === "fixture:person" ? "person" : "background" }],
    withdrawal: () => subjectWanted ? null : "its subject no longer wants it",
    admit: (event) => ({
      event: {
        kind: "owner.notified", severity: "info", audience: "model",
        payload: { noticeId: event.key, topic: "event.received", from: "Fixture", preview: event.key },
      },
      admission: NOTICE_ADMISSION,
    }),
  },
  "fixture.watched": {
    routes: () => [{ consumer: processConsumer(WATCHER), lane: "watch" }],
    admit: () => ({
      event: {
        kind: "target.connection", severity: "info", audience: "model",
        payload: { targetId: "laptop", platform: "linux", event: "connected", observedAt: 1 },
      },
      admission: WATCH_ADMISSION,
    }),
  },
  /** Kept for its producer to read back; it goes to no one. */
  "fixture.recorded": {
    routes: () => [],
    admit: () => ({ withdrawn: "a recorded event goes to no one" }),
  },
  /** Tells its producer when each delivery ends, as the ledger's events do. */
  "fixture.settled": {
    routes: (event) => [{ consumer: shipConsumer(event.ownerUid), lane: "background" }],
    withdrawal: () => subjectWanted ? null : "its subject no longer wants it",
    admit: (event) => ({
      event: {
        kind: "owner.notified", severity: "info", audience: "model",
        payload: { noticeId: event.key, topic: "event.received", from: "Fixture", preview: event.key },
      },
      admission: NOTICE_ADMISSION,
    }),
    settled: async (event) => {
      settledKeys.push(event.key);
      if (event.key === "unheard") throw new Error("The producer could not follow up");
    },
  },
  /** Reads its content elsewhere, and hands its Ship the responsibility named in its body. */
  "fixture.prepared": {
    routes: (event) => [{ consumer: shipConsumer(event.ownerUid), lane: "background" }],
    prepare: async () => prepared,
    admit: (event, content: { text: string }) => ({
      event: {
        kind: "owner.notified", severity: "info", audience: "model",
        payload: { noticeId: event.key, topic: "event.received", from: "Fixture", preview: content.text },
      },
      admission: WATCH_ADMISSION,
      responsibilities: { ledgerRevision: 7, ids: [z.string().parse(event.body)] },
    }),
  },
} satisfies EventRegistry;

function noticed(key: string, subject = "fixture:background"): EventInput {
  return { type: "fixture.noticed", ownerUid: OWNER, subject, actor: { kind: "kernel" }, key };
}

afterEach(() => {
  subjectWanted = true;
  settledKeys.length = 0;
  prepared = { text: "prepared" };
  vi.restoreAllMocks();
});

describe("event runtime", () => {
  it("arms for what the log has due next, so a kick for an event no one receives waits for its retention", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { runtime, schedule } = fixture(storage);
      const event = storage.transactionSync(() => runtime.append({
        type: "fixture.recorded", ownerUid: OWNER, subject: "fixture:recorded", actor: { kind: "kernel" }, key: "kept", body: { kept: true },
      }));
      await runtime.kick();
      expect(schedule).toHaveBeenCalledTimes(1);
      expect(schedule.mock.calls[0]?.[0].getTime()).toBe(event.createdAt + EVENT_BODY_RETENTION_MS);
    });
  });

  it("delivers an event to the owner's current Ship with its declared admission", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { host, runtime, events, schedule } = fixture(storage);
      const ensure = vi.spyOn(personalController, "ensurePersonalController").mockResolvedValue("proc:ship");
      const deliver = acknowledge();
      const event = storage.transactionSync(() => runtime.append(noticed("one")));
      await runtime.kick();
      expect(schedule).toHaveBeenCalledWith(expect.any(Date), "onEvents", null, { idempotent: true });

      await runtime.onEvents({ id: "task:one" });
      expect(ensure).toHaveBeenCalledWith(OWNER, expect.anything());
      expect(deliver).toHaveBeenCalledWith("installation:test", "proc:ship", {
        eventId: `${event.id}:personal:${OWNER}`,
        event: expect.objectContaining({ kind: "owner.notified", payload: expect.objectContaining({ noticeId: "one" }) }),
        admission: NOTICE_ADMISSION,
      });
      expect(events.delivery(event.seq, shipConsumer(OWNER))).toMatchObject({
        state: "delivered", runId: null, outcome: { pid: "proc:ship", queued: false },
      });
      expect(host).not.toHaveProperty("responsibilityRuntime");
    });
  });

  it("appends once per key and refuses an unregistered type", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { runtime, events } = fixture(storage);
      const first = runtime.append(noticed("same"));
      expect(runtime.append(noticed("same"))).toEqual(first);
      expect(events.dueHeads(Date.now())).toHaveLength(1);
      expect(() => runtime.append({ ...noticed("other"), type: "fixture.unknown" })).toThrow("Event type fixture.unknown is not registered");
    });
  });

  it("retries a failed delivery with backoff and holds its lane while the person lane goes on", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { runtime, events, schedule } = fixture(storage);
      vi.spyOn(personalController, "ensurePersonalController").mockResolvedValue("proc:ship");
      const deliver = acknowledge();
      deliver.mockRejectedValueOnce(new Error("Process is restarting"));
      const first = runtime.append(noticed("first"));
      const second = runtime.append(noticed("second"));
      const person = runtime.append(noticed("person", "fixture:person"));

      const before = Date.now();
      await runtime.onEvents({ id: "task:first" });
      const ship = shipConsumer(OWNER);
      expect(events.delivery(first.seq, ship)).toMatchObject({ state: "pending", attemptCount: 1, lastError: "Process is restarting" });
      expect(events.delivery(second.seq, ship)).toMatchObject({ state: "pending", attemptCount: 0 });
      expect(events.delivery(person.seq, ship)).toMatchObject({ state: "delivered" });
      const retryAt = events.delivery(first.seq, ship)!.nextAttemptAt;
      expect(retryAt).toBeGreaterThanOrEqual(before + 2_000);
      expect(retryAt).toBeLessThanOrEqual(Date.now() + 2_000);
      expect(schedule).toHaveBeenLastCalledWith(new Date(retryAt), "onEvents", null, { idempotent: true, excludeTaskId: "task:first" });

      storage.sql.exec("UPDATE deliveries SET next_attempt_at = 0 WHERE seq = ?", first.seq);
      await runtime.onEvents({ id: "task:retry" });
      expect(deliver.mock.calls.map(([, , args]) => args.eventId.split(":")[0])).toEqual([first.id, person.id, first.id, second.id]);
      expect(events.delivery(second.seq, ship)).toMatchObject({ state: "delivered" });
    });
  });

  it("counts an unavailable Process as a failed attempt", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { runtime, events, processes } = fixture(storage);
      processes.set(WATCHER, { uid: 2000, ownerUid: OWNER });
      acknowledge().mockResolvedValueOnce({ unavailable: "transitioning", message: "Process lifecycle is resetting" });
      const event = runtime.append({ ...noticed("watched"), type: "fixture.watched" });
      await runtime.onEvents({ id: "task:watch" });
      expect(events.delivery(event.seq, processConsumer(WATCHER))).toMatchObject({
        state: "pending", attemptCount: 1, lastError: "Process lifecycle is resetting",
      });
    });
  });

  it.each([
    ["the owner's account was removed", (state: Fixture) => state.disabled.add(OWNER)],
    ["the process is gone", (state: Fixture) => state.processes.delete(WATCHER)],
    ["the process's account was removed", (state: Fixture) => state.disabled.add(2000)],
  ] as const)("withdraws a process delivery once %s, without calling it", async (reason, change) => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const state = fixture(storage);
      state.processes.set(WATCHER, { uid: 2000, ownerUid: OWNER });
      const deliver = acknowledge();
      const event = state.runtime.append({ ...noticed("watched"), type: "fixture.watched" });
      change(state);
      await state.runtime.onEvents({ id: "task:withdraw" });
      expect(deliver).not.toHaveBeenCalled();
      expect(state.events.delivery(event.seq, processConsumer(WATCHER))).toMatchObject({ state: "withdrawn", lastError: reason });
    });
  });

  it("retries a delivery already attempted when its owner's account is removed, since its Process may have it", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { runtime, events, disabled } = fixture(storage);
      vi.spyOn(personalController, "ensurePersonalController").mockResolvedValue("proc:ship");
      const deliver = acknowledge();
      const attempted = runtime.append(noticed("attempted"));
      events.failed(attempted.seq, shipConsumer(OWNER), "Saved event response was lost", Date.now(), Date.now());
      const fresh = runtime.append(noticed("fresh", "fixture:person"));
      disabled.add(OWNER);
      await runtime.onEvents({ id: "task:removed" });
      expect(deliver).toHaveBeenCalledExactlyOnceWith("installation:test", "proc:ship", expect.objectContaining({
        eventId: `${attempted.id}:personal:${OWNER}`,
      }));
      expect(events.delivery(attempted.seq, shipConsumer(OWNER))).toMatchObject({ state: "delivered" });
      expect(events.delivery(fresh.seq, shipConsumer(OWNER))).toMatchObject({ state: "withdrawn", lastError: "the owner's account was removed" });
    });
  });

  it("reads withdrawal again after resolving the Ship", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { runtime, events } = fixture(storage);
      const deliver = acknowledge();
      vi.spyOn(personalController, "ensurePersonalController").mockImplementation(async () => {
        subjectWanted = false;
        return "proc:ship";
      });
      const event = runtime.append(noticed("withdrawn"));
      await runtime.onEvents({ id: "task:late" });
      expect(deliver).not.toHaveBeenCalled();
      expect(events.delivery(event.seq, shipConsumer(OWNER))).toMatchObject({ state: "withdrawn", lastError: "its subject no longer wants it" });
    });
  });

  it("reads what a delivery needs before finding the Ship, and withdraws without one when it is gone", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { runtime, events } = fixture(storage);
      prepared = { withdrawn: "the message is gone" };
      const ensure = vi.spyOn(personalController, "ensurePersonalController");
      const deliver = acknowledge();
      const event = runtime.append({ ...noticed("gone"), type: "fixture.prepared" });
      await runtime.onEvents({ id: "task:gone" });
      expect(ensure).not.toHaveBeenCalled();
      expect(deliver).not.toHaveBeenCalled();
      expect(events.delivery(event.seq, shipConsumer(OWNER))).toMatchObject({ state: "withdrawn", lastError: "the message is gone" });
    });
  });

  it("hands the Process what was prepared, and arms recovery for the responsibilities the delivery carries", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { runtime, events, responsibilities } = fixture(storage);
      const work = responsibilities.create({ ownerUid: OWNER, title: "Reply to Remote", source: actor, actor,
        assignee: { kind: "ship" }, state: "open", priority: "normal", observedByShip: false, announced: true, now: Date.now() }).record;
      expect(responsibilities.nextWakeAt(OWNER, Date.now())).toBeNull();
      vi.spyOn(personalController, "ensurePersonalController").mockResolvedValue("proc:ship");
      const deliver = acknowledge();
      const event = runtime.append({ ...noticed("carried"), type: "fixture.prepared", body: work.id });
      const before = Date.now();
      await runtime.onEvents({ id: "task:carried" });
      expect(deliver).toHaveBeenCalledWith("installation:test", "proc:ship", {
        eventId: `${event.id}:personal:${OWNER}`,
        event: expect.objectContaining({ payload: expect.objectContaining({ preview: "prepared" }) }),
        admission: WATCH_ADMISSION,
        responsibilities: { ledgerRevision: 7, ids: [work.id] },
      });
      expect(events.delivery(event.seq, shipConsumer(OWNER))).toMatchObject({ state: "delivered" });
      expect(responsibilities.takeReadyBatch(OWNER, Date.now())).toBeNull();
      // The handed work recovers five minutes after the delivery, if its run never settles it.
      const recoveryAt = responsibilities.nextWakeAt(OWNER, Date.now());
      expect(recoveryAt).toBeGreaterThanOrEqual(before + 5 * 60_000);
      expect(recoveryAt).toBeLessThanOrEqual(Date.now() + 5 * 60_000);
    });
  });

  it("tells the producer once each delivery ends, delivered or withdrawn, and keeps a delivery its producer couldn't follow up", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { runtime, events } = fixture(storage);
      vi.spyOn(personalController, "ensurePersonalController").mockResolvedValue("proc:ship");
      const deliver = acknowledge();
      deliver.mockRejectedValueOnce(new Error("Process is restarting"));
      const retried = runtime.append({ ...noticed("retried"), type: "fixture.settled" });
      await runtime.onEvents({ id: "task:retried" });
      expect(settledKeys).toEqual([]);
      storage.sql.exec("UPDATE deliveries SET next_attempt_at = 0 WHERE seq = ?", retried.seq);
      await runtime.onEvents({ id: "task:retry" });
      expect(settledKeys).toEqual(["retried"]);

      subjectWanted = false;
      runtime.append({ ...noticed("withdrawn"), type: "fixture.settled" });
      await runtime.onEvents({ id: "task:withdrawn" });
      expect(settledKeys).toEqual(["retried", "withdrawn"]);

      subjectWanted = true;
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const unheard = runtime.append({ ...noticed("unheard"), type: "fixture.settled" });
      await runtime.onEvents({ id: "task:unheard" });
      expect(settledKeys).toEqual(["retried", "withdrawn", "unheard"]);
      expect(events.delivery(unheard.seq, shipConsumer(OWNER))).toMatchObject({ state: "delivered" });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(unheard.id), "The producer could not follow up");
    });
  });

  it("lists an owner's pending deliveries about one subject, and lets their producer withdraw one", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { runtime, events } = fixture(storage);
      const first = runtime.append(noticed("first", "fixture:subject"));
      runtime.append(noticed("other", "fixture:other"));
      const second = runtime.append(noticed("second", "fixture:subject"));
      const pending = runtime.pending("fixture.noticed", "fixture:subject");
      expect(pending.map(({ event }) => event.key)).toEqual(["first", "second"]);
      runtime.withdraw(pending[0]!, "the person took over");
      expect(events.delivery(first.seq, shipConsumer(OWNER))).toMatchObject({ state: "withdrawn", lastError: "the person took over" });
      expect(runtime.pending("fixture.noticed", "fixture:subject").map(({ event }) => event.seq)).toEqual([second.seq]);
      expect(events.backlog(shipConsumer(OWNER))).toEqual({ queued: 2, oldestQueuedAt: expect.any(Number) });
    });
  });

  it("parks every delivery while the managed gate is closed", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { runtime, events, schedule, gate } = fixture(storage);
      gate.mockResolvedValue({ allowed: false, code: 423, message: "Installation is restricted" });
      const deliver = acknowledge();
      const event = runtime.append(noticed("parked"));
      const before = Date.now();
      await runtime.onEvents({ id: "task:parked" });
      expect(deliver).not.toHaveBeenCalled();
      expect(events.delivery(event.seq, shipConsumer(OWNER))).toMatchObject({ state: "pending", attemptCount: 0 });
      const [when, , , options] = schedule.mock.lastCall!;
      expect(when.getTime()).toBeGreaterThanOrEqual(before + 60_000);
      expect(options).toEqual({ idempotent: true, excludeTaskId: "task:parked" });
    });
  });

  it("ends a delivery of a type the registry no longer has as failed", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { runtime, events } = fixture(storage);
      const deliver = acknowledge();
      const { event } = events.append({ ...noticed("retired"), type: "fixture.retired" }, [{ consumer: shipConsumer(OWNER), lane: "background" }], Date.now());
      await runtime.onEvents({ id: "task:retired" });
      expect(deliver).not.toHaveBeenCalled();
      expect(events.delivery(event.seq, shipConsumer(OWNER))).toMatchObject({ state: "failed", lastError: "Event type fixture.retired is not registered" });
    });
  });

  it("runs one pass at a time, so a lane never receives the same row twice", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { runtime, events } = fixture(storage);
      vi.spyOn(personalController, "ensurePersonalController").mockResolvedValue("proc:ship");
      const release = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      const deliver = acknowledge();
      deliver.mockImplementationOnce(async (_installationId, _pid, args) => {
        entered.resolve();
        await release.promise;
        return { eventId: args.eventId, runId: null, queued: false };
      });
      const event = runtime.append(noticed("slow"));
      const first = runtime.onEvents({ id: "task:first" });
      await entered.promise;
      await runtime.onEvents({ id: "task:second" });
      release.resolve();
      await first;
      expect(deliver).toHaveBeenCalledTimes(1);
      expect(events.delivery(event.seq, shipConsumer(OWNER))).toMatchObject({ state: "delivered" });
    });
  });

  it("tries again a minute later when a pass throws, so kicked work is not stranded", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { runtime, events, schedule, gate } = fixture(storage);
      gate.mockRejectedValueOnce(new Error("Installation directory is briefly unreachable"));
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const event = runtime.append(noticed("stranded"));
      const before = Date.now();
      await runtime.onEvents({ id: "task:unreachable" });
      expect(events.delivery(event.seq, shipConsumer(OWNER))).toMatchObject({ state: "pending", attemptCount: 0 });
      const [when, , , options] = schedule.mock.lastCall!;
      expect(when.getTime()).toBeGreaterThanOrEqual(before + 60_000);
      expect(options).toEqual({ idempotent: true, excludeTaskId: "task:unreachable" });
      expect(warn).toHaveBeenCalledWith("[Kernel] Event pass failed; trying again in a minute:", "Installation directory is briefly unreachable");
    });
  });

  it("lets every lane finish before a pass that hit an error ends", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { runtime, events, schedule } = fixture(storage);
      vi.spyOn(personalController, "ensurePersonalController").mockResolvedValue("proc:ship");
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const release = Promise.withResolvers<void>();
      const deliver = acknowledge();
      const background = runtime.append(noticed("background"));
      const person = runtime.append(noticed("person", "fixture:person"));
      deliver.mockImplementation(async (_installationId, _pid, args) => {
        if (args.eventId.startsWith(`${person.id}:`)) await release.promise;
        return { eventId: args.eventId, runId: null, queued: false };
      });
      const recorded = events.delivered.bind(events);
      vi.spyOn(events, "delivered").mockImplementation((seq, consumer, result, now) => {
        if (seq === background.seq) throw new Error("SQLITE_FULL: database or disk is full");
        recorded(seq, consumer, result, now);
      });
      let ended = false;
      const pass = runtime.onEvents({ id: "task:mixed" }).then(() => { ended = true; });
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(ended).toBe(false);
      release.resolve();
      await pass;
      expect(events.delivery(person.seq, shipConsumer(OWNER))).toMatchObject({ state: "delivered" });
      expect(events.delivery(background.seq, shipConsumer(OWNER))).toMatchObject({ state: "pending" });
      expect(schedule.mock.lastCall![3]).toEqual({ idempotent: true, excludeTaskId: "task:mixed" });
    });
  });

  it("records a delivery its Process received even when its producer withdrew it meanwhile", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { runtime, events } = fixture(storage);
      vi.spyOn(personalController, "ensurePersonalController").mockResolvedValue("proc:ship");
      const deliver = acknowledge();
      const event = runtime.append(noticed("raced", "fixture:subject"));
      deliver.mockImplementationOnce(async (_installationId, _pid, args) => {
        runtime.withdraw(runtime.pending("fixture.noticed", "fixture:subject")[0]!, "the person took over");
        return { eventId: args.eventId, runId: "run:raced", queued: false };
      });
      await runtime.onEvents({ id: "task:raced" });
      expect(events.delivery(event.seq, shipConsumer(OWNER))).toMatchObject({
        state: "delivered", runId: "run:raced", lastError: null,
      });
    });
  });

  it("prunes only once retention has work due, and not more than hourly", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { runtime, events } = fixture(storage);
      vi.spyOn(personalController, "ensurePersonalController").mockResolvedValue("proc:ship");
      vi.spyOn(console, "warn").mockImplementation(() => {});
      let restarting = true;
      const deliver = acknowledge();
      const prune = vi.spyOn(events, "prune");
      const nextPruneAt = vi.spyOn(events, "nextPruneAt");
      const ship = shipConsumer(OWNER);
      await runtime.recover();
      const first = runtime.append(noticed("first"));
      const stuck = runtime.append(noticed("stuck", "fixture:person"));
      deliver.mockImplementation(async (_installationId, _pid, args) => {
        if (restarting && args.eventId.startsWith(`${stuck.id}:`)) throw new Error("Process is restarting");
        return { eventId: args.eventId, runId: null, queued: false };
      });
      await runtime.onEvents({ id: "task:first" });
      await runtime.onEvents({ id: "task:again" });
      expect(prune).not.toHaveBeenCalled();
      expect(nextPruneAt).toHaveBeenCalledTimes(1);

      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(Date.now() + 31 * 24 * 60 * 60 * 1_000);
        await runtime.onEvents({ id: "task:month" });
        expect(prune).toHaveBeenCalledTimes(1);
        expect(events.delivery(first.seq, ship)).toBeNull();
        expect(events.delivery(stuck.seq, ship)).toMatchObject({ state: "pending" });

        // Settled long after it was appended, it is due at once, but retention waits for the hour.
        restarting = false;
        vi.setSystemTime(Date.now() + 5 * 60_000);
        await runtime.onEvents({ id: "task:settled" });
        expect(events.delivery(stuck.seq, ship)).toMatchObject({ state: "delivered" });
        expect(prune).toHaveBeenCalledTimes(1);

        vi.setSystemTime(Date.now() + 56 * 60_000);
        await runtime.onEvents({ id: "task:hour" });
        expect(prune).toHaveBeenCalledTimes(2);
        expect(events.delivery(stuck.seq, ship)).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("re-arms from stored deliveries when the Kernel starts", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { runtime, events, schedule } = fixture(storage);
      const event = runtime.append(noticed("stored"));
      events.failed(event.seq, shipConsumer(OWNER), "Process is restarting", Date.now() + 30_000, Date.now());
      await runtime.recover();
      expect(schedule).toHaveBeenLastCalledWith(new Date(events.nextDueAt()!), "onEvents", null, { idempotent: true });
    });
  });
});

type Fixture = ReturnType<typeof fixture>;

function fixture(storage: DurableObjectStorage, registry: EventRegistry = REGISTRY) {
  const events = new EventStore(storage);
  const schedule = vi.fn(async (when: Date, _callback: string, _payload: null, _options: DurableTaskOptions) =>
    ({ id: `task:${when.getTime()}`, time: Math.floor(when.getTime() / 1_000) }));
  const disabled = new Set<number>();
  const processes = new Map<string, { uid: number; ownerUid: number }>();
  const gate = vi.fn(async (): Promise<{ allowed: true } | { allowed: false; code: number; message: string }> => ({ allowed: true }));
  const responsibilities = new ResponsibilityStore(storage);
  const host = {
    installationId: "installation:test",
    events,
    responsibilities,
    auth: { isAccountDisabled: (uid: number) => disabled.has(uid) },
    procs: { get: (pid: string) => processes.get(pid) ?? null },
    onboarding: { managedWorkGate: gate },
    buildKernelContext: () => ({}),
    schedule,
    cancelSchedule: vi.fn(async (_id: string) => true),
  };
  // SAFETY: EventRuntime reaches only these Kernel members.
  const runtime = new EventRuntime(host as EventRuntimeHost, registry);
  return { host, runtime, events, responsibilities, schedule, disabled, processes, gate };
}

function acknowledge() {
  return vi.spyOn(processTransport, "deliverEventToProcess").mockImplementation(async (_installationId, _pid, args) => (
    { eventId: args.eventId, runId: null, queued: false }
  ));
}
