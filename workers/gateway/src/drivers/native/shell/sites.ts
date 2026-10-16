import { defineCommand, type ExecResult } from "just-bash";
import { cancelBinaryBody, siteSlugSchema } from "@humansandmachines/gsv/protocol";
import type { RepoCreateResult, RepoReadResult, SiteListResult, SiteResult } from "@humansandmachines/gsv/protocol";
import { requirePrincipal, type KernelContext } from "../../../kernel/context";
import type { RequestFrame } from "../../../protocol/frames";
import { publishSiteProject } from "../../../sites/build";
import { siteStarterFiles } from "../../../sites/starter";
import type { NativeShellCommandOptions } from "./commands";
import { requireCommandCapability, requireShellOptionValue } from "./common";

const HELP = `Usage:
  sites init NAME
  sites publish [OWNER/REPO] --target COMPUTER
  sites list
  sites unpublish NAME

Run on gsv. Init creates a React/TypeScript project in /src/repos/YOUR-ACCOUNT/NAME.
Edit those files with ordinary tools. Publish builds that saved source on the
selected Linux computer and returns its public URL. Omit OWNER/REPO from inside
the repository, or use NAME for a repository owned by your current account.
site.json contains the slug, title, description and build output directory.
The computer needs Node.js and npm. Set the Shell timeout to 300000 ms for builds.
The computer can stop after publishing.
`;

export function buildSitesCommand(ctx: KernelContext, options: NativeShellCommandOptions = {}, publish = publishSiteProject) {
  return defineCommand("sites", async (argv, shell): Promise<ExecResult> => {
    try {
      if (!argv.length || ["help", "--help", "-h"].includes(argv[0])) return { stdout: HELP, stderr: "", exitCode: 0 };
      const [verb, ...args] = argv;
      const words: string[] = [];
      let target: string | undefined;
      for (let i = 0; i < args.length; i++) {
        if (args[i] === "--target" && verb === "publish" && target === undefined) {
          target = requireShellOptionValue(args[++i], "--target");
        } else if (args[i].startsWith("-")) throw new Error(`Unexpected option: ${args[i]}`);
        else words.push(args[i]);
      }
      if (words.length > 1) throw new Error(HELP);
      const signal = ctx.requestSignal && shell.signal ? AbortSignal.any([ctx.requestSignal, shell.signal]) : ctx.requestSignal ?? shell.signal;
      const request = async (frame: RequestFrame) => {
        requireCommandCapability(ctx, frame.call);
        signal?.throwIfAborted();
        if (!options.request) throw new Error("Direct syscall transport is unavailable");
        const response = await options.request(frame, signal);
        if (!response.ok) throw new Error(response.error.message);
        await cancelBinaryBody(response.body, "Site commands return metadata only");
        signal?.throwIfAborted();
        return response.data;
      };
      if (verb === "init" && words.length === 1) {
        const slug = siteSlugSchema.parse(words[0]);
        const repo = `${requirePrincipal(ctx).account.username}/${slug}`;
        for (const call of ["repo.create", "repo.read", "repo.apply"]) requireCommandCapability(ctx, call);
        // SAFETY: Each typed request is paired with its own Kernel response.
        const created = await request({ type: "req", id: crypto.randomUUID(), call: "repo.create", args: { repo } }) as RepoCreateResult;
        if (!created.head) throw new Error("Repository has no initial revision");
        // SAFETY: The response is paired with this repo.read request.
        const contents = await request({ type: "req", id: crypto.randomUUID(), call: "repo.read", args: { repo, ref: created.head } }) as RepoReadResult;
        if (contents.kind !== "tree" || contents.entries.length) throw new Error("Repository already has files; edit and publish it instead");
        await request({ type: "req", id: crypto.randomUUID(), call: "repo.apply", args: {
          repo, expectedHead: created.head, message: `create ${slug} site`,
          ops: Object.entries(siteStarterFiles(slug)).map(([path, content]) => ({ type: "put", path, content })),
        } });
        return { stdout: `/src/repos/${repo}\n`, stderr: "", exitCode: 0 };
      }
      if (verb === "publish") {
        if (!target || target === "gsv") throw new Error("Choose a Linux computer with --target COMPUTER");
        const repo = words[0]
          ? words[0].includes("/") ? words[0] : `${requirePrincipal(ctx).account.username}/${words[0]}`
          : /^\/src\/repos\/([^/]+\/[^/]+)(?:\/|$)/.exec(shell.cwd)?.[1];
        if (!repo) throw new Error("Choose OWNER/REPO or run from /src/repos/OWNER/REPO");
        const published = await publish({ repo, target }, ctx, options, signal);
        return { stdout: `${published.shareUrl}\n`, stderr: "", exitCode: 0 };
      }
      if ((verb === "list" && words.length === 0) || (verb === "unpublish" && words.length === 1)) {
        if (verb === "unpublish") siteSlugSchema.parse(words[0]);
        // SAFETY: The response is paired with this site.list request.
        const { sites } = await request({ type: "req", id: crypto.randomUUID(), call: "site.list", args: {} }) as SiteListResult;
        if (verb === "list") {
          const origin = ctx.installationIdentity?.canonicalOrigin;
          if (!origin) throw new Error("Installation identity is unavailable");
          return { stdout: sites.map(site => `${site.slug}\t${new URL(`/public/${site.slug}`, origin).href}`).join("\n") + (sites.length ? "\n" : ""), stderr: "", exitCode: 0 };
        }
        const site = sites.find(value => value.slug === words[0]);
        if (!site) throw new Error("Site not found");
        // SAFETY: The response is paired with this site.get request.
        const current = await request({ type: "req", id: crypto.randomUUID(), call: "site.get", args: { siteId: site.id } }) as SiteResult;
        await request({ type: "req", id: crypto.randomUUID(), call: "site.unpublish", args: { siteId: site.id, expectedRevision: current.publication.revision } });
        return { stdout: `Unpublished ${site.slug}\n`, stderr: "", exitCode: 0 };
      }
      throw new Error(HELP);
    } catch (error) {
      return { stdout: "", stderr: `sites: ${error instanceof Error ? error.message : String(error)}\n`, exitCode: 1 };
    }
  });
}
