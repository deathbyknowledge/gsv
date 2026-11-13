import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";

import welcomeBrief from "../prompts/onboarding/welcome.md";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import type { Kernel } from "./do";
import { InitialOnboarding, INITIAL_ONBOARDING_DEDUPE_KEY, withInitialOnboarding } from "./onboarding-responsibility";
import { ResponsibilityStore } from "./responsibility-store";

describe("initial onboarding responsibility", () => {
  it.each(["waiting", "open", "resolved", "cancelled"] as const)("preserves an existing %s welcome verbatim", async (state) => {
    await runWithRealKernelSql((_sql, storage) => {
      const store = new ResponsibilityStore(storage);
      const welcome = new InitialOnboarding(storage, store);
      const existing = store.create({
        ownerUid: 1000,
        title: "Welcome to Ship",
        details: { responsibilityType: "onboarding.initial", instructions: "Previously saved onboarding instructions" },
        blocker: "Waiting for the user's first message. Follow the instructions in this responsibility's details before replying.",
        source: { kind: "system", component: "onboarding" },
        actor: { kind: "system", component: "onboarding" },
        assignee: { kind: "ship" }, state, priority: "high",
        dedupeKey: INITIAL_ONBOARDING_DEDUPE_KEY, observedByShip: true, now: 1_000,
      });
      const wake = store.nextWakeAt(1000, 3_000);
      welcome.prepare(1000, 2_000);
      expect(welcome.activate(1000, 3_000)).toBe(false);
      expect(store.get(1000, existing.record.id)).toEqual(existing.record);
      expect(store.revision(1000)).toBe(existing.revision);
      expect(store.nextWakeAt(1000, 3_000)).toBe(wake);
    });
  });

  it("keeps pending onboarding outside the ledger across restarts until activation", async () => {
    await runWithRealKernelSql((_sql, storage) => {
      const responsibilities = new ResponsibilityStore(storage);
      new InitialOnboarding(storage, responsibilities).prepare(1000, 1_000);
      const welcome = new InitialOnboarding(storage, responsibilities);
      welcome.prepare(1000, 2_000);
      expect(welcome.createdAt(1000)).toBe(1_000);
      expect(responsibilities.getByDedupeKey(1000, INITIAL_ONBOARDING_DEDUPE_KEY)).toBeNull();
      expect(responsibilities.revision(1000)).toBe(0);
      expect(responsibilities.nextWakeAt(1000, 2_000)).toBeNull();
      expect(welcome.activate(1000, 3_000)).toBe(true);
      const record = responsibilities.getByDedupeKey(1000, INITIAL_ONBOARDING_DEDUPE_KEY)!;
      expect(record).toMatchObject({
        ownerUid: 1000,
        title: "Welcome to Ship",
        source: { kind: "system", component: "onboarding" },
        assignee: { kind: "ship" },
        state: "open",
        priority: "high",
        details: { responsibilityType: "onboarding.initial" },
        createdAtMs: 3_000, updatedAtMs: 3_000, revision: 1,
      });
      expect(record.details?.instructions).toBe(welcomeBrief.trim());
      expect(record.blocker).toBeUndefined();
      expect(welcome.createdAt(1000)).toBe(1_000);
      welcome.prepare(1000, 4_000);
      expect(welcome.activate(1000, 4_000)).toBe(true);
      expect(responsibilities.get(1000, record.id)).toEqual(record);
    });
  });

  it("activates once and never reopens a welcome already handled or edited", async () => {
    await runWithRealKernelSql((_sql, storage) => {
      const store = new ResponsibilityStore(storage);
      const welcome = new InitialOnboarding(storage, store);
      welcome.prepare(1000, 1_000);
      expect(welcome.activate(1000, 2_000)).toBe(true);
      const seed = store.getByDedupeKey(1000, INITIAL_ONBOARDING_DEDUPE_KEY)!;
      expect(store.get(1000, seed.id)).toMatchObject({ state: "open" });
      expect(store.get(1000, seed.id)?.blocker).toBeUndefined();
      expect(store.nextWakeAt(1000, 2_000)).toBe(2_000);
      const revision = store.revision(1000);
      expect(welcome.activate(1000, 3_000)).toBe(true);
      expect(store.revision(1000)).toBe(revision);
      const batch = store.createReadyBatch(1000, 3_000)!;
      expect(batch.responsibilities.map(({ id }) => id)).toEqual([seed.id]);
      store.markBatchDelivered(batch.id);
      store.update({ ownerUid: 1000, id: seed.id,
        patch: { state: "waiting", blocker: "Waiting for the user to respond to the welcome", nextCheckAtMs: null },
        actor: { kind: "process", processId: "ship" }, observedByShip: true, now: 4_000 });
      expect(welcome.activate(1000, 5_000)).toBe(false);
      expect(store.nextWakeAt(1000, 5_000)).toBeNull();
      welcome.prepare(1001, 1_000);
      welcome.activate(1001, 1_001);
      const edited = store.getByDedupeKey(1001, INITIAL_ONBOARDING_DEDUPE_KEY)!;
      store.update({ ownerUid: 1001, id: edited.id, patch: { title: "My welcome" },
        actor: { kind: "account", uid: 1001 }, observedByShip: true, now: 2_000 });
      expect(welcome.activate(1001, 3_000)).toBe(false);
      expect(store.get(1001, edited.id)).toMatchObject({ title: "My welcome", state: "open" });
      expect(welcome.activate(1002, 3_000)).toBe(false);
      expect(store.getByDedupeKey(1002, INITIAL_ONBOARDING_DEDUPE_KEY)).toBeNull();
    });
  });

  it("still activates an untouched welcome created by the previous runtime", async () => {
    await runWithRealKernelSql((_sql, storage) => {
      const store = new ResponsibilityStore(storage);
      const seed = store.create({
        ownerUid: 1000, title: "Welcome to Ship",
        details: { responsibilityType: "onboarding.initial", instructions: welcomeBrief.trim() },
        blocker: "Waiting for the user to dismiss the welcome card.",
        source: { kind: "system", component: "onboarding" }, actor: { kind: "system", component: "onboarding" },
        assignee: { kind: "ship" }, state: "waiting", priority: "high",
        dedupeKey: INITIAL_ONBOARDING_DEDUPE_KEY, observedByShip: true, now: 1_000,
      }).record;
      const welcome = new InitialOnboarding(storage, store);
      welcome.prepare(1000, 2_000);
      expect(welcome.createdAt(1000)).toBe(1_000);
      expect(welcome.activate(1000, 3_000)).toBe(true);
      expect(store.get(1000, seed.id)).toMatchObject({ state: "open", details: seed.details });
      expect(store.get(1000, seed.id)?.blocker).toBeUndefined();
    });
  });

  it("opens the welcome before admitting a first message that arrives before sign-in did, and wakes after it", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const responsibilities = new ResponsibilityStore(storage);
      const welcome = new InitialOnboarding(storage, responsibilities);
      welcome.prepare(1000, 1_000);
      const order: string[] = [];
      const deferred: Promise<unknown>[] = [];
      const ctx = {
        welcome,
        reconcileResponsibilityWake: vi.fn(async () => { order.push("wake"); }),
        defer: (promise: Promise<unknown>) => { deferred.push(promise); },
      };
      await withInitialOnboarding(1000, ctx, async () => {
        order.push(`deliver:${responsibilities.getByDedupeKey(1000, INITIAL_ONBOARDING_DEDUPE_KEY)?.state}`);
      });
      await Promise.all(deferred);
      expect(order).toEqual(["deliver:open", "wake"]);
    });
  });
});

