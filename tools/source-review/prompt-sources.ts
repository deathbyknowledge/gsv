import { CONTEXT_SOURCES, type ContextScope } from "../../workers/gateway/src/prompts/context";
import previousOnboardingWelcome from "../../workers/gateway/src/prompts/onboarding/previous-welcome.md";
import onboardingWelcome from "../../workers/gateway/src/prompts/onboarding/welcome.md";
import compactionTask from "../../workers/gateway/src/prompts/tasks/compaction.md";
import contextRunwayTask from "../../workers/gateway/src/prompts/tasks/context-runway.md";
import delegatedTask from "../../workers/gateway/src/prompts/tasks/delegated.md";
import memoryReviewTask from "../../workers/gateway/src/prompts/tasks/memory-review.md";
import operatorUpdateTask from "../../workers/gateway/src/prompts/tasks/operator-update.md";
import setupTask from "../../workers/gateway/src/prompts/tasks/setup-assist.md";
import yieldTask from "../../workers/gateway/src/prompts/tasks/yield-correction.md";

export type PromptSourceScope = "shared" | "ship" | "crew" | "owner" | "task";
export type PromptSource = { path: string; text: string; scope: PromptSourceScope };

const SCOPES = { system: "shared", ship: "ship", crew: "crew", user: "owner" } satisfies Record<ContextScope, PromptSourceScope>;

// Historical authoring layout, before sources mirrored context.d:
// Source categories are independent of saved context.d paths and their assembly order.
export const PROMPT_SOURCES: PromptSource[] = [
  ...Object.entries(SCOPES).flatMap(([directory, scope]) => Object.entries(CONTEXT_SOURCES)
    .filter(([path]) => path.startsWith(`${directory}/`))
    .map(([path, text]) => ({ path, text, scope }))),
  { path: "onboarding/previous-welcome.md", text: previousOnboardingWelcome, scope: "task" },
  { path: "onboarding/welcome.md", text: onboardingWelcome, scope: "task" },
  { path: "tasks/compaction.md", text: compactionTask, scope: "task" },
  { path: "tasks/context-runway.md", text: contextRunwayTask, scope: "task" },
  { path: "tasks/delegated.md", text: delegatedTask, scope: "task" },
  { path: "tasks/memory-review.md", text: memoryReviewTask, scope: "task" },
  { path: "tasks/operator-update.md", text: operatorUpdateTask, scope: "task" },
  { path: "tasks/setup-assist.md", text: setupTask, scope: "task" },
  { path: "tasks/yield-correction.md", text: yieldTask, scope: "task" },
];
