import { workspaceRepoRef } from "../../../fs/ripgit/repos";
import type { PromptContextProvider } from "../types";

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

export function createWorkspaceContextProvider(): PromptContextProvider {
  return {
    name: "workspace.context",
    async collect(input) {
      if (!input.identity.workspaceId || !input.ripgit) {
        return [];
      }

      const repo = workspaceRepoRef(
        input.identity.workspaceId,
        input.identity.uid,
      );
      const contextTree = await input.ripgit.readPath(repo, ".gsv/context.d");
      if (contextTree.kind === "tree") {
        const contextFiles = contextTree.entries
          .filter((entry) => entry.type === "blob" && entry.name.endsWith(".md"))
          .map((entry) => entry.name)
          .sort((left, right) => left.localeCompare(right));

        const sections = [];
        let usedBytes = 0;
        for (const name of contextFiles) {
          const file = await input.ripgit.readPath(repo, `.gsv/context.d/${name}`);
          if (file.kind !== "file") {
            continue;
          }

          const text = TEXT_DECODER.decode(file.bytes).trim();
          if (!text) {
            continue;
          }

          const bytes = TEXT_ENCODER.encode(text).length;
          if (usedBytes + bytes > input.config.maxContextBytes) {
            break;
          }
          usedBytes += bytes;
          sections.push({
            name: `workspace.context:${name}`,
            text,
          });
        }
        if (sections.length > 0) {
          return sections;
        }
      }

      const result = await input.ripgit.readPath(repo, ".gsv/summary.md");
      if (result.kind !== "file") {
        return [];
      }
      const summary = TEXT_DECODER.decode(result.bytes).trim();
      if (!summary) {
        return [];
      }

      return [
        {
          name: "workspace.context:summary.md",
          text: summary,
        },
      ];
    },
  };
}