describe("welcome timing", () => {
  it("times the welcome from first sign-in to the first Ship message, once", async () => {
    await runWithRealKernelSql((_sql, storage) => {
      const store = new ResponsibilityStore(storage);
      const activations: number[] = [];
      const welcome = new InitialOnboarding(storage, store, (uid) => activations.push(uid));
      expect(welcome.markWelcomeDelivered(1000, 500)).toBeNull();
      welcome.prepare(1000, 1_000);
      // First sign-in opens the welcome; a later sign-in only recovers its wake.
      expect(welcome.activate(1000, 2_000)).toBe(true);
      expect(activations).toEqual([1000]);
      expect(welcome.activate(1000, 3_000)).toBe(true);
      expect(activations).toEqual([1000]);
      expect(welcome.markWelcomeDelivered(1000, 56_000)).toBe(54_000);
      expect(welcome.markWelcomeDelivered(1000, 70_000)).toBeNull();
      expect(welcome.createdAt(1000)).toBe(1_000);
    });
  });

  it("starts the timing at a first message that beats sign-in, and the later sign-in does not restart it", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const store = new ResponsibilityStore(storage);
      const activations: number[] = [];
      const welcome = new InitialOnboarding(storage, store, (uid) => activations.push(uid));
      welcome.prepare(1000, 1_000);
      const deferred: Promise<unknown>[] = [];
      const ctx = { welcome, reconcileResponsibilityWake: vi.fn(async () => {}), defer: (promise: Promise<unknown>) => { deferred.push(promise); } };
      await withInitialOnboarding(1000, ctx, async () => {});
      await Promise.all(deferred);
      expect(activations).toEqual([1000]);
      expect(welcome.activate(1000)).toBe(true);
      expect(activations).toEqual([1000]);
      expect(welcome.markWelcomeDelivered(1000)).not.toBeNull();
    });
  });

  it("times a waiting welcome seeded by the previous runtime from the sign-in that opens it, not its seed", async () => {
    await runWithRealKernelSql((_sql, storage) => {
      const store = new ResponsibilityStore(storage);
      store.create({
        ownerUid: 1000, title: "Welcome to Ship",
        details: { responsibilityType: "onboarding.initial", instructions: welcomeBrief.trim() },
        blocker: "Waiting for the user to dismiss the welcome card.",
        source: { kind: "system", component: "onboarding" }, actor: { kind: "system", component: "onboarding" },
        assignee: { kind: "ship" }, state: "waiting", priority: "high",
        dedupeKey: INITIAL_ONBOARDING_DEDUPE_KEY, observedByShip: true, now: 1_000,
      });
      const activations: number[] = [];
      const welcome = new InitialOnboarding(storage, store, (uid) => activations.push(uid));
      expect(welcome.activate(1000, 3_000)).toBe(true);
      expect(activations).toEqual([1000]);
      expect(welcome.markWelcomeDelivered(1000, 4_000)).toBe(1_000);
      expect(welcome.markWelcomeDelivered(1000, 5_000)).toBeNull();
    });
  });

  it("reports how the welcome ended once, with the time since it opened", async () => {
    await runWithRealKernelSql((_sql, storage) => {
      const store = new ResponsibilityStore(storage);
      const welcome = new InitialOnboarding(storage, store);
      welcome.prepare(1000, 1_000);
      welcome.activate(1000, 2_000);
      const actor = { kind: "system", component: "onboarding" } as const;
      const record = store.getByDedupeKey(1000, INITIAL_ONBOARDING_DEDUPE_KEY)!;
      // still open: nothing has ended
      expect(welcome.markWelcomeFinished(record)).toBeNull();
      // the first task Ship records is not the welcome, however it ends
      const task = store.create({
        ownerUid: 1000, title: "Friday plan", source: actor, actor, assignee: { kind: "ship" }, state: "open", priority: "normal",
        observedByShip: true, now: 3_000,
      });
      const taskDone = store.update({
        ownerUid: 1000, id: task.record.id, patch: { state: "resolved", resolution: { outcome: "connected" } }, actor, observedByShip: true, now: 4_000,
      });
      expect(welcome.markWelcomeFinished(taskDone.record)).toBeNull();

      const done = store.update({
        ownerUid: 1000, id: record.id, patch: { state: "resolved", resolution: { outcome: "messenger-declined" } }, actor, observedByShip: true, now: 422_000,
      });
      expect(welcome.markWelcomeFinished(done.record)).toEqual({ outcome: "messenger_declined", durationMs: 420_000 });
      expect(welcome.markWelcomeFinished(done.record)).toBeNull();
    });
  });

  it.each([
    [{ state: "resolved", resolution: { outcome: "connected" } }, "connected"],
    [{ state: "resolved", resolution: { outcome: "declined" } }, "declined"],
    [{ state: "resolved", resolution: { outcome: "They booked a table at Casa Montaña" } }, "other"],
    [{ state: "resolved", resolution: { outcome: 7 } }, "other"],
    [{ state: "resolved" }, "other"],
    [{ state: "cancelled", resolution: { outcome: "connected" } }, "cancelled"],
  ] as const)("classifies the ending %j as %s, from a closed list", async (patch, outcome) => {
    await runWithRealKernelSql((_sql, storage) => {
      const store = new ResponsibilityStore(storage);
      const welcome = new InitialOnboarding(storage, store);
      welcome.prepare(1000, 1_000);
      welcome.activate(1000, 2_000);
      const actor = { kind: "system", component: "onboarding" } as const;
      const record = store.getByDedupeKey(1000, INITIAL_ONBOARDING_DEDUPE_KEY)!;
      const done = store.update({ ownerUid: 1000, id: record.id, patch, actor, observedByShip: true, now: 5_000 });
      expect(welcome.markWelcomeFinished(done.record)).toEqual({ outcome, durationMs: 3_000 });
    });
  });

  it("never reports the ending of a welcome that opened before this record existed", async () => {
    await runWithRealKernelSql((_sql, storage) => {
      const store = new ResponsibilityStore(storage);
      const actor = { kind: "system", component: "onboarding" } as const;
      const seeded = store.create({
        ownerUid: 1000, title: "Welcome to Ship",
        details: { responsibilityType: "onboarding.initial", instructions: "Previously saved onboarding instructions" },
        source: actor, actor, assignee: { kind: "ship" }, state: "open", priority: "high",
        dedupeKey: INITIAL_ONBOARDING_DEDUPE_KEY, observedByShip: true, now: 1_000,
      });
      const welcome = new InitialOnboarding(storage, store);
      const done = store.update({ ownerUid: 1000, id: seeded.record.id, patch: { state: "resolved" }, actor, observedByShip: true, now: 9_000 });
      expect(welcome.markWelcomeFinished(done.record)).toBeNull();
    });
  });

  it("never times a welcome that was already handled before this record existed", async () => {
    await runWithRealKernelSql((_sql, storage) => {
      const store = new ResponsibilityStore(storage);
      store.create({
        ownerUid: 1000, title: "Welcome to Ship",
        details: { responsibilityType: "onboarding.initial", instructions: welcomeBrief.trim() },
        source: { kind: "system", component: "onboarding" }, actor: { kind: "system", component: "onboarding" },
        assignee: { kind: "ship" }, state: "resolved", priority: "high",
        dedupeKey: INITIAL_ONBOARDING_DEDUPE_KEY, observedByShip: true, now: 1_000,
      });
      const activations: number[] = [];
      const welcome = new InitialOnboarding(storage, store, (uid) => activations.push(uid));
      expect(welcome.activate(1000, 3_000)).toBe(false);
      expect(activations).toEqual([]);
      expect(welcome.markWelcomeDelivered(1000, 4_000)).toBeNull();
    });
  });
});

