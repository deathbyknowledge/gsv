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
 * The current onboarding contract. The Ship's prompt snapshot renders the
 * record with its details, and the responsibilities context tells the Ship to
 * follow them while this record is unresolved. The brief itself is the Markdown
 * prompt file `prompts/onboarding/welcome.md`.
 */
const WELCOME_CONTRACT: OnboardingContract = {
  title: "Welcome to Ship",
  details: {
    responsibilityType: "onboarding.initial",
    instructions: welcomeBrief.trim(),
  },
  blocker: "Waiting for the user to dismiss the welcome card.",
};

/** Match a dormant welcome without reopening work Ship or its owner has changed. */
function isUntouchedSeed(
  record: ResponsibilityRecord,
  state: "waiting" | "open" = "waiting",
): boolean {
  return record.title === WELCOME_CONTRACT.title
    && record.blocker === (state === "waiting" ? WELCOME_CONTRACT.blocker : undefined)
    && JSON.stringify(record.details ?? {}) === JSON.stringify(WELCOME_CONTRACT.details)
    && record.state === state
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
 * Seed the owner's onboarding responsibility only when no record exists. Only a
 * new personal agent, or the retirement of the exact generated boot file that
 * preceded the ledger, may seed: a home that finished the earlier flow has no
 * record and must not be onboarded again.
 */
export function ensureInitialOnboardingResponsibility(
  ownerUid: number,
  responsibilities: ResponsibilityStore,
  now = Date.now(),
): ResponsibilityCreateOutcome {
  return responsibilities.create({
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
}

/** Activate only an untouched welcome seed; retries must not reopen work Ship already handled. */
export function activateInitialOnboardingResponsibility(
  ownerUid: number,
  responsibilities: ResponsibilityStore,
  now = Date.now(),
): boolean {
  const record = responsibilities.getByDedupeKey(ownerUid, INITIAL_ONBOARDING_DEDUPE_KEY);
  if (!record) return false;
  if (!isUntouchedSeed(record)) {
    return isUntouchedSeed(record, "open")
      && responsibilities.nextWakeAt(ownerUid, now) !== null;
  }
  responsibilities.update({
    ownerUid,
    id: record.id,
    patch: { state: "open", blocker: null },
    actor: ONBOARDING_SOURCE,
    observedByShip: false,
    now,
  });
  return true;
}
