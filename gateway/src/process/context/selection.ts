import type { AiContextProfile } from "../../syscalls/ai";
import { createHomeContextProvider } from "./providers/home";
import { createProcessContextProvider } from "./providers/process";
import {
  createProfileInstructionsProvider,
  createSystemContextProvider,
} from "./providers/profile";
import { createSkillIndexProvider } from "./providers/skills";
import { createWorkspaceContextProvider } from "./providers/workspace";
import type { PromptAssemblyInput, PromptContextProvider } from "./types";

export type ContextPurpose = PromptAssemblyInput["purpose"];

const SYSTEM_PROVIDER = createSystemContextProvider();
const PROFILE_PROVIDER = createProfileInstructionsProvider();
const HOME_PROVIDER = createHomeContextProvider();
const WORKSPACE_PROVIDER = createWorkspaceContextProvider();
const SKILLS_PROVIDER = createSkillIndexProvider();
const PROCESS_PROVIDER = createProcessContextProvider();

export function resolvePromptProviders(
  profile: AiContextProfile,
  purpose: ContextPurpose,
): PromptContextProvider[] {
  void profile;
  void purpose;
  return [
    SYSTEM_PROVIDER,
    PROFILE_PROVIDER,
    HOME_PROVIDER,
    WORKSPACE_PROVIDER,
    SKILLS_PROVIDER,
    PROCESS_PROVIDER,
  ];
}
