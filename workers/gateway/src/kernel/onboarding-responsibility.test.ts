import { describe, expect, it } from "vitest";

import welcomeBrief from "../prompts/onboarding/welcome.md";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import { activateInitialOnboardingResponsibility, ensureInitialOnboardingResponsibility, INITIAL_ONBOARDING_DEDUPE_KEY, reconcileInitialOnboardingResponsibility } from "./onboarding-responsibility";
import { ResponsibilityStore } from "./responsibility-store";
import previousWelcomeBrief from "../prompts/onboarding/previous-welcome.md";
import previousShipWelcomeBrief from "../prompts/onboarding/previous-ship-welcome.md";

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
  it.each([
    { title: "Welcome to gsv", brief: previousWelcomeBrief, edited: false },
    { title: "Welcome to gsv", brief: previousWelcomeBrief, edited: true },
    { title: "Welcome to Ship", brief: previousShipWelcomeBrief, edited: false },
    { title: "Welcome to Ship", brief: previousShipWelcomeBrief, edited: true },
  ])("updates the previous $title only while untouched (edited: $edited)", async ({ title, brief, edited }) => {
    await runWithRealKernelSql((_sql, storage) => {
      const responsibilities = new ResponsibilityStore(storage);
      const seeded = responsibilities.create({
        ownerUid: 1000,
        title,
        details: { responsibilityType: "onboarding.initial", instructions: brief.trim() + (edited ? "\nMy own note" : "") },
        blocker: "Waiting for the user's first message. Follow the instructions in this responsibility's details before replying.",
        source: { kind: "system", component: "onboarding" },
        actor: { kind: "system", component: "onboarding" },
        assignee: { kind: "ship" }, state: "waiting", priority: "high",
        dedupeKey: INITIAL_ONBOARDING_DEDUPE_KEY, observedByShip: true, now: 1_000,
      });
      const migrated = reconcileInitialOnboardingResponsibility(1000, responsibilities, 2_000);
      expect(migrated?.id).toBe(seeded.record.id);
      expect(migrated?.title).toBe(edited ? title : "Welcome to Ship");
      if (edited) expect(migrated).toEqual(seeded.record);
      else expect(migrated?.details).toEqual({ responsibilityType: "onboarding.initial", instructions: welcomeBrief.trim() });
      expect(responsibilities.nextWakeAt(1000, 2_000)).toBeNull();
      activateInitialOnboardingResponsibility(1000, responsibilities, 3_000);
      expect(responsibilities.get(1000, seeded.record.id)?.state).toBe(edited ? "waiting" : "open");
    });
  });

  it.each([
    { scenario: "welcome language and interruption", guidance: [/adapt to the user's language/, /If the user has already spoken/, /Do not resend a welcome already present/, /"nextCheckAtMs":null/, /A greeting does not complete onboarding/] },
    { scenario: "discovery and alternatives", guidance: [/A hobby or interest can support a worthwhile task/, /If they ask "what else\?"/, /If they say "I don't know"/] },
    { scenario: "email follow-up pain", guidance: [/Use appropriate access to the original source/, /Do not ask the user to populate a tracker/, /Tracking never implies permission to send/] },
    { scenario: "event registration", guidance: [/research discoverable facts yourself/, /actual registration status/, /change-triggered watch with truthful cadence and delivery/] },
    { scenario: "suitable existing access", guidance: [/Reuse suitable existing access/, /No paired personal browser does not imply public browsing is unavailable/] },
    { scenario: "acceptance and next action", guidance: [/A direct user request already establishes the task/, /take the next necessary action/, /start the documented connection flow/] },
    { scenario: "declined or unavailable access", guidance: [/suitable access is unavailable or declined/, /lowest-effort useful alternative without pressuring them to connect/, /offer a bounded review/] },
    { scenario: "unsupported monitoring", guidance: [/Browser pairing alone does not establish reliable recurring access/, /Do not claim checks or reminders are active until setup succeeds/] },
    { scenario: "tracking versus sending", guidance: [/Agreement to research, track, or draft is not permission to send messages/, /Obtain explicit user approval before sending/] },
    { scenario: "monitoring reliability", guidance: [/Failure is not proof of no change/, /A daily check can support an alert after a check detects a change/] },
    { scenario: "setup versus a useful outcome", guidance: [/A connection alone, an empty tracker, or a promise to monitor is not an outcome/, /actually configured a supported ongoing task/] },
    { scenario: "user-facing storage language", guidance: [/technical terminology is not suggested wording for the user/, /do not introduce "your cloud," filesystem paths, targets, cron jobs/, /Storage — internal implementation detail/] },
    { scenario: "optional public lookup", guidance: [/A name given as an introduction is not permission to search/, /do not always require both a full name and location/, /Save only confirmed personal facts in their context/] },
    { scenario: "handover without a tour", guidance: [/Do not give a compulsory tour of Responsibilities and Routines/, /Closing onboarding must not resolve or cancel the ongoing responsibility/] },
  ])("includes guidance for $scenario", ({ guidance }) => {
    for (const rule of guidance) expect(welcomeBrief).toMatch(rule);
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
      const brief = first.record.details?.instructions;
      expect(brief).toEqual(expect.any(String));
      const text = String(brief);
      expect(text.startsWith("# Welcome to Ship")).toBe(true);
      for (const heading of ["## Goal", "## Acceptance criteria", "## Outcome", "## Instructions", "## Support"]) {
        expect(text).toContain(heading);
      }
      expect(text).toContain("### 0 - Welcome the user in their language");
      expect(text).toContain("Send the welcome yourself through the ordinary Send flow");
      expect(text).toContain("### 5 - Hand over clearly and close onboarding");
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
      activateInitialOnboardingResponsibility(1000, store, 2_000);
      expect(store.get(1000, seed.id)).toMatchObject({ state: "open" });
      expect(store.get(1000, seed.id)?.blocker).toBeUndefined();
      expect(store.nextWakeAt(1000, 2_000)).toBe(2_000);
      const revision = store.revision(1000);
      activateInitialOnboardingResponsibility(1000, store, 3_000);
      expect(store.revision(1000)).toBe(revision);
      const batch = store.createReadyBatch(1000, 3_000)!;
      expect(batch.responsibilities.map(({ id }) => id)).toEqual([seed.id]);
      store.markBatchDelivered(batch.id);
      store.update({ ownerUid: 1000, id: seed.id,
        patch: { state: "waiting", blocker: "Waiting for the user to respond to the welcome", nextCheckAtMs: null },
        actor: { kind: "process", processId: "ship" }, observedByShip: true, now: 4_000 });
      activateInitialOnboardingResponsibility(1000, store, 5_000);
      expect(store.nextWakeAt(1000, 5_000)).toBeNull();
      const edited = ensureInitialOnboardingResponsibility(1001, store, 1_000).record;
      store.update({ ownerUid: 1001, id: edited.id, patch: { title: "My welcome" },
        actor: { kind: "account", uid: 1001 }, observedByShip: true, now: 2_000 });
      activateInitialOnboardingResponsibility(1001, store, 3_000);
      expect(store.get(1001, edited.id)).toMatchObject({ title: "My welcome", state: "waiting" });
      activateInitialOnboardingResponsibility(1002, store, 3_000);
      expect(store.getByDedupeKey(1002, INITIAL_ONBOARDING_DEDUPE_KEY)).toBeNull();
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
      expect(migrated.record.title).toBe("Welcome to Ship");
      expect(String(migrated.record.details?.instructions)).toContain("## Instructions");
      expect(migrated.record.details).not.toHaveProperty("summary");
      expect(migrated.record.state).toBe("waiting");
      expect(migrated.revision).toBeGreaterThan(seeded.revision);
      expect(responsibilities.nextWakeAt(1000, 2_000)).toBeNull();

      const replay = ensureInitialOnboardingResponsibility(1000, responsibilities, 3_000);
      expect(replay.revision).toBe(migrated.revision);
    });
  });

  it("migrates and activates an untouched legacy welcome without repeating setup", async () => {
    await runWithRealKernelSql((_sql, storage) => {
      const store = new ResponsibilityStore(storage);
      const seed = seedPreviousContract(store, 1000, 1_000).record;
      activateInitialOnboardingResponsibility(1000, store, 2_000);
      expect(store.get(1000, seed.id)).toMatchObject({ title: "Welcome to gsv", state: "open" });
      expect(store.nextWakeAt(1000, 2_000)).toBe(2_000);
      const revision = store.revision(1000);
      activateInitialOnboardingResponsibility(1000, store, 3_000);
      expect(store.revision(1000)).toBe(revision);
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
      expect(migrated?.title).toBe("Welcome to Ship");

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
