import type { AiContextProfile } from "../../syscalls/ai";
import { createBaseSystemPromptProvider } from "./providers/base";
import { createHomeKnowledgeProvider } from "./providers/home";
import { createProfileInstructionsProvider } from "./providers/profile";
import { createWorkspaceSummaryProvider } from "./providers/workspace";
import type { PromptAssemblyInput, PromptContextProvider } from "./types";

export type ContextPurpose = PromptAssemblyInput["purpose"];

const BASE_PROVIDER = createBaseSystemPromptProvider();
const PROFILE_PROVIDER = createProfileInstructionsProvider();
const HOME_PROVIDER = createHomeKnowledgeProvider();
const WORKSPACE_PROVIDER = createWorkspaceSummaryProvider();

export function resolvePromptProviders(
  profile: AiContextProfile,
  purpose: ContextPurpose,
): PromptContextProvider[] {
  const basePlan = [BASE_PROVIDER, PROFILE_PROVIDER];

  switch (profile) {
    case "app":
      return purpose === "thread.resume"
        ? [...basePlan, WORKSPACE_PROVIDER]
        : [...basePlan, WORKSPACE_PROVIDER];
    case "init":
      return [...basePlan, HOME_PROVIDER];
    case "cron":
      return [...basePlan, HOME_PROVIDER, WORKSPACE_PROVIDER];
    case "mcp":
      return [...basePlan, HOME_PROVIDER, WORKSPACE_PROVIDER];
    case "review":
      return [...basePlan, HOME_PROVIDER, WORKSPACE_PROVIDER];
    case "task":
    default:
      return [...basePlan, HOME_PROVIDER, WORKSPACE_PROVIDER];
  }
}
