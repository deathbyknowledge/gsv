import { renderSkillIndex } from "../../../kernel/skills";
import type { PromptContextProvider } from "../types";

export function createSkillIndexProvider(): PromptContextProvider {
  return {
    name: "available.skills",
    async collect(input) {
      const mode = input.config.skillIndexMode ?? "summary";
      if (mode === "off") {
        return [];
      }
      return [
        {
          name: "available.skills",
          text: renderSkillIndex(input.config.skillIndex ?? [], mode),
        },
      ];
    },
  };
}
