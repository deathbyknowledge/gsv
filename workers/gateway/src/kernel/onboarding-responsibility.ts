import type { ResponsibilityCreateOutcome, ResponsibilityStore } from "./responsibility-store";

const INITIAL_ONBOARDING_DEDUPE_KEY = "onboarding.initial";

export function ensureInitialOnboardingResponsibility(
  ownerUid: number,
  responsibilities: ResponsibilityStore,
  now = Date.now(),
): ResponsibilityCreateOutcome {
  return responsibilities.create({
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
    source: { kind: "system", component: "onboarding" },
    assignee: { kind: "ship" },
    state: "waiting",
    priority: "high",
    blocker: "Waiting for the user to begin or continue setup.",
    dedupeKey: INITIAL_ONBOARDING_DEDUPE_KEY,
    actor: { kind: "system", component: "onboarding" },
    observedByShip: true,
    now,
  });
}
