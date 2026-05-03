import { renderSkillIndex } from "../../../kernel/skills";
import type { PromptContextProvider } from "../types";

export function createSkillIndexProvider(): PromptContextProvider {
  return {
    name: "available.skills",
    async collect(input) {
      return [
        {
          name: "available.skills",
          text: renderSkillIndex(input.config.skillIndex ?? []),
        },
      ];
    },
  };
}
