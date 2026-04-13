import { homeKnowledgeRepoRef } from "../../../fs/ripgit/repos";
import type { PromptContextProvider, PromptSection } from "../types";

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

export function createHomeKnowledgeProvider(): PromptContextProvider {
  return {
    name: "home.knowledge",
    async collect(input) {
      const sections: PromptSection[] = [];
      const repo = homeKnowledgeRepoRef(input.identity.uid);

      if (input.ripgit) {
        const constitution = await input.ripgit.readPath(repo, "CONSTITUTION.md");
        if (constitution.kind === "file") {
          const text = TEXT_DECODER.decode(constitution.bytes).trim();
          if (text) {
            sections.push({
              name: "home.constitution",
              text,
            });
          }
        }

        const contextTree = await input.ripgit.readPath(repo, "context.d");
        if (contextTree.kind === "tree") {
          const contextFiles = contextTree.entries
            .filter((entry) => entry.type === "blob" && entry.name.endsWith(".md"))
            .map((entry) => entry.name)
            .sort((left, right) => left.localeCompare(right));

          let usedBytes = 0;
          for (const name of contextFiles) {
            const file = await input.ripgit.readPath(repo, `context.d/${name}`);
            if (file.kind !== "file") {
              continue;
            }

            const text = TEXT_DECODER.decode(file.bytes).trim();
            if (!text) {
              continue;
            }

            const bytes = TEXT_ENCODER.encode(text).length;
            if (usedBytes + bytes > input.config.maxContextBytes) {
              console.warn(
                `[Prompt] context.d budget exceeded at ${name}, skipping remaining`,
              );
              break;
            }
            usedBytes += bytes;
            sections.push({
              name: `home.context:${name}`,
              text,
            });
          }

          return sections;
        }
      }

      const homeKey = input.identity.home.replace(/^\//, "");
      const constitutionKey = `${homeKey}/CONSTITUTION.md`;
      const constitutionObj = await input.storage.get(constitutionKey);
      if (constitutionObj && !sections.some((section) => section.name === "home.constitution")) {
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
