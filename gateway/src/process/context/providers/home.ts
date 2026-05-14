import { homeKnowledgeRepoRef } from "../../../fs/ripgit/repos";
import type { PromptContextProvider, PromptSection } from "../types";

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

export function createHomeContextProvider(): PromptContextProvider {
  return {
    name: "home.context",
    async collect(input) {
      return collectHomeMarkdownDirectory(input, {
        directory: "context.d",
        sectionPrefix: "home.context",
      });
    },
  };
}

export function createMindContextProvider(): PromptContextProvider {
  return {
    name: "mind.context",
    async collect(input) {
      if (input.profile !== "mind") {
        return [];
      }
      return collectHomeMarkdownDirectory(input, {
        directory: "mind.d",
        sectionPrefix: "mind.context",
      });
    },
  };
}

async function collectHomeMarkdownDirectory(
  input: Parameters<PromptContextProvider["collect"]>[0],
  options: {
    directory: string;
    sectionPrefix: string;
  },
): Promise<PromptSection[]> {
  const sections: PromptSection[] = [];
  const repo = homeKnowledgeRepoRef(input.identity.username);

  if (input.ripgit) {
    const contextTree = await input.ripgit.readPath(repo, options.directory);
    if (contextTree.kind === "tree") {
      const contextFiles = contextTree.entries
        .filter((entry) => entry.type === "blob" && entry.name.endsWith(".md"))
        .map((entry) => entry.name)
        .sort((left, right) => left.localeCompare(right));

      let usedBytes = 0;
      for (const name of contextFiles) {
        const file = await input.ripgit.readPath(repo, `${options.directory}/${name}`);
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
            `[Prompt] ${options.directory} budget exceeded at ${name}, skipping remaining`,
          );
          break;
        }
        usedBytes += bytes;
        sections.push({
          name: `${options.sectionPrefix}:${name}`,
          text,
        });
      }

      return sections;
    }
  }

  const homeKey = input.identity.home.replace(/^\//, "");
  const contextPrefix = `${homeKey}/${options.directory}/`;
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
        `[Prompt] ${options.directory} budget exceeded at ${file.name}, skipping remaining`,
      );
      break;
    }
    usedBytes += bytes;
    sections.push({
      name: `${options.sectionPrefix}:${file.name}`,
      text,
    });
  }

  return sections;
}
