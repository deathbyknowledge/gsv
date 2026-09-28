import { describe, expect, it, vi } from "vitest";

import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import { ensureInitialOnboardingResponsibility } from "./onboarding-responsibility";
import { emitOnboardingCompleted } from "./onboarding-telemetry";
import { ResponsibilityStore } from "./responsibility-store";

describe("initial onboarding responsibility", () => {
  it("creates one non-waking Ship responsibility for the owner", async () => {
    await runWithRealKernelSql((_sql, storage) => {
      const responsibilities = new ResponsibilityStore(storage);
      const first = ensureInitialOnboardingResponsibility(1000, responsibilities, 1_000);
      const replay = ensureInitialOnboardingResponsibility(1000, responsibilities, 2_000);

      expect(first.created).toBe(true);
      expect(first.record).toMatchObject({
        ownerUid: 1000,
        title: "Welcome to GSV",
        source: { kind: "system", component: "onboarding" },
        assignee: { kind: "ship" },
        state: "waiting",
        priority: "high",
        blocker: "Waiting for the user's first messages.",
        details: {
          responsibilityType: "onboarding.initial",
          completionCondition: "The user has experienced one completed task beyond conversation, such as connecting a machine, browser, messenger, or integration, sending an email, creating, editing, or deleting files, or creating a reminder.",
        },
      });
      expect(replay).toEqual({
        record: first.record,
        created: false,
        revision: first.revision,
      });
      expect(responsibilities.nextWakeAt(1000, 2_000)).toBeNull();
    });
  });

  it("reports onboarding.completed once when the Ship resolves it, never for other work", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runWithRealKernelSql((_sql, storage) => {
      const emitted: unknown[] = [];
      const responsibilities = new ResponsibilityStore(storage, undefined, (record) => {
        if (emitOnboardingCompleted({ env: { GSV_TELEMETRY_ENABLED: "1" }, installationId: "inst_onboarding" }, record)) {
          emitted.push(record.id);
        }
      });
      const onboarding = ensureInitialOnboardingResponsibility(1000, responsibilities, 1_000).record;
      const other = responsibilities.create({
        ownerUid: 1000,
        title: "Send the weekly note",
        source: { kind: "system", component: "test" },
        assignee: { kind: "ship" },
        state: "active",
        priority: "normal",
        actor: { kind: "system", component: "test" },
        observedByShip: true,
        now: 1_000,
      }).record;

      responsibilities.update({
        ownerUid: 1000,
        id: other.id,
        patch: { state: "resolved" },
        actor: { kind: "system", component: "test" },
        observedByShip: true,
        now: 2_000,
      });
      responsibilities.update({
        ownerUid: 1000,
        id: onboarding.id,
        patch: { state: "resolved", resolution: { conceptsIntroduced: ["approval", "routine"] } },
        actor: { kind: "process", processId: "ship-1" },
        observedByShip: true,
        now: 421_000,
      });

      expect(emitted).toEqual([onboarding.id]);
      expect(log).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith(expect.objectContaining({
        installationId: "inst_onboarding",
        component: "gateway",
        event: {
          stream: "product",
          name: "onboarding.completed",
          properties: { durationMs: 420_000, conceptsCount: 2 },
        },
      }));
      });
    } finally {
      log.mockRestore();
    }
  });
});
