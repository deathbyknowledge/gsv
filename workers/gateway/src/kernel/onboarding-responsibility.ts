import type { JsonObject, ResponsibilityRecord } from "@humansandmachines/gsv/protocol";

import type { ResponsibilityCreateOutcome, ResponsibilityStore } from "./responsibility-store";

export const INITIAL_ONBOARDING_DEDUPE_KEY = "onboarding.initial";

/**
 * A caller may choose any dedupe key on `r12y.create`, but the Kernel derives
 * `source` from the actor, so only the record this module seeds carries the
 * system onboarding source.
 */
export function isInitialOnboardingResponsibility(record: ResponsibilityRecord): boolean {
  return record.dedupeKey === INITIAL_ONBOARDING_DEDUPE_KEY
    && record.source.kind === "system"
    && record.source.component === "onboarding";
}

const INITIAL_ONBOARDING_ACTOR = { kind: "system", component: "onboarding" } as const;

type OnboardingContract = { title: string; details: JsonObject; blocker: string };

/** The current onboarding contract, shared by the seeded record and the `07-onboarding.md` context file. */
const INITIAL_ONBOARDING_CONTRACT: OnboardingContract = {
  title: "Welcome to GSV",
  details: {
    responsibilityType: "onboarding.initial",
    summary: "The user understands what GSV does by experiencing a successful task by themselves.",
    outcomes: [
      "One of the following: a machine OR browser OR messenger OR integration is connected; an email is sent; a file is created OR edited OR deleted; a reminder is created that can reach the user even if they leave the website",
    ],
    completionCondition: "The user has experienced one completed task beyond conversation, such as connecting a machine, browser, messenger, or integration, sending an email, creating, editing, or deleting files, or creating a reminder that can reach them even if they leave the website.",
  },
  blocker: "Waiting for the user's first messages.",
};

/**
 * Seed the owner's initial onboarding responsibility, or bring an unresolved
 * one from an earlier release onto the current contract so the record agrees
 * with the context file seeded beside it. A resolved or cancelled record and
 * the owner's own edits to the contract fields are left alone.
 */
export function ensureInitialOnboardingResponsibility(
  ownerUid: number,
  responsibilities: ResponsibilityStore,
  now = Date.now(),
): ResponsibilityCreateOutcome {
  const created = responsibilities.create({
    ownerUid,
    ...INITIAL_ONBOARDING_CONTRACT,
    source: INITIAL_ONBOARDING_ACTOR,
    assignee: { kind: "ship" },
    state: "waiting",
    priority: "high",
    dedupeKey: INITIAL_ONBOARDING_DEDUPE_KEY,
    actor: INITIAL_ONBOARDING_ACTOR,
    observedByShip: true,
    now,
  });
  const existing = created.record;
  if (
    created.created
    || !isInitialOnboardingResponsibility(existing)
    || existing.state === "resolved"
    || existing.state === "cancelled"
    || !isPreviousOnboardingContract(existing)
  ) {
    return created;
  }
  const updated = responsibilities.update({
    ownerUid,
    id: existing.id,
    patch: INITIAL_ONBOARDING_CONTRACT,
    actor: INITIAL_ONBOARDING_ACTOR,
    observedByShip: true,
    now,
  });
  return { record: updated.record, created: false, revision: updated.revision };
}

/** Contract fields exactly as the previous release seeded them; anything else is an owner edit. */
const PREVIOUS_ONBOARDING_CONTRACT: OnboardingContract = {
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

function isPreviousOnboardingContract(record: ResponsibilityRecord): boolean {
  return record.title === PREVIOUS_ONBOARDING_CONTRACT.title
    && record.blocker === PREVIOUS_ONBOARDING_CONTRACT.blocker
    && JSON.stringify(record.details) === JSON.stringify(PREVIOUS_ONBOARDING_CONTRACT.details);
}
