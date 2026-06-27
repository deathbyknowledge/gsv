import { createHomeContextProvider } from "./providers/home";
import { createOwnerContextProvider } from "./providers/owner";
import { createProcessContextProvider } from "./providers/process";
import { createSkillIndexProvider } from "./providers/skills";
import { createSystemContextProvider } from "./providers/system";
import type { PromptContextProvider } from "./types";

const SYSTEM_PROVIDER = createSystemContextProvider();
const HOME_PROVIDER = createHomeContextProvider();
const OWNER_PROVIDER = createOwnerContextProvider();
const SKILLS_PROVIDER = createSkillIndexProvider();
const PROCESS_PROVIDER = createProcessContextProvider();

export function resolvePromptProviders(): PromptContextProvider[] {
  return [
    SYSTEM_PROVIDER,
    HOME_PROVIDER,
    OWNER_PROVIDER,
    SKILLS_PROVIDER,
    PROCESS_PROVIDER,
  ];
}
