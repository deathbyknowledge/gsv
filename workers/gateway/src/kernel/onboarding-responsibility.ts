import type { ResponsibilityCreateOutcome, ResponsibilityStore } from "./responsibility-store";

export const INITIAL_ONBOARDING_DEDUPE_KEY = "onboarding.initial";

export function ensureInitialOnboardingResponsibility(
  ownerUid: number,
  responsibilities: ResponsibilityStore,
  now = Date.now(),
): ResponsibilityCreateOutcome {
  return responsibilities.create({
    ownerUid,
    title: "Welcome to GSV",
    details: {
      responsibilityType: "onboarding.initial",
      summary: "The user understands what GSV does by experiencing a successful task by themselves.",
      outcomes: [
        "One of the following: a machine OR browser OR messenger OR integration is connected; an email is sent; a file is created OR edited OR deleted; a reminder is created that can reach the user even if they leave the website",
      ],
      completionCondition: "The user has experienced one completed task beyond conversation, such as connecting a machine, browser, messenger, or integration, sending an email, creating, editing, or deleting files, or creating a reminder that can reach them even if they leave the website.",
    },
    source: { kind: "system", component: "onboarding" },
    assignee: { kind: "ship" },
    state: "waiting",
    priority: "high",
    blocker: "Waiting for the user's first messages.",
    dedupeKey: INITIAL_ONBOARDING_DEDUPE_KEY,
    actor: { kind: "system", component: "onboarding" },
    observedByShip: true,
    now,
  });
}
