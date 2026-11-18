import { createHomeContextProvider } from "./providers/home";
import { createOwnerContextProvider } from "./providers/owner";
import { createSkillIndexProvider } from "./providers/skills";
import { createRoleContextProvider, createSystemContextProvider } from "./providers/system";
import type { PromptContextProvider } from "./types";

const SYSTEM_PROVIDER = createSystemContextProvider();
const ROLE_PROVIDER = createRoleContextProvider();
const HOME_PROVIDER = createHomeContextProvider();
const OWNER_PROVIDER = createOwnerContextProvider();
const SKILLS_PROVIDER = createSkillIndexProvider();

export function resolvePromptProviders(): PromptContextProvider[] {
  return [
    SYSTEM_PROVIDER,
    ROLE_PROVIDER,
    HOME_PROVIDER,
    OWNER_PROVIDER,
    SKILLS_PROVIDER,
  ];
}
