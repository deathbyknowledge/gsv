import type { PromptContextProvider } from "../types";

export function createProcessContextProvider(): PromptContextProvider {
  return {
    name: "process.context",
    async collect(input) {
      return [...(input.processContextFiles ?? [])]
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((file) => ({
          name: file.name,
          text: file.text.trim(),
          contextRoot: {
            key: "process" as const,
            label: "PROCESS",
            access: "read-only" as const,
            location: "current process assignment",
          },
        }))
        .filter((section) => section.text.length > 0);
    },
  };
}
