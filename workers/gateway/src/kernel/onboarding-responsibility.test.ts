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
          completionCondition: "The user has experienced one completed task beyond conversation, such as connecting a machine, browser, messenger, or integration, sending an email, creating, editing, or deleting files, or creating a reminder that can reach them even if they leave the website.",
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

  it("moves an unresolved record from the previous release onto the current contract", async () => {
    await runWithRealKernelSql((_sql, storage) => {
      const responsibilities = new ResponsibilityStore(storage);
      const previous = (ownerUid: number) => ({
        ownerUid,
        title: "Get to know the user and finish initial GSV setup",
        details: {
          responsibilityType: "onboarding.initial",
          summary: "Learn how to be useful to the user and help them connect and configure the parts of GSV they want.",
          outcomes: [
            "Learn enough about the user to be useful.",
            "Help connect useful computers, services, or messengers.",
            "Help configure models, permissions, and approvals where needed.",
          ],
          completionCondition: "The user confirms that onboarding or setup is complete.",
        },
        source: { kind: "system", component: "onboarding" } as const,
        assignee: { kind: "ship" } as const,
        state: "waiting" as const,
        priority: "high" as const,
        blocker: "Waiting for the user to begin or continue setup.",
        dedupeKey: "onboarding.initial",
        actor: { kind: "system", component: "onboarding" } as const,
        observedByShip: true,
        now: 1_000,
      });
      const stale = responsibilities.create(previous(1000)).record;
      const resolved = responsibilities.create(previous(2000)).record;
      responsibilities.update({
        ownerUid: 2000,
        id: resolved.id,
        patch: { state: "resolved" },
        actor: { kind: "process", processId: "ship-2" },
        observedByShip: true,
        now: 2_000,
      });
      const edited = responsibilities.create(previous(3000)).record;
      responsibilities.update({
        ownerUid: 3000,
        id: edited.id,
        patch: { title: "Set up my workshop" },
        actor: { kind: "account", uid: 3000, username: "owner" },
        observedByShip: true,
        now: 2_000,
      });

      const migrated = ensureInitialOnboardingResponsibility(1000, responsibilities, 3_000);
      expect(migrated.created).toBe(false);
      expect(migrated.record).toMatchObject({
        id: stale.id,
        title: "Welcome to GSV",
        state: "waiting",
        blocker: "Waiting for the user's first messages.",
        details: { responsibilityType: "onboarding.initial" },
      });
      expect(migrated.record.details).not.toEqual(stale.details);
      expect(ensureInitialOnboardingResponsibility(1000, responsibilities, 4_000).record).toEqual(migrated.record);

      expect(ensureInitialOnboardingResponsibility(2000, responsibilities, 3_000).record).toMatchObject({
        id: resolved.id,
        state: "resolved",
        title: "Get to know the user and finish initial GSV setup",
      });
      expect(ensureInitialOnboardingResponsibility(3000, responsibilities, 3_000).record).toMatchObject({
        id: edited.id,
        title: "Set up my workshop",
        details: { completionCondition: "The user confirms that onboarding or setup is complete." },
      });
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

      const forged = responsibilities.create({
        ownerUid: 2000,
        title: "Looks like onboarding",
        source: { kind: "process", processId: "worker-1" },
        assignee: { kind: "ship" },
        state: "active",
        priority: "normal",
        dedupeKey: "onboarding.initial",
        actor: { kind: "process", processId: "worker-1" },
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
        ownerUid: 2000,
        id: forged.id,
        patch: { state: "resolved" },
        actor: { kind: "process", processId: "worker-1" },
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

      responsibilities.update({
        ownerUid: 1000,
        id: onboarding.id,
        patch: { state: "resolved", resolution: { conceptsIntroduced: ["approval", "routine", "place"] } },
        actor: { kind: "process", processId: "ship-1" },
        observedByShip: true,
        now: 422_000,
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
