import { afterEach, describe, expect, it, vi } from "vitest";
import type { DurableTaskOptions } from "../../shared/durable-tasks";
import * as processTransport from "../../shared/utils";
import { runWithRealKernelSql } from "../../test-support/real-kernel-sql";
import * as personalController from "../personal-controller";
import { processConsumer, shipConsumer, type EventRegistry } from "./registry";
import { EventRuntime, type EventRuntimeHost } from "./runtime";
import { EventStore, type EventInput } from "./store";

const OWNER = 1000;
const WATCHER = "proc:watcher";
let subjectWanted = true;

const NOTICE_ADMISSION = { idle: "record", busy: "join" } as const;
const WATCH_ADMISSION = { idle: "start", busy: "join" } as const;

/** Two fixture types: one for the owner's Ship, one for a watching process. */
const REGISTRY: EventRegistry = {
  "fixture.noticed": {
    routes: (event) => [{ consumer: shipConsumer(event.ownerUid), lane: event.subject === "fixture:person" ? "person" : "background" }],
    process: (event) => ({
      event: {
        kind: "owner.notified", severity: "info", audience: "model",
        payload: { noticeId: event.key, topic: "event.received", from: "Fixture", preview: event.key },
      },
      admission: NOTICE_ADMISSION,
    }),
    wanted: () => subjectWanted,
  },
  "fixture.watched": {
    routes: () => [{ consumer: processConsumer(WATCHER), lane: "watch" }],
    process: () => ({
      event: {
        kind: "target.connection", severity: "info", audience: "model",
        payload: { targetId: "laptop", platform: "linux", event: "connected", observedAt: 1 },
      },
      admission: WATCH_ADMISSION,
    }),
  },
};

function noticed(key: string, subject = "fixture:background"): EventInput {
  return { type: "fixture.noticed", ownerUid: OWNER, subject, actor: { kind: "kernel" }, key };
}

afterEach(() => {
  subjectWanted = true;
  vi.restoreAllMocks();
});

describe("event runtime", () => {
  it("delivers an event to the owner's current Ship with its declared admission", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { runtime, events, schedule } = fixture(storage);
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
  const host = {
    installationId: "installation:test",
    events,
    auth: { isAccountDisabled: (uid: number) => disabled.has(uid) },
    procs: { get: (pid: string) => processes.get(pid) ?? null },
    onboarding: { managedWorkGate: gate },
    buildKernelContext: () => ({}),
    schedule,
    cancelSchedule: vi.fn(async (_id: string) => true),
  };
  // SAFETY: EventRuntime reaches only these Kernel members.
  const runtime = new EventRuntime(host as EventRuntimeHost, registry);
  return { host, runtime, events, schedule, disabled, processes, gate };
}

function acknowledge() {
  return vi.spyOn(processTransport, "deliverEventToProcess").mockImplementation(async (_installationId, _pid, args) => (
    { eventId: args.eventId, runId: null, queued: false }
  ));
}
