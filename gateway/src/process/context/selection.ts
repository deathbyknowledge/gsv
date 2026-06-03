import { createHomeContextProvider } from "./providers/home";
import { createOwnerContextProvider } from "./providers/owner";
import { createProcessContextProvider } from "./providers/process";
import { createSkillIndexProvider } from "./providers/skills";
import { createSystemContextProvider } from "./providers/system";
import type { PromptAssemblyInput, PromptContextProvider } from "./types";

export type ContextPurpose = PromptAssemblyInput["purpose"];

const SYSTEM_PROVIDER = createSystemContextProvider();
const HOME_PROVIDER = createHomeContextProvider();
const OWNER_PROVIDER = createOwnerContextProvider();
const SKILLS_PROVIDER = createSkillIndexProvider();
const PROCESS_PROVIDER = createProcessContextProvider();

export function resolvePromptProviders(
  purpose: ContextPurpose,
): PromptContextProvider[] {
  void purpose;
  return [
    SYSTEM_PROVIDER,
    HOME_PROVIDER,
    OWNER_PROVIDER,
    SKILLS_PROVIDER,
    PROCESS_PROVIDER,
  ];
}
