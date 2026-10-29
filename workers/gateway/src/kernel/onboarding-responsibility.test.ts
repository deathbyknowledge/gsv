import { describe, expect, it } from "vitest";

import welcomeBrief from "../prompts/onboarding/welcome.md";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import { InitialOnboarding, INITIAL_ONBOARDING_DEDUPE_KEY } from "./onboarding-responsibility";
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

});

describe("welcome timing", () => {
  it("records when the welcome opened and measures its first delivery once", async () => {
    await runWithRealKernelSql((_sql, storage) => {
      const store = new ResponsibilityStore(storage);
      const activations: number[] = [];
      const welcome = new InitialOnboarding(storage, store, (uid) => activations.push(uid));
      expect(welcome.markWelcomeDelivered(1000, 500)).toBeNull();
      welcome.prepare(1000, 1_000);
      expect(welcome.activate(1000, 2_000)).toBe(true);
      expect(activations).toEqual([1000]);
      expect(welcome.activate(1000, 3_000)).toBe(true);
      expect(activations).toEqual([1000]);
      expect(welcome.markWelcomeDelivered(1000, 56_000)).toBe(54_000);
      expect(welcome.markWelcomeDelivered(1000, 70_000)).toBeNull();
      expect(welcome.createdAt(1000)).toBe(1_000);
    });
  });

  it("times a welcome created by the previous runtime from its activation, not its seed", async () => {
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
