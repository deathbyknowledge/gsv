import { defineCommand } from "just-bash";
import type { ExecResult } from "just-bash";
import {
  commitRepoSourceChanges,
  diffRepoSourceChanges,
  discardRepoSourceChanges,
  getRepoSourceStatus,
  RipgitClient,
} from "../../../fs";
import type { KernelContext } from "../../../kernel/context";
import {
  handleRepoCompare,
  handleRepoCreate,
  handleRepoDiff,
  handleRepoImport,
  handleRepoList,
  handleRepoLog,
  handleRepoRead,
  handleRepoRefs,
  handleRepoSearch,
} from "../../../kernel/repo";
import type {
  RepoCompareResult,
  RepoDiffResult,
  RepoListResult,
  RepoLogResult,
  RepoReadResult,
  RepoRefsResult,
  RepoSearchResult,
} from "@humansandmachines/gsv/protocol";
import { requireCommandCapability } from "./common";

type RepoTarget = {
  repo: string;
  nextIndex: number;
  sourcePath?: string;
};

export function buildRgitCommands(ctx: KernelContext) {
  return [
    buildRgitCommand(ctx, "rgit"),
    buildRgitCommand(ctx, "ripgit"),
  ];
}

function buildRgitCommand(ctx: KernelContext, commandName: "rgit" | "ripgit") {
  return defineCommand(commandName, async (args, bashCtx): Promise<ExecResult> => {
    try {
      return await runRgitCommand(args, ctx, bashCtx.cwd, commandName);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        stdout: "",
        stderr: `${commandName}: ${message}\n`,
        exitCode: 1,
      };
    }
  });
}

