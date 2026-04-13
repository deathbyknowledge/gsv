import type { PromptContextProvider } from "../types";

export function createProcessContextProvider(): PromptContextProvider {
  return {
    name: "process.context",
    async collect(input) {
      return [...(input.processContextFiles ?? [])]
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((file) => ({
          name: `process.context:${file.name}`,
          text: file.text.trim(),
        }))
        .filter((section) => section.text.length > 0);
    },
  };
}
