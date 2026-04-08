import { workspaceRepoRef } from "../../../fs/ripgit/repos";
import type { PromptContextProvider } from "../types";

const TEXT_DECODER = new TextDecoder();

export function createWorkspaceSummaryProvider(): PromptContextProvider {
  return {
    name: "workspace.summary",
    async collect(input) {
      if (!input.identity.workspaceId || !input.ripgit) {
        return [];
      }

      const repo = workspaceRepoRef(
        input.identity.workspaceId,
        input.identity.uid,
      );
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
          name: "workspace.summary",
          text: [
            "Current workspace summary:",
            summary,
          ].join("\n\n"),
        },
      ];
    },
  };
}