async function runRgitCommand(
  args: string[],
  ctx: KernelContext,
  cwd: string,
  commandName: "rgit" | "ripgit",
): Promise<ExecResult> {
  const [subcommand = "help", ...rest] = args;

  switch (subcommand) {
    case "help":
    case "--help":
    case "-h":
      return { stdout: rgitUsage(commandName), stderr: "", exitCode: 0 };
    case "list": {
      requireCommandCapability(ctx, "repo.list");
      return { stdout: formatRepoList(handleRepoList(parseListArgs(rest), ctx)), stderr: "", exitCode: 0 };
    }
    case "info": {
      requireCommandCapability(ctx, "repo.list");
      const target = parseRepoTarget(rest, cwd);
      const found = handleRepoList(undefined, ctx).repos.find((repo) => repo.repo === target.repo);
      if (!found) {
        throw new Error(`Repo is not visible: ${target.repo}`);
      }
      return { stdout: formatRepoInfo(found), stderr: "", exitCode: 0 };
    }
    case "path": {
      const target = parseRepoTarget(rest, cwd);
      return { stdout: `/src/repos/${target.repo}\n`, stderr: "", exitCode: 0 };
    }
    case "read": {
      requireCommandCapability(ctx, "repo.read");
      const parsed = parseReadArgs(rest, cwd);
      const result = await handleRepoRead(withDefaultRepoRef(parsed, ctx), ctx);
      return { stdout: formatRepoRead(result), stderr: "", exitCode: 0 };
    }
    case "search": {
      requireCommandCapability(ctx, "repo.search");
      const parsed = parseSearchArgs(rest, cwd);
      const result = await handleRepoSearch(withDefaultRepoRef(parsed, ctx), ctx);
      return { stdout: formatRepoSearch(result), stderr: "", exitCode: 0 };
    }
    case "refs": {
      requireCommandCapability(ctx, "repo.refs");
      const target = parseRepoTarget(rest, cwd);
      const result = await handleRepoRefs({ repo: target.repo }, ctx);
      return { stdout: formatRepoRefs(result), stderr: "", exitCode: 0 };
    }
    case "log": {
      requireCommandCapability(ctx, "repo.log");
      const parsed = parseLogArgs(rest, cwd);
      const result = await handleRepoLog(withDefaultRepoRef(parsed, ctx), ctx);
      return { stdout: formatRepoLog(result), stderr: "", exitCode: 0 };
    }
    case "status": {
      requireCommandCapability(ctx, "repo.list");
      const target = parseRepoTarget(rest, cwd);
      const result = await getRepoSourceStatus(processSourceOptions(ctx), target.repo, target.sourcePath);
      return { stdout: formatRepoStatus(result), stderr: "", exitCode: 0 };
    }
    case "diff": {
      const parsed = parseDiffArgs(rest, cwd);
      if (parsed.commit) {
        requireCommandCapability(ctx, "repo.diff");
        const result = await handleRepoDiff({
          repo: parsed.repo,
          commit: parsed.commit,
          ...(typeof parsed.context === "number" ? { context: parsed.context } : {}),
        }, ctx);
        return { stdout: formatRepoDiff(result), stderr: "", exitCode: 0 };
      }
      requireCommandCapability(ctx, "repo.read");
      const diff = await diffRepoSourceChanges(processSourceOptions(ctx), parsed.repo, parsed.sourcePath);
      return { stdout: diff, stderr: "", exitCode: 0 };
    }
    case "compare": {
      requireCommandCapability(ctx, "repo.compare");
      const parsed = parseCompareArgs(rest, cwd);
      const result = await handleRepoCompare(parsed, ctx);
      return { stdout: formatRepoCompare(result), stderr: "", exitCode: 0 };
    }
    case "commit": {
      requireCommandCapability(ctx, "repo.apply");
      const parsed = parseCommitArgs(rest, cwd);
      const result = await commitRepoSourceChanges(processSourceOptions(ctx), parsed.repo, {
        message: parsed.message,
        ...(parsed.branch ? { branch: parsed.branch } : {}),
        ...(parsed.sourcePath ? { sourcePath: parsed.sourcePath } : {}),
      });
      return {
        stdout: result.committed
          ? `committed ${result.repo} to ${result.branch ?? result.sourceRef} ${result.commitHead ?? "-"} (${result.ops} ops)\n`
          : `no staged repo changes for ${result.repo}\n`,
        stderr: "",
        exitCode: 0,
      };
    }
    case "discard": {
      requireCommandCapability(ctx, "repo.apply");
      const target = parseRepoTarget(rest, cwd);
      const before = await getRepoSourceStatus(processSourceOptions(ctx), target.repo, target.sourcePath);
      await discardRepoSourceChanges(processSourceOptions(ctx), target.repo, target.sourcePath);
      return {
        stdout: `discarded ${before.changes.length} staged repo change(s) for ${target.repo}\n`,
        stderr: "",
        exitCode: 0,
      };
    }
    case "create": {
      requireCommandCapability(ctx, "repo.create");
      const parsed = parseCreateArgs(rest);
      const result = await handleRepoCreate(parsed, ctx);
      return {
        stdout: `${result.created ? "created" : "exists"} ${result.repo} (${result.ref}) ${result.head ?? "-"}\n`,
        stderr: "",
        exitCode: 0,
      };
    }
    case "import": {
      requireCommandCapability(ctx, "repo.import");
      const parsed = parseImportArgs(rest, cwd, true);
      const result = await handleRepoImport(parsed, ctx);
      return {
        stdout: `${result.changed ? "imported" : "unchanged"} ${result.repo} (${result.ref}) ${result.head ?? "-"}\n`,
        stderr: result.diverged ? `diverged: fetched upstream into ${result.trackingRef ?? "the upstream tracking ref"} without moving ${result.ref}\n` : "",
        exitCode: 0,
      };
    }
    case "pull": {
      requireCommandCapability(ctx, "repo.import");
      const parsed = parseImportArgs(rest, cwd, false);
      const result = await handleRepoImport(parsed, ctx);
      return {
        stdout: `${result.changed ? "pulled" : "unchanged"} ${result.repo} (${result.ref}) ${result.head ?? "-"}\n`,
        stderr: result.diverged ? `diverged: fetched upstream into ${result.trackingRef ?? "the upstream tracking ref"} without moving ${result.ref}\n` : "",
        exitCode: 0,
      };
    }
    default:
      throw new Error(`Unknown rgit subcommand: ${subcommand}`);
  }
}

