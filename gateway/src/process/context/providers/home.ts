import type { PromptContextProvider, PromptSection } from "../types";

const TEXT_ENCODER = new TextEncoder();

export function createHomeKnowledgeProvider(): PromptContextProvider {
  return {
    name: "home.knowledge",
    async collect(input) {
      const sections: PromptSection[] = [];
      const homeKey = input.identity.home.replace(/^\//, "");

      const constitutionKey = `${homeKey}/CONSTITUTION.md`;
      const constitutionObj = await input.storage.get(constitutionKey);
      if (constitutionObj) {
        const text = (await constitutionObj.text()).trim();
        if (text) {
          sections.push({
            name: "home.constitution",
            text,
          });
        }
      }

      const contextPrefix = `${homeKey}/context.d/`;
      const listed = await input.storage.list({ prefix: contextPrefix });
      const contextFiles = listed.objects
        .filter((object) => object.key.endsWith(".md"))
        .map((object) => ({
          key: object.key,
          name: object.key.slice(contextPrefix.length),
        }))
        .sort((left, right) => left.name.localeCompare(right.name));

      let usedBytes = 0;
      for (const file of contextFiles) {
        const object = await input.storage.get(file.key);
        if (!object) {
          continue;
        }
        const text = (await object.text()).trim();
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
