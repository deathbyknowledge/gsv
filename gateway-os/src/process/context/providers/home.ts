import type { PromptContextProvider, PromptSection } from "../types";

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

export function createHomeKnowledgeProvider(): PromptContextProvider {
  return {
    name: "home.knowledge",
    async collect(input) {
      if (!input.knowledge) {
        return [];
      }

      const sections: PromptSection[] = [];
      const constitutionResult = await input.knowledge.read("CONSTITUTION.md");
      if (constitutionResult.kind === "file") {
        const text = TEXT_DECODER.decode(constitutionResult.bytes).trim();
        if (text) {
          sections.push({
            name: "home.constitution",
            text,
          });
        }
      }

      const contextFiles = (await input.knowledge.list("context.d"))
        .filter((entry) => entry.kind === "file" && entry.path.endsWith(".md"))
        .map((entry) => ({
          path: entry.path,
          name: entry.path.slice("context.d/".length),
        }))
        .sort((left, right) => left.name.localeCompare(right.name));

      let usedBytes = 0;
      for (const file of contextFiles) {
        const result = await input.knowledge.read(file.path);
        if (result.kind !== "file") {
          continue;
        }
        const text = TEXT_DECODER.decode(result.bytes).trim();
        if (!text) {
          continue;
        }

        const bytes = TEXT_ENCODER.encode(text).length;
        if (usedBytes + bytes > input.config.maxContextBytes) {
          console.warn(
            `[Prompt] context.d budget exceeded at ${file.name}, skipping remaining`,
          );
          break;
        }
        usedBytes += bytes;
        sections.push({
          name: `home.context:${file.name}`,
          text,
        });
      }

      return sections;
    },
  };
}