function processSourceOptions(ctx: KernelContext) {
  const identity = ctx.identity!.process;
  return {
    identity,
    storage: ctx.env.STORAGE,
    ripgit: ctx.env.RIPGIT ? new RipgitClient(ctx.env.RIPGIT) : null,
    repos: handleRepoList(undefined, ctx).repos,
    processId: ctx.processId ?? null,
    config: ctx.config,
  };
}

function withDefaultRepoRef<T extends { repo: string; ref?: string; sourcePath?: string }>(parsed: T, ctx: KernelContext): T {
  if (parsed.ref) {
    return parsed;
  }
  const ref = defaultRepoRef(ctx, parsed.repo, parsed.sourcePath);
  return ref ? { ...parsed, ref } : parsed;
}

function defaultRepoRef(ctx: KernelContext, repo: string, sourcePath?: string): string | null {
  const found = handleRepoList(undefined, ctx).repos.find((summary) => summary.repo === repo);
  if (!found) {
    return null;
  }
  const source = sourcePath ? repoSourceForPath(found, sourcePath) : null;
  return source?.ref ?? found.ref ?? null;
}

function repoSourceForPath(
  summary: RepoListResult["repos"][number],
  sourcePath: string,
): NonNullable<RepoListResult["repos"][number]["sources"]>[number] | null {
  const rootPath = `/src/repos/${summary.repo}`;
  if (sourcePath !== rootPath && !sourcePath.startsWith(`${rootPath}/`)) {
    return null;
  }
  const relativePath = sourcePath === rootPath
    ? ""
    : normalizeRepoPath(sourcePath.slice(rootPath.length + 1));
  const matches = (summary.sources ?? [])
    .map((source) => ({
      source,
      subdir: normalizeRepoPath(source.subdir),
    }))
    .filter((entry) => pathIsWithin(relativePath, entry.subdir))
    .sort((left, right) => right.subdir.length - left.subdir.length);
  return matches[0]?.source ?? null;
}

function parseRepoTarget(args: string[], cwd: string, startIndex = 0): RepoTarget {
  const current = String(args[startIndex] ?? "").trim();
  if (current === "--here") {
    return { ...repoTargetFromCwd(cwd), nextIndex: startIndex + 1 };
  }
  if (!current) {
    throw new Error("repo is required; pass owner/repo or --here from under /src/repos/{owner}/{repo}");
  }
  return { repo: normalizeRepoArg(current), nextIndex: startIndex + 1 };
}

function repoTargetFromCwd(cwd: string): { repo: string; sourcePath: string } {
  const match = cwd.match(/^\/src\/repos\/([^/]+)\/([^/]+)(?:\/|$)/);
  if (!match) {
    throw new Error("--here requires cwd under /src/repos/{owner}/{repo}");
  }
  return {
    repo: `${match[1]}/${match[2]}`,
    sourcePath: cwd,
  };
}

function normalizeRepoArg(raw: string): string {
  const [owner, repo, extra] = raw.replace(/^\/+|\/+$/g, "").split("/");
  if (!owner || !repo || extra) {
    throw new Error(`Invalid repo: ${raw}`);
  }
  return `${owner}/${repo}`;
}

function normalizeRepoPath(path: string | null | undefined): string {
  return String(path ?? "")
    .trim()
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".")
    .join("/");
}

function pathIsWithin(path: string, maybeParent: string): boolean {
  const normalizedPath = normalizeRepoPath(path);
  const normalizedParent = normalizeRepoPath(maybeParent);
  return !normalizedParent || normalizedPath === normalizedParent || normalizedPath.startsWith(`${normalizedParent}/`);
}

