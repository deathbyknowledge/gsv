import type { ProcessIdentity } from "@humansandmachines/gsv/protocol";
import { RipgitClient, type RipgitApplyOp } from "../fs/ripgit/client";
import { contextFiles } from "../prompts/context";
import { seedAccountHome } from "./account-home";
import type { KernelContext } from "./context";
import { registerRepo } from "./repo";

// Owner context files were numbered before standing context was grouped by file name.
const NUMBERED_NAMES = new Map([["personal.md", "10-personal.md"]]);

export async function ensurePersonalMemory(
  ctx: KernelContext,
  human: ProcessIdentity,
): Promise<void> {
  // Seed each missing owner context file, or move its numbered predecessor to the current name.
  await seedAccountHome(ctx.env, human, "gsv: scaffold owner context", async (client, snapshot) => {
    const ops: RipgitApplyOp[] = [];
    for (const file of contextFiles("user")) {
      const path = `context.d/${file.name}`;
      if ((await client.readPath(snapshot, path)).kind !== "missing") continue;
      const numbered = NUMBERED_NAMES.get(file.name);
      if (numbered && (await client.readPath(snapshot, `context.d/${numbered}`)).kind === "file") {
        ops.push({ type: "move", from: `context.d/${numbered}`, to: path });
      } else {
        ops.push({ type: "put", path, contentBytes: Array.from(new TextEncoder().encode(file.text)) });
      }
    }
    return ops;
  });
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
