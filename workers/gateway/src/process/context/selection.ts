import { createHomeContextProvider } from "./providers/home";
import { createOwnerContextProvider } from "./providers/owner";
import { createSkillIndexProvider } from "./providers/skills";
import { createSystemContextProvider } from "./providers/system";
import type { PromptContextProvider } from "./types";

const SYSTEM_PROVIDER = createSystemContextProvider();
const HOME_PROVIDER = createHomeContextProvider();
const OWNER_PROVIDER = createOwnerContextProvider();
const SKILLS_PROVIDER = createSkillIndexProvider();

export function resolvePromptProviders(): PromptContextProvider[] {
  return [
    SYSTEM_PROVIDER,
    HOME_PROVIDER,
    OWNER_PROVIDER,
    SKILLS_PROVIDER,
  ];
}
