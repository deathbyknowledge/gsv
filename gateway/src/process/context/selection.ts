import type { AiContextProfile } from "../../syscalls/ai";
import { createHomeContextProvider } from "./providers/home";
import { createProcessContextProvider } from "./providers/process";
import { createProfileInstructionsProvider } from "./providers/profile";
import { createWorkspaceContextProvider } from "./providers/workspace";
import type { PromptAssemblyInput, PromptContextProvider } from "./types";

export type ContextPurpose = PromptAssemblyInput["purpose"];

const PROFILE_PROVIDER = createProfileInstructionsProvider();
const HOME_PROVIDER = createHomeContextProvider();
const WORKSPACE_PROVIDER = createWorkspaceContextProvider();
const PROCESS_PROVIDER = createProcessContextProvider();

export function resolvePromptProviders(
  profile: AiContextProfile,
  purpose: ContextPurpose,
): PromptContextProvider[] {
  void profile;
  void purpose;
  return [PROFILE_PROVIDER, HOME_PROVIDER, WORKSPACE_PROVIDER, PROCESS_PROVIDER];
}
