import { describe, expect, it } from "vitest";

import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import { ensureInitialOnboardingResponsibility, INITIAL_ONBOARDING_DEDUPE_KEY, reconcileInitialOnboardingResponsibility } from "./onboarding-responsibility";
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
  it("creates one non-waking Ship responsibility carrying the welcome brief", async () => {
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
        blocker: "Waiting for the user's first message. Follow the instructions in this responsibility's details before replying.",
        details: { responsibilityType: "onboarding.initial" },
      });
      const brief = first.record.details?.instructions;
      expect(brief).toEqual(expect.any(String));
      const text = String(brief);
      expect(text.startsWith("# Welcome to gsv")).toBe(true);
      for (const heading of ["## Goal", "## Acceptance criteria", "## Outcome", "## Instructions", "## Support"]) {
        expect(text).toContain(heading);
      }
      expect(text).toContain("0 - On the website or in the desktop app the user was greeted with");
      expect(text).toContain("5 - Once the task is completed");
      expect(replay).toEqual({
        record: first.record,
        created: false,
        revision: first.revision,
      });
      expect(responsibilities.nextWakeAt(1000, 2_000)).toBeNull();
    });
  });

  it("rewrites an untouched record from the previous release onto the current contract", async () => {
    await runWithRealKernelSql((_sql, storage) => {
      const responsibilities = new ResponsibilityStore(storage);
      const seeded = seedPreviousContract(responsibilities, 1000, 1_000);
      expect(seeded.created).toBe(true);

      const migrated = ensureInitialOnboardingResponsibility(1000, responsibilities, 2_000);

      expect(migrated.created).toBe(false);
      expect(migrated.record.id).toBe(seeded.record.id);
      expect(migrated.record.title).toBe("Welcome to gsv");
      expect(String(migrated.record.details?.instructions)).toContain("## Instructions");
      expect(migrated.record.details).not.toHaveProperty("summary");
      expect(migrated.record.state).toBe("waiting");
      expect(migrated.revision).toBeGreaterThan(seeded.revision);
      expect(responsibilities.nextWakeAt(1000, 2_000)).toBeNull();

      const replay = ensureInitialOnboardingResponsibility(1000, responsibilities, 3_000);
      expect(replay.revision).toBe(migrated.revision);
    });
  });

  it("reconciles an existing record without seeding one for a home that has none", async () => {
    await runWithRealKernelSql((_sql, storage) => {
      const responsibilities = new ResponsibilityStore(storage);
      expect(reconcileInitialOnboardingResponsibility(1000, responsibilities, 1_000)).toBeNull();
      expect(responsibilities.getByDedupeKey(1000, INITIAL_ONBOARDING_DEDUPE_KEY)).toBeNull();

      const seeded = seedPreviousContract(responsibilities, 1001, 1_000);
      const migrated = reconcileInitialOnboardingResponsibility(1001, responsibilities, 2_000);
      expect(migrated?.id).toBe(seeded.record.id);
      expect(migrated?.title).toBe("Welcome to gsv");

      const current = ensureInitialOnboardingResponsibility(1002, responsibilities, 1_000);
      const unchanged = reconcileInitialOnboardingResponsibility(1002, responsibilities, 2_000);
      expect(unchanged).toEqual(current.record);
    });
  });

  it("leaves resolved and edited records alone, whichever field was edited", async () => {
    await runWithRealKernelSql((_sql, storage) => {
      const responsibilities = new ResponsibilityStore(storage);

      const resolved = seedPreviousContract(responsibilities, 1000, 1_000);
      responsibilities.update({
        ownerUid: 1000, id: resolved.record.id, patch: { state: "resolved" }, actor: { kind: "account", uid: 1000 }, observedByShip: true, now: 1_500,
      });
      const afterResolved = ensureInitialOnboardingResponsibility(1000, responsibilities, 2_000);
      expect(afterResolved.record.title).toBe(PREVIOUS_CONTRACT.title);
      expect(afterResolved.record.state).toBe("resolved");

      const edits = [
        { title: "Setup, my way" },
        { priority: "normal" },
        { nextCheckAtMs: 9_000 },
        { state: "open", blocker: null },
      ] as const;
      edits.forEach((patch, index) => {
        const ownerUid = 2000 + index;
        const seeded = seedPreviousContract(responsibilities, ownerUid, 1_000);
        responsibilities.update({
          ownerUid, id: seeded.record.id, patch: { ...patch }, actor: { kind: "account", uid: ownerUid }, observedByShip: true, now: 1_500,
        });
        const after = ensureInitialOnboardingResponsibility(ownerUid, responsibilities, 2_000);
        expect(after.record.details, JSON.stringify(patch)).toEqual(PREVIOUS_CONTRACT.details);
        expect(after.record.revision, JSON.stringify(patch)).toBe(seeded.record.revision + 1);
      });
    });
  });
});
