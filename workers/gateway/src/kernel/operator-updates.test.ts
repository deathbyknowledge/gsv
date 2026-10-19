import { describe, expect, it } from "vitest";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import { InitialOnboarding } from "./onboarding-responsibility";
import { reconcileOperatorUpdates } from "./operator-updates";
import { ResponsibilityStore } from "./responsibility-store";

const configuration = JSON.stringify({
  publisher: { id: "example-operator", name: "Example Operator" },
  updates: [{ id: "product-name", publishedAtMs: 2_000, title: "A new product name", brief: "Explain the new name at a suitable moment." }],
});
const key = "operator.update:example-operator:product-name";

describe("operator update responsibilities", () => {
  it("reconciles once without waking Ship, including after resolution and store recreation", async () => {
    await runWithRealKernelSql((_sql, storage) => {
      const store = new ResponsibilityStore(storage);
      const welcome = new InitialOnboarding(storage, store);
      welcome.prepare(1000, 1_000);
      reconcileOperatorUpdates(1000, store, configuration, 3_000, welcome.createdAt(1000));
      const record = store.getByDedupeKey(1000, key)!;
      expect(record).toMatchObject({ state: "waiting", assignee: { kind: "ship" },
        details: { publisher: { id: "example-operator" }, updateId: "product-name" } });
      expect(store.nextWakeAt(1000, 3_000)).toBeNull();
      reconcileOperatorUpdates(1000, new ResponsibilityStore(storage), configuration, 4_000);
      expect(store.getByDedupeKey(1000, key)).toEqual(record);
      const resolved = store.update({ ownerUid: 1000, id: record.id, patch: { state: "resolved", resolution: { summary: "Explained to the user" } },
        actor: { kind: "system", component: "test" }, observedByShip: true, now: 5_000 }).record;
      reconcileOperatorUpdates(1000, new ResponsibilityStore(storage), configuration, 6_000);
      expect(store.getByDedupeKey(1000, key)).toEqual(resolved);
      expect(store.getByDedupeKey(1001, key)).toBeNull();
    });
  });

  it("keeps the signup cutoff when onboarding starts after a release", async () => {
    await runWithRealKernelSql((_sql, storage) => {
      const store = new ResponsibilityStore(storage);
      const welcome = new InitialOnboarding(storage, store);
      welcome.prepare(1000, 1_000);
      welcome.activate(1000, 3_000);
      reconcileOperatorUpdates(1000, store, configuration, 4_000, welcome.createdAt(1000));
      expect(store.getByDedupeKey(1000, key)).not.toBeNull();
    });
  });

  it("skips future and historical updates for new owners but includes owners predating onboarding records", async () => {
    await runWithRealKernelSql((_sql, storage) => {
      const store = new ResponsibilityStore(storage);
      reconcileOperatorUpdates(1000, store, configuration, 1_000);
      expect(store.getByDedupeKey(1000, key)).toBeNull();
      const welcome = new InitialOnboarding(storage, store);
      welcome.prepare(1001, 2_000);
      reconcileOperatorUpdates(1001, store, configuration, 3_000, welcome.createdAt(1001));
      expect(store.getByDedupeKey(1001, key)).toBeNull();
      reconcileOperatorUpdates(1000, store, configuration, 3_000);
      expect(store.getByDedupeKey(1000, key)).not.toBeNull();
    });
  });
});
