import type { JsonObject, ResponsibilityRecord } from "@humansandmachines/gsv/protocol";

import welcomeBrief from "../prompts/onboarding/welcome.md";
import type { ResponsibilityCreateOutcome, ResponsibilityStore } from "./responsibility-store";

export const INITIAL_ONBOARDING_DEDUPE_KEY = "onboarding.initial";

const ONBOARDING_SOURCE = { kind: "system", component: "onboarding" } as const;

type OnboardingContract = {
  title: string;
  details: JsonObject;
  blocker: string;
};

/**
 * The current onboarding contract. The ledger snapshot in the Ship's prompt
 * shows only the title and blocker; the Ship reads the rest with `r12y show`,
 * as its responsibilities context tells it to while this record is unresolved.
 * The brief itself is the Markdown prompt file `prompts/onboarding/welcome.md`.
 */
const WELCOME_CONTRACT: OnboardingContract = {
  title: "Welcome to gsv",
  details: {
    responsibilityType: "onboarding.initial",
    instructions: welcomeBrief.trim(),
  },
  blocker: "Waiting for the user's first message. Read this responsibility with `r12y show ID` and follow its instructions before replying.",
};

/**
 * Contracts earlier releases seeded. An unresolved record that still matches one
 * of them in every field is rewritten to the current contract; any owner change
 * leaves the record alone.
 */
const PREVIOUS_ONBOARDING_CONTRACTS: readonly OnboardingContract[] = [
  {
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
  },
];

/**
 * Every field a seeded record carries, so an owner edit to any of them, not only
 * the text, stops the migration. Stored details round-trip through JSON in the
 * key order this module wrote them, and each previous contract keeps that order,
 * so serialized equality is exact.
 */
function isUntouchedSeed(record: ResponsibilityRecord, contract: OnboardingContract): boolean {
  return record.title === contract.title
    && record.blocker === contract.blocker
    && JSON.stringify(record.details ?? {}) === JSON.stringify(contract.details)
    && record.state === "waiting"
    && record.priority === "high"
    && record.assignee.kind === "ship"
    && record.parentId === undefined
    && record.audience === undefined
    && record.dueAtMs === undefined
    && record.nextCheckAtMs === undefined
    && record.leaseExpiresAtMs === undefined
    && record.resolution === undefined;
}

/**
 * Seed the owner's onboarding responsibility, or bring an untouched one from an
 * earlier release onto the current contract. A resolved, cancelled, or edited
 * record is returned unchanged.
 */
export function ensureInitialOnboardingResponsibility(
  ownerUid: number,
  responsibilities: ResponsibilityStore,
  now = Date.now(),
): ResponsibilityCreateOutcome {
  const outcome = responsibilities.create({
    ownerUid,
    title: WELCOME_CONTRACT.title,
    details: WELCOME_CONTRACT.details,
    source: ONBOARDING_SOURCE,
    assignee: { kind: "ship" },
    state: "waiting",
    priority: "high",
    blocker: WELCOME_CONTRACT.blocker,
    dedupeKey: INITIAL_ONBOARDING_DEDUPE_KEY,
    actor: ONBOARDING_SOURCE,
    observedByShip: true,
    now,
  });
  if (outcome.created) return outcome;
  const { record } = outcome;
  if (!PREVIOUS_ONBOARDING_CONTRACTS.some((contract) => isUntouchedSeed(record, contract))) return outcome;
  const updated = responsibilities.update({
    ownerUid,
    id: record.id,
    patch: {
      title: WELCOME_CONTRACT.title,
      details: WELCOME_CONTRACT.details,
      blocker: WELCOME_CONTRACT.blocker,
    },
    actor: ONBOARDING_SOURCE,
    observedByShip: true,
    now,
  });
  return { record: updated.record, created: false, revision: updated.revision };
}