function parseListArgs(args: string[]): { owner?: string } {
  const parsed: { owner?: string } = {};
  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (current === "--owner") {
      const owner = String(args[index + 1] ?? "").trim();
      if (!owner || owner.startsWith("-")) {
        throw new Error("Usage: rgit list [--owner USER]");
      }
      parsed.owner = owner;
      index += 1;
      continue;
    }
    throw new Error(`Unknown rgit list argument: ${current}`);
  }
  return parsed;
}

function parseReadArgs(args: string[], cwd: string): { repo: string; ref?: string; path?: string; sourcePath?: string } {
  const target = parseRepoTarget(args, cwd);
  const parsed: { repo: string; ref?: string; path?: string; sourcePath?: string } = {
    repo: target.repo,
    ...(target.sourcePath ? { sourcePath: target.sourcePath } : {}),
  };
  for (let index = target.nextIndex; index < args.length; index += 1) {
    const current = args[index];
    if (current === "--ref") {
      const ref = String(args[index + 1] ?? "").trim();
      if (!ref || ref.startsWith("-")) throw new Error("Usage: rgit read <repo|--here> [path] [--ref REF]");
      parsed.ref = ref;
      index += 1;
      continue;
    }
    if (!parsed.path) {
      parsed.path = current;
      continue;
    }
    throw new Error(`Unknown rgit read argument: ${current}`);
  }
  return parsed;
}

function parseSearchArgs(args: string[], cwd: string): { repo: string; ref?: string; query: string; prefix?: string; sourcePath?: string } {
  const target = parseRepoTarget(args, cwd);
  const parsed: { repo: string; ref?: string; query?: string; prefix?: string; sourcePath?: string } = {
    repo: target.repo,
    ...(target.sourcePath ? { sourcePath: target.sourcePath } : {}),
  };
  for (let index = target.nextIndex; index < args.length; index += 1) {
    const current = args[index];
    if (current === "--ref") {
      parsed.ref = requireValue(args, index, "Usage: rgit search <repo|--here> <query> [--prefix PATH] [--ref REF]");
      index += 1;
      continue;
    }
    if (current === "--prefix") {
      parsed.prefix = requireValue(args, index, "Usage: rgit search <repo|--here> <query> [--prefix PATH] [--ref REF]");
      index += 1;
      continue;
    }
    if (!parsed.query) {
      parsed.query = current;
      continue;
    }
    throw new Error(`Unknown rgit search argument: ${current}`);
  }
  if (!parsed.query) {
    throw new Error("Usage: rgit search <repo|--here> <query> [--prefix PATH] [--ref REF]");
  }
  return parsed as { repo: string; ref?: string; query: string; prefix?: string; sourcePath?: string };
}

function parseLogArgs(args: string[], cwd: string): { repo: string; ref?: string; limit?: number; offset?: number; sourcePath?: string } {
  const target = parseRepoTarget(args, cwd);
  const parsed: { repo: string; ref?: string; limit?: number; offset?: number; sourcePath?: string } = {
    repo: target.repo,
    ...(target.sourcePath ? { sourcePath: target.sourcePath } : {}),
  };
  for (let index = target.nextIndex; index < args.length; index += 1) {
    const current = args[index];
    if (current === "--ref") {
      parsed.ref = requireValue(args, index, "Usage: rgit log <repo|--here> [--ref REF] [--limit N] [--offset N]");
      index += 1;
      continue;
    }
    if (current === "--limit") {
      parsed.limit = parseInteger(requireValue(args, index, "Usage: rgit log <repo|--here> [--ref REF] [--limit N] [--offset N]"), "limit");
      index += 1;
      continue;
    }
    if (current === "--offset") {
      parsed.offset = parseInteger(requireValue(args, index, "Usage: rgit log <repo|--here> [--ref REF] [--limit N] [--offset N]"), "offset");
      index += 1;
      continue;
    }
    throw new Error(`Unknown rgit log argument: ${current}`);
  }
  return parsed;
}

