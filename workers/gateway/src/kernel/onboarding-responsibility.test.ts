import { describe, expect, it } from "vitest";

import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import { ensureInitialOnboardingResponsibility, INITIAL_ONBOARDING_DEDUPE_KEY } from "./onboarding-responsibility";
import { ResponsibilityStore } from "./responsibility-store";

const PREVIOUS_CONTRACT = {
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
  blocker: "Waiting for the user to begin or continue setup.",
};

function seedPreviousContract(responsibilities: ResponsibilityStore, ownerUid: number, now: number) {
  return responsibilities.create({
    ownerUid,
    ...PREVIOUS_CONTRACT,
    source: { kind: "system", component: "onboarding" },
    assignee: { kind: "ship" },
    state: "waiting",
    priority: "high",
    dedupeKey: INITIAL_ONBOARDING_DEDUPE_KEY,
    actor: { kind: "system", component: "onboarding" },
    observedByShip: true,
    now,
  });
}

describe("initial onboarding responsibility", () => {
  it("creates one non-waking Ship responsibility for the owner", async () => {
    await runWithRealKernelSql((_sql, storage) => {
      const responsibilities = new ResponsibilityStore(storage);
      const first = ensureInitialOnboardingResponsibility(1000, responsibilities, 1_000);
      const replay = ensureInitialOnboardingResponsibility(1000, responsibilities, 2_000);

      expect(first.created).toBe(true);
      expect(first.record).toMatchObject({
        ownerUid: 1000,
        title: "Welcome to gsv",
        source: { kind: "system", component: "onboarding" },
        assignee: { kind: "ship" },
        state: "waiting",
        priority: "high",
        blocker: "Waiting for the user's first message. Read this responsibility with `r12y show ID` and follow its instructions before replying.",
        details: {
          responsibilityType: "onboarding.initial",
          goal: "The user should experience what GSV can do during their first usage through a SMALL, SIMPLE, CONTAINED TASK.",
          outcomeRule: "At least one of the outcomes is required.",
        },
      });
      expect(first.record.details?.acceptanceCriteria).toHaveLength(3);
      expect(first.record.details?.outcomes).toHaveLength(3);
      const instructions = first.record.details?.instructions;
      expect(Array.isArray(instructions) && instructions.length).toBe(6);
      expect(instructions).toEqual(expect.arrayContaining([
        expect.stringMatching(/^0 - The user is greeted by the UI with `Welcome to the ship\./),
        expect.stringMatching(/^1 - Introduce your purpose in less than 10 words.*name or email/s),
        expect.stringMatching(/^5 - Once the task is completed/),
      ]));
      expect(replay).toEqual({
        record: first.record,
        created: false,
        revision: first.revision,
      });
      expect(responsibilities.nextWakeAt(1000, 2_000)).toBeNull();
    });
  });

  it("rewrites an unresolved record from the previous release onto the current contract", async () => {
    await runWithRealKernelSql((_sql, storage) => {
      const responsibilities = new ResponsibilityStore(storage);
      const seeded = seedPreviousContract(responsibilities, 1000, 1_000);
      expect(seeded.created).toBe(true);

      const migrated = ensureInitialOnboardingResponsibility(1000, responsibilities, 2_000);

      expect(migrated.created).toBe(false);
      expect(migrated.record.id).toBe(seeded.record.id);
      expect(migrated.record.title).toBe("Welcome to gsv");
      expect(migrated.record.details?.instructions).toHaveLength(6);
      expect(migrated.record.details).not.toHaveProperty("summary");
      expect(migrated.record.state).toBe("waiting");
      expect(migrated.revision).toBeGreaterThan(seeded.revision);
      expect(responsibilities.nextWakeAt(1000, 2_000)).toBeNull();

      const replay = ensureInitialOnboardingResponsibility(1000, responsibilities, 3_000);
      expect(replay.revision).toBe(migrated.revision);
    });
  });

  it("leaves resolved and owner-edited records alone", async () => {
    await runWithRealKernelSql((_sql, storage) => {
      const responsibilities = new ResponsibilityStore(storage);
      const actor = { kind: "account", uid: 1000 } as const;

      const resolved = seedPreviousContract(responsibilities, 1000, 1_000);
      responsibilities.update({
        ownerUid: 1000, id: resolved.record.id, patch: { state: "resolved" }, actor, observedByShip: true, now: 1_500,
      });
      const afterResolved = ensureInitialOnboardingResponsibility(1000, responsibilities, 2_000);
      expect(afterResolved.record.title).toBe(PREVIOUS_CONTRACT.title);
      expect(afterResolved.record.state).toBe("resolved");

      const edited = seedPreviousContract(responsibilities, 1001, 1_000);
      responsibilities.update({
        ownerUid: 1001, id: edited.record.id, patch: { title: "Setup, my way" }, actor: { kind: "account", uid: 1001 }, observedByShip: true, now: 1_500,
      });
      const afterEdit = ensureInitialOnboardingResponsibility(1001, responsibilities, 2_000);
      expect(afterEdit.record.title).toBe("Setup, my way");
      expect(afterEdit.record.details).toEqual(PREVIOUS_CONTRACT.details);
    });
  });
});
