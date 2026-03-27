import type { PromptContextProvider } from "../types";

export function createBaseSystemPromptProvider(): PromptContextProvider {
  return {
    name: "base.system_prompt",
    async collect(input) {
      const text = input.config.systemPrompt.trim();
      if (!text) {
        return [];
      }
      return [{ name: "base.system_prompt", text }];
    },
  };
}