function parseDiffArgs(args: string[], cwd: string): { repo: string; commit?: string; context?: number; sourcePath?: string } {
  const target = parseRepoTarget(args, cwd);
  const parsed: { repo: string; commit?: string; context?: number; sourcePath?: string } = {
    repo: target.repo,
    ...(target.sourcePath ? { sourcePath: target.sourcePath } : {}),
  };
  for (let index = target.nextIndex; index < args.length; index += 1) {
    const current = args[index];
    if (current === "--context") {
      parsed.context = parseInteger(requireValue(args, index, "Usage: rgit diff <repo|--here> [commit] [--context N]"), "context");
      index += 1;
      continue;
    }
    if (!parsed.commit) {
      parsed.commit = current;
      continue;
    }
    throw new Error(`Unknown rgit diff argument: ${current}`);
  }
  return parsed;
}

function parseCompareArgs(args: string[], cwd: string): { repo: string; base: string; head: string; context?: number; stat?: boolean } {
  const target = parseRepoTarget(args, cwd);
  const positionals: string[] = [];
  const parsed: { repo: string; base?: string; head?: string; context?: number; stat?: boolean } = { repo: target.repo };
  for (let index = target.nextIndex; index < args.length; index += 1) {
    const current = args[index];
    if (current === "--context") {
      parsed.context = parseInteger(requireValue(args, index, "Usage: rgit compare <repo|--here> <base> <head> [--context N] [--stat]"), "context");
      index += 1;
      continue;
    }
    if (current === "--stat") {
      parsed.stat = true;
      continue;
    }
    positionals.push(current);
  }
  const [base, head, extra] = positionals;
  if (!base || !head || extra) {
    throw new Error("Usage: rgit compare <repo|--here> <base> <head> [--context N] [--stat]");
  }
  return { ...parsed, base, head };
}

function parseCommitArgs(args: string[], cwd: string): { repo: string; message: string; branch?: string; sourcePath?: string } {
  const target = parseRepoTarget(args, cwd);
  const parsed: { repo: string; message?: string; branch?: string; sourcePath?: string } = {
    repo: target.repo,
    ...(target.sourcePath ? { sourcePath: target.sourcePath } : {}),
  };
  for (let index = target.nextIndex; index < args.length; index += 1) {
    const current = args[index];
    if (current === "--message" || current === "-m") {
      parsed.message = requireValue(args, index, "Usage: rgit commit <repo|--here> --message TEXT [--branch BRANCH]");
      index += 1;
      continue;
    }
    if (current === "--branch") {
      parsed.branch = requireValue(args, index, "Usage: rgit commit <repo|--here> --message TEXT [--branch BRANCH]");
      index += 1;
      continue;
    }
    throw new Error(`Unknown rgit commit argument: ${current}`);
  }
  if (!parsed.message) {
    throw new Error("Usage: rgit commit <repo|--here> --message TEXT [--branch BRANCH]");
  }
  return parsed as { repo: string; message: string; branch?: string; sourcePath?: string };
}

function parseCreateArgs(args: string[]): { repo: string; ref?: string; description?: string } {
  const repo = normalizeRepoArg(String(args[0] ?? ""));
  const parsed: { repo: string; ref?: string; description?: string } = { repo };
  for (let index = 1; index < args.length; index += 1) {
    const current = args[index];
    if (current === "--ref") {
      parsed.ref = requireValue(args, index, "Usage: rgit create owner/repo [--ref main] [--description TEXT]");
      index += 1;
      continue;
    }
    if (current === "--description") {
      parsed.description = requireValue(args, index, "Usage: rgit create owner/repo [--ref main] [--description TEXT]");
      index += 1;
      continue;
    }
    throw new Error(`Unknown rgit create argument: ${current}`);
  }
  return parsed;
}

