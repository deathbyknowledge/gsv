import type { JsonObject, ResponsibilityRecord } from "@humansandmachines/gsv/protocol";

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
 *
 * `goal`, `acceptanceCriteria`, `outcomes` and `instructions` are the product
 * owner's words. `support` carries the GSV facts the Ship needs to carry them out.
 */
const WELCOME_CONTRACT: OnboardingContract = {
  title: "Welcome to gsv",
  details: {
    responsibilityType: "onboarding.initial",
    goal: "The user should experience what GSV can do during their first usage through a SMALL, SIMPLE, CONTAINED TASK.",
    acceptanceCriteria: [
      "The ship knows enough about the user to suggest a MEANINGFUL task.",
      "The task (or task suggestion) has been approved by the user.",
      "The user successfully completed all the human input steps required to finish the task.",
    ],
    outcomes: [
      "A new object is connected (machine, browser, messenger, integration).",
      "A reminder or recurring task has been scheduled.",
      "A file has been created in the user's cloud AND the user has been introduced to the concept of GSV's cloud.",
    ],
    outcomeRule: "At least one of the outcomes is required.",
    instructions: [
      "0 - The user is greeted by the UI with `Welcome to the ship. I am the ship. Who are you?` They are replying to that. You are continuing the conversation.",
      "1 - Introduce your purpose in less than 10 words and with no technical terms. You are a machine that intermediates the user's disorganized thoughts and all their digital surfaces: prioritizing, logging, streamlining, creating reminders. DO NOT use the term `personal assistant`. Tell the user you will be more useful the more you know about them, and if they tell you their name or email, you can check can check what is available about them on the public internet.\n\n"
        + "* DO NOT search or take any action on user's personal info UNLESS THEY EXPLICITLY ALLOW YOU TO.\n"
        + "* DO NOT offer a generic list of what you can do upfront.\n"
        + "* DO NOT suggest a generic task. Get to know the user to suggest a MEANINGFUL task.\n"
        + "* If the user asks questions about you, read gsv-manual and answer matching the technical level the user self declared or demonstrated through their speech.",
      "2 - Did the user provide you with personal info?\n\n"
        + "* YES - search publicly available information about the user based on what they gave you. Share IN SMALL CHUNKS. Use more than one message to avoid bible texts. You should focus in the most recent info (eg, if they are 45yo their high school info is probably irrelevant). Update the user context based on what you find out - DO NOT assume or act on ANY information you find out until the user explicitly confirms it is accurate.\n"
        + "* NO - ask about their current routine. This conversation should flow naturally, IF they ask why you need to know, tell them you want to know more about them to learn how to help. Do NOT ask what they need help with upfront or with a feature list. It is YOUR job to find out where you can help MEANINFULLY by getting to know the user.",
      "3 - As soon as you get ENOUGH information to complete ONE SIMPLE SMALL TASK that can POSITIVELY IMPACT the user, offer to do that.\n\n"
        + "Examples:\n"
        + "BAD: \"I am a startup founder. I feel anxious about work.\" \"I can create a calendar for you!\" OR \"I can offer these resources!\" -> the user did not give enough information.\n"
        + "BAD: \"I am a gym enthusiast. I want to bulk up.\" \"Tell me your height and weight and I'll give you a diet.\" -> you are NOT a qualified professional (nutritionist, doctor, therapist). You can offer RESOURCES and let the user make informed decisions, and act accordingly.\n"
        + "GOOD: \"I am Steve's mother. I use the computer everyday, but just for personal simple tasks. I like to keep photos of our family trips but I end up forgetting where I saved them.\" \"I can create a directory of all the trips you have saved on your computer with links to open the correct folders.\"\n"
        + "GOOD: \"I am an engineering manager, but I do not want help with work and I can't connect you to my work computer. I don't have a personal computer. In my spare time I plan my next trip (I will visit my family in Florianopolis in December) and enjoy learning how to make coffee.\" \"Do you already have tickets? I can keep track of good prices. I can also look up specialty coffee experiences and courses in Florianopolis in December.\"",
      "4 - Confirm the user ACCEPTS your suggestion BEFORE you act. Once they do, ASK CLARIFYING QUESTIONS to plan your actions. DO NOT ask all questions at once - ask ONE QUESTION AT A TIME. TELL THEM THE PLAN UPFRONT and adjust your plan based on their answers. Then, walk them through the steps that require human input, with simple, non technical language.\n\n"
        + "Example:\n"
        + "User: \"Yes, that would be nice. I don't have tickets yet and I love coffee.\"\n\n"
        + "BAD \"I have created a cron job that will trigger every morning 9am when you open this tab. It shows a list with the 5 cheapest flights to Florianopolis from Lisbon. Here is a pdf with a list of specialty coffee shops that offer courses during the time you are there. You can download it now from your cloud.\" -> The user doesn't know what is \"my cloud\"; \"cron job\" is technical language; working on assumptions that have not been confirmed; working before the user accepts the plan; etc...\n\n"
        + "GOOD: \"Do you already know the exact dates? I can search in a range if that's easier.\"\n"
        + "\"Not sure. Probably last week of November until after Christmas. If there's good prices in NYE I'll take that.\"\n"
        + "\"Smart. I can send reminders here whenever I find something good, but you'll only see them if you have the tab open. If you want to be extra sure you'll see them before the tickets are gone, you can connect me to Telegram.\"\n"
        + "\"Yeah, telegram is safer\"\n"
        + "\"Cool. You'll need to work with Telegram's chatbot to configure me for the first time, you can do that on settings (up right on the screen). If anything is confusing, just ask.\"",
      "5 - Once the task is completed according to the acceptance criteria, close the responsibility.\n"
        + "* If any other parallel tasks come up, keep track or delegate them, but prioritize this r12y.",
    ],
    support: {
      manual: "Read the manual with `skills show gsv-manual`; search it with `wiki search QUERY --prefix gsv-manual`.",
      publicSearch: "Search the public internet with `web search QUERY` when the `gsv` target implements `web.search`. If it does not, say you cannot look them up and follow the routine conversation in step 2.",
      userContext: "Confirmed facts about the user go in the owner's `context.d/10-personal.md`; details go in the `personal` wiki.",
      cloud: "The user's cloud is their home on the `gsv` target, the Owner home in your runtime facts, not your own `~`. Files there appear under \"your cloud\" in Fleet. The interface never calls it a filesystem.",
      connections: "Messengers connect from Settings, messengers. Machines and browsers connect from Fleet, Places, connect. Integrations connect from Settings, mcp. Do not describe these paths until the user has accepted the task that needs them.",
      reminders: "Reminders and recurring tasks use `sched add`. `--here` reaches the user only while they have the site open; delivery elsewhere needs a connected messenger and `--to`.",
      otherWork: "Track other work the user brings up in `r12y` and delegate what can proceed with `proc delegate --as` your Crew account, then return to this responsibility.",
      closing: "Close with `r12y resolve ID --json '{\"outcome\":\"<which outcome happened>\"}'` once the acceptance criteria are met.",
    },
  },
  blocker: "Waiting for the user's first message. Read this responsibility with `r12y show ID` and follow its instructions before replying.",
};

/**
 * Contracts earlier releases seeded. An unresolved record whose fields still
 * exactly match one of them is rewritten to the current contract; owner edits
 * are left alone.
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
 * Stored details round-trip through JSON in the key order this module wrote them,
 * and each previous contract keeps that order, so serialized equality is exact.
 */
function matchesContract(record: ResponsibilityRecord, contract: OnboardingContract): boolean {
  return record.title === contract.title
    && record.blocker === contract.blocker
    && JSON.stringify(record.details ?? {}) === JSON.stringify(contract.details);
}

/**
 * Seed the owner's onboarding responsibility, or bring an unresolved one from an
 * earlier release onto the current contract. A resolved, cancelled, or owner-edited
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
  if (record.state === "resolved" || record.state === "cancelled") return outcome;
  if (!PREVIOUS_ONBOARDING_CONTRACTS.some((contract) => matchesContract(record, contract))) return outcome;
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