describe("welcome ending telemetry", () => {
  it("reports from the Kernel how the welcome ended, once, without the resolution's words", async () => {
    const stub = env.KERNEL.get(env.KERNEL.idFromName(crypto.randomUUID()));
    await runInDurableObject(stub, (kernel: Kernel) => {
      const bindings = vi.spyOn(kernel, "bindings", "get").mockReturnValue({ ...kernel.bindings, GSV_TELEMETRY_ENABLED: "1" });
      const emitted: unknown[] = [];
      const log = vi.spyOn(console, "log").mockImplementation((entry) => { emitted.push(entry); });
      const ship = { kind: "process", processId: "proc:ship" } as const;
      try {
        kernel.welcome.prepare(1000, 1_000);
        kernel.welcome.activate(1000, 2_000);
        const welcome = kernel.responsibilities.getByDedupeKey(1000, INITIAL_ONBOARDING_DEDUPE_KEY)!;
        const task = kernel.responsibilities.create({
          ownerUid: 1000, title: "Friday plan", source: ship, actor: ship, assignee: { kind: "ship" }, state: "open", priority: "normal",
          observedByShip: true, now: 3_000,
        });
        // the first task ending, and Ship waiting on the person, say nothing about the welcome
        kernel.responsibilities.update({
          ownerUid: 1000, id: task.record.id, patch: { state: "resolved", resolution: { outcome: "connected" } }, actor: ship, observedByShip: true, now: 4_000,
        });
        kernel.responsibilities.update({
          ownerUid: 1000, id: welcome.id, patch: { state: "waiting", blocker: "Waiting for the user to reply" }, actor: ship, observedByShip: true, now: 5_000,
        });
        kernel.responsibilities.update({
          ownerUid: 1000, id: welcome.id, patch: { state: "resolved", resolution: { outcome: "connected", note: "Friday plan for Valencia" } },
          actor: ship, observedByShip: true, now: 422_000,
        });
      } finally {
        log.mockRestore();
        bindings.mockRestore();
      }
      // SAFETY: the filter keeps only records whose event name matched, so the event is present.
      const finished = emitted.filter((entry: any) => entry?.event?.name === "onboarding.welcome.finished").map((entry: any) => entry.event);
      expect(finished).toEqual([{
        stream: "product", name: "onboarding.welcome.finished", properties: { outcome: "connected", durationMs: 420_000 },
      }]);
      expect(JSON.stringify(emitted)).not.toContain("Valencia");
    });
  });
});
