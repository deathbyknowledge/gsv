import { homeKnowledgeRepoRef } from "../../../fs/ripgit/repos";
import type { PromptContextProvider, PromptSection } from "../types";

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

/**
 * Layers the owning human's `~/context.d` into the prompt, so an agent account
 * sees the context of the person it works for in addition to its own home
 * (provided by the home context provider). No-op when the process runs as its
 * own owner (no distinct agent account).
 */
export function createOwnerContextProvider(): PromptContextProvider {
  return {
    name: "owner.context",
    async collect(input) {
      const owner = input.ownerIdentity;
      if (!owner || owner.username === input.identity.username) {
        return [];
      }

      const sections: PromptSection[] = [];
      const repo = homeKnowledgeRepoRef(owner.username);

      if (input.ripgit) {
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
                `[Prompt] owner context.d budget exceeded at ${name}, skipping remaining`,
              );
              break;
            }
            usedBytes += bytes;
            sections.push({
              name,
              text,
              contextRoot: {
                key: "user",
                label: "USER",
                access: "editable",
                location: `${owner.home}/context.d`,
              },
            });
          }

          return sections;
        }
      }

      const homeKey = owner.home.replace(/^\//, "");
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
            `[Prompt] owner context.d budget exceeded at ${file.name}, skipping remaining`,
          );
          break;
        }
        usedBytes += bytes;
        sections.push({
          name: file.name,
          text,
          contextRoot: {
            key: "user",
            label: "USER",
            access: "editable",
            location: `${owner.home}/context.d`,
          },
        });
      }

      return sections;
    },
  };
}