function parseImportArgs(args: string[], cwd: string, requireRemote: boolean): {
  repo: string;
  ref?: string;
  remoteUrl?: string;
  remoteRef?: string;
  message?: string;
} {
  const target = parseRepoTarget(args, cwd);
  const parsed: { repo: string; ref?: string; remoteUrl?: string; remoteRef?: string; message?: string } = { repo: target.repo };
  for (let index = target.nextIndex; index < args.length; index += 1) {
    const current = args[index];
    if (current === "--from" || current === "--remote-url") {
      parsed.remoteUrl = requireValue(args, index, "Usage: rgit import <repo|--here> --from URL [--ref REF] [--remote-ref REF]");
      index += 1;
      continue;
    }
    if (current === "--ref") {
      parsed.ref = requireValue(args, index, "Usage: rgit import <repo|--here> --from URL [--ref REF] [--remote-ref REF]");
      index += 1;
      continue;
    }
    if (current === "--remote-ref") {
      parsed.remoteRef = requireValue(args, index, "Usage: rgit import <repo|--here> --from URL [--ref REF] [--remote-ref REF]");
      index += 1;
      continue;
    }
    if (current === "--message" || current === "-m") {
      parsed.message = requireValue(args, index, "Usage: rgit import <repo|--here> --from URL [--ref REF] [--remote-ref REF]");
      index += 1;
      continue;
    }
    throw new Error(`Unknown rgit ${requireRemote ? "import" : "pull"} argument: ${current}`);
  }
  if (requireRemote && !parsed.remoteUrl) {
    throw new Error("Usage: rgit import <repo|--here> --from URL [--ref REF] [--remote-ref REF]");
  }
  return parsed;
}

function requireValue(args: string[], index: number, usage: string): string {
  const value = String(args[index + 1] ?? "").trim();
  if (!value || value.startsWith("-")) {
    throw new Error(usage);
  }
  return value;
}

