import { describe, expect, it } from "vitest";

import welcomeBrief from "../prompts/onboarding/welcome.md";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import { activateInitialOnboardingResponsibility, ensureInitialOnboardingResponsibility, INITIAL_ONBOARDING_DEDUPE_KEY } from "./onboarding-responsibility";
import { ResponsibilityStore } from "./responsibility-store";

describe("initial onboarding responsibility", () => {
  it.each(["waiting", "open", "resolved", "cancelled"] as const)("preserves an existing %s welcome verbatim", async (state) => {
    await runWithRealKernelSql((_sql, storage) => {
      const store = new ResponsibilityStore(storage);
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
      expect(ensureInitialOnboardingResponsibility(1000, store, 2_000))
        .toEqual({ ...existing, created: false });
      expect(activateInitialOnboardingResponsibility(1000, store, 3_000)).toBe(false);
      expect(store.get(1000, existing.record.id)).toEqual(existing.record);
      expect(store.revision(1000)).toBe(existing.revision);
      expect(store.nextWakeAt(1000, 3_000)).toBe(wake);
    });
  });

  it("keeps the welcome dormant until the user dismisses the card", async () => {
    await runWithRealKernelSql((_sql, storage) => {
      const responsibilities = new ResponsibilityStore(storage);
      const first = ensureInitialOnboardingResponsibility(1000, responsibilities, 1_000);
      const replay = ensureInitialOnboardingResponsibility(1000, responsibilities, 2_000);

      expect(first.created).toBe(true);
      expect(first.record).toMatchObject({
        ownerUid: 1000,
        title: "Welcome to Ship",
        source: { kind: "system", component: "onboarding" },
        assignee: { kind: "ship" },
        state: "waiting",
        priority: "high",
        blocker: "Waiting for the user to dismiss the welcome card.",
        details: { responsibilityType: "onboarding.initial" },
      });
      expect(first.record.details?.instructions).toBe(welcomeBrief.trim());
      expect(replay).toEqual({
        record: first.record,
        created: false,
        revision: first.revision,
      });
      expect(responsibilities.nextWakeAt(1000, 2_000)).toBeNull();
    });
  });

  it("activates once and never reopens a welcome already handled or edited", async () => {
    await runWithRealKernelSql((_sql, storage) => {
      const store = new ResponsibilityStore(storage);
      const seed = ensureInitialOnboardingResponsibility(1000, store, 1_000).record;
      expect(activateInitialOnboardingResponsibility(1000, store, 2_000)).toBe(true);
      expect(store.get(1000, seed.id)).toMatchObject({ state: "open" });
      expect(store.get(1000, seed.id)?.blocker).toBeUndefined();
      expect(store.nextWakeAt(1000, 2_000)).toBe(2_000);
      const revision = store.revision(1000);
      expect(activateInitialOnboardingResponsibility(1000, store, 3_000)).toBe(true);
      expect(store.revision(1000)).toBe(revision);
      const batch = store.createReadyBatch(1000, 3_000)!;
      expect(batch.responsibilities.map(({ id }) => id)).toEqual([seed.id]);
      store.markBatchDelivered(batch.id);
      store.update({ ownerUid: 1000, id: seed.id,
        patch: { state: "waiting", blocker: "Waiting for the user to respond to the welcome", nextCheckAtMs: null },
        actor: { kind: "process", processId: "ship" }, observedByShip: true, now: 4_000 });
      expect(activateInitialOnboardingResponsibility(1000, store, 5_000)).toBe(false);
      expect(store.nextWakeAt(1000, 5_000)).toBeNull();
      const edited = ensureInitialOnboardingResponsibility(1001, store, 1_000).record;
      store.update({ ownerUid: 1001, id: edited.id, patch: { title: "My welcome" },
        actor: { kind: "account", uid: 1001 }, observedByShip: true, now: 2_000 });
      expect(activateInitialOnboardingResponsibility(1001, store, 3_000)).toBe(false);
      expect(store.get(1001, edited.id)).toMatchObject({ title: "My welcome", state: "waiting" });
      expect(activateInitialOnboardingResponsibility(1002, store, 3_000)).toBe(false);
      expect(store.getByDedupeKey(1002, INITIAL_ONBOARDING_DEDUPE_KEY)).toBeNull();
    });
  });

});
