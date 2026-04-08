import type { PromptContextProvider } from "../types";

export function createProfileInstructionsProvider(): PromptContextProvider {
  return {
    name: "profile.instructions",
    async collect(input) {
      const text = input.config.profileSystemPrompt?.trim() ?? "";
      if (!text) {
        return [];
      }
      return [
        {
          name: `profile.instructions:${input.profile}`,
          text,
        },
      ];
    },
  };
}