function parseInteger(raw: string, name: string): number {
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be a number`);
  }
  return value;
}

function formatRepoList(result: RepoListResult): string {
  const lines = ["REPO\tKIND\tWRITABLE\tPUBLIC\tDESCRIPTION"];
  for (const repo of result.repos) {
    lines.push([
      repo.repo,
      repo.kind,
      repo.writable ? "yes" : "no",
      repo.public ? "yes" : "no",
      repo.description ?? "",
    ].join("\t"));
  }
  return `${lines.join("\n")}\n`;
}

function formatRepoInfo(repo: RepoListResult["repos"][number]): string {
  return [
    `Repo: ${repo.repo}`,
    `Kind: ${repo.kind}`,
    `Path: /src/repos/${repo.repo}`,
    `Writable: ${repo.writable ? "yes" : "no"}`,
    `Public: ${repo.public ? "yes" : "no"}`,
    `Description: ${repo.description ?? ""}`,
    "",
  ].join("\n");
}

function formatRepoRead(result: RepoReadResult): string {
  if (result.kind === "file") {
    return result.content === null
      ? `Binary file (${result.size} bytes): ${result.path}\n`
      : result.content.endsWith("\n") ? result.content : `${result.content}\n`;
  }
  const lines = ["MODE\tTYPE\tPATH"];
  for (const entry of result.entries) {
    lines.push([entry.mode, entry.type, entry.path].join("\t"));
  }
  return `${lines.join("\n")}\n`;
}

function formatRepoSearch(result: RepoSearchResult): string {
  if (result.matches.length === 0) {
    return `No matches for ${JSON.stringify(result.query)} in ${result.repo}\n`;
  }
  return `${result.matches.map((match) => `${match.path}:${match.line}: ${match.content}`).join("\n")}\n`;
}

function formatRepoRefs(result: RepoRefsResult): string {
  const lines = ["TYPE\tNAME\tHASH"];
  for (const [name, hash] of Object.entries(result.heads)) {
    lines.push(["head", name, hash].join("\t"));
  }
  for (const [name, hash] of Object.entries(result.tags)) {
    lines.push(["tag", name, hash].join("\t"));
  }
  for (const [name, hash] of Object.entries(result.remotes ?? {})) {
    lines.push(["remote", name, hash].join("\t"));
  }
  return `${lines.join("\n")}\n`;
}

function formatRepoLog(result: RepoLogResult): string {
  if (result.entries.length === 0) {
    return `No commits for ${result.repo} (${result.ref})\n`;
  }
  return `${result.entries.map((entry) =>
    [
      entry.hash,
      new Date(entry.commitTime * 1000).toISOString(),
      entry.author,
      entry.message.split("\n", 1)[0],
    ].join("\t")
  ).join("\n")}\n`;
}

function formatRepoStatus(result: Awaited<ReturnType<typeof getRepoSourceStatus>>): string {
  const lines = [
    `Repo: ${result.repo}`,
    `Ref: ${result.sourceRef}`,
    `Base: ${result.baseRef}`,
    `Branch: ${result.branch ?? "-"}`,
    `Head: ${result.head ?? "-"}`,
    "",
  ];
  if (result.changes.length === 0) {
    lines.push("No staged changes.");
  } else {
    lines.push("Changes:");
    for (const change of result.changes) {
      lines.push(`  ${change.type === "put" ? "M" : "D"} ${change.path}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

function formatRepoDiff(result: RepoDiffResult): string {
  return formatDiffFiles(result.stats.filesChanged, result.stats.additions, result.stats.deletions, result.files);
}

function formatRepoCompare(result: RepoCompareResult): string {
  return formatDiffFiles(result.stats.filesChanged, result.stats.additions, result.stats.deletions, result.files);
}

function formatDiffFiles(filesChanged: number, additions: number, deletions: number, files: RepoDiffResult["files"]): string {
  const lines = [`${filesChanged} file(s) changed, ${additions} insertion(s), ${deletions} deletion(s)`];
  for (const file of files) {
    lines.push(`${file.status}\t${file.path}`);
    for (const hunk of file.hunks ?? []) {
      lines.push(`@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`);
      for (const line of hunk.lines) {
        const prefix = line.tag === "add" ? "+" : line.tag === "delete" ? "-" : " ";
        lines.push(`${prefix}${line.content}`);
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

function rgitUsage(commandName: "rgit" | "ripgit"): string {
  return [
    `Usage: ${commandName} <subcommand> [args]`,
    "",
    "Repos live under /src/repos/{owner}/{repo}. Pass owner/repo explicitly, or use --here from inside a repo.",
    "",
    "Read-only:",
    `  ${commandName} list [--owner USER]`,
    `  ${commandName} info <repo|--here>`,
    `  ${commandName} path <repo|--here>`,
    `  ${commandName} read <repo|--here> [path] [--ref REF]`,
    `  ${commandName} search <repo|--here> <query> [--prefix PATH] [--ref REF]`,
    `  ${commandName} refs <repo|--here>`,
    `  ${commandName} log <repo|--here> [--ref REF] [--limit N] [--offset N]`,
    `  ${commandName} status <repo|--here>`,
    `  ${commandName} diff <repo|--here> [commit] [--context N]`,
    `  ${commandName} compare <repo|--here> <base> <head> [--stat] [--context N]`,
    "",
    "Mutating:",
    `  ${commandName} commit <repo|--here> --message TEXT [--branch BRANCH]`,
    `  ${commandName} discard <repo|--here>`,
    `  ${commandName} create owner/repo [--ref main] [--description TEXT]`,
    `  ${commandName} import <repo|--here> --from URL [--ref REF] [--remote-ref REF]`,
    `  ${commandName} pull <repo|--here> [--ref REF] [--remote-ref REF]`,
    "",
  ].join("\n");
}
