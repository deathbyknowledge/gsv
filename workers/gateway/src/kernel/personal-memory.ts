import type { ProcessIdentity } from "@humansandmachines/gsv/protocol";
import { RipgitClient } from "../fs/ripgit/client";
import { contextFiles } from "../prompts/context";
import { seedContextFile } from "./accounts";
import type { KernelContext } from "./context";
import { registerRepo } from "./repo";

export async function ensurePersonalMemory(
  ctx: KernelContext,
  human: ProcessIdentity,
): Promise<void> {
  for (const file of contextFiles("user")) {
    await seedContextFile(ctx.env, human, file.name, file.text);
  }
  if (!ctx.env.RIPGIT) {
    return;
  }

  const repo = {
    owner: human.username,
    repo: "personal",
    branch: "main",
  };
  const ripgit = new RipgitClient(ctx.env.RIPGIT);
  if ((await ripgit.readPath(repo, "wiki.json")).kind === "missing") {
    await ripgit.apply(
      repo,
      human.username,
      `${human.username}@gsv.local`,
      "wiki: init personal",
      [
        {
          type: "put",
          path: "wiki.json",
          contentBytes: Array.from(new TextEncoder().encode(`${JSON.stringify({
            kind: "gsv.wiki",
            version: 1,
            id: "personal",
            title: "Personal",
          }, null, 2)}\n`)),
        },
        {
          type: "put",
          path: "index.md",
          contentBytes: Array.from(new TextEncoder().encode(
            "# Personal\n\n## Pages\n\n- _No pages yet._\n",
          )),
        },
        ...[
          "inbox/.dir",
          "pages/journal/.dir",
          "pages/people/.dir",
          "pages/projects/.dir",
          "pages/preferences/.dir",
          "pages/decisions/.dir",
          "pages/routines/.dir",
          "pages/places/.dir",
          "pages/concepts/.dir",
        ].map((path) => ({ type: "put" as const, path, contentBytes: [] })),
      ],
    );
  }
  registerRepo(ctx, repo, "Personal memory");
}
