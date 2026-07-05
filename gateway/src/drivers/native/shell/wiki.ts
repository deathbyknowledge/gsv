import { defineCommand } from "just-bash";
import type { ExecResult } from "just-bash";
import type {
  RepoApplyOp,
  RepoReadResult,
  RepoSearchResult,
} from "@humansandmachines/gsv/protocol";
import type { KernelContext } from "../../../kernel/context";
import { resolveCallerOwnerUid } from "../../../kernel/context";
import {
  handleRepoApply,
  handleRepoCreate,
  handleRepoList,
  handleRepoRead,
  handleRepoSearch,
} from "../../../kernel/repo";
import { requireCommandCapability, requireShellOptionValue } from "./common";

const WIKI_MANIFEST_PATH = "wiki.json";
const WIKI_MANIFEST_KIND = "gsv.wiki";

type WikiCollection = {
  id: string;
  title: string;
  repo: string;
  writable: boolean;
  updatedAt: number | null;
};

type WikiSourceRef = {
  target: string;
  path: string;
  title?: string;
};

type WikiPathRef = {
  collection: WikiCollection;
  localPath: string;
};

type WikiSearchMatch = {
  collection: WikiCollection;
  path: string;
  line: number;
  content: string;
};

export function buildWikiCommand(ctx: KernelContext) {
  return defineCommand("wiki", async (args): Promise<ExecResult> => {
    try {
      return await runWikiCommand(args, ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        stdout: "",
        stderr: `wiki: ${message}\n`,
        exitCode: 1,
      };
    }
  });
}

async function runWikiCommand(args: string[], ctx: KernelContext): Promise<ExecResult> {
  const [subcommand = "help", ...rest] = args;

  switch (subcommand) {
    case "help":
    case "--help":
    case "-h":
      return { stdout: wikiUsage(), stderr: "", exitCode: 0 };
    case "list":
    case "ls": {
      const collections = await listWikiCollections(ctx);
      return { stdout: formatWikiList(collections), stderr: "", exitCode: 0 };
    }
    case "info": {
      const collection = await resolveWikiCollection(ctx, rest[0]);
      const pages = await collectWikiPages(ctx, collection);
      return { stdout: formatWikiInfo(collection, pages), stderr: "", exitCode: 0 };
    }
    case "read": {
      const path = rest.join(" ").trim();
      if (!path) {
        throw new Error("Usage: wiki read <wiki-id/path.md>");
      }
      const ref = await resolveWikiPath(ctx, path);
      const text = await readWikiText(ctx, ref.collection, ref.localPath);
      return { stdout: text.endsWith("\n") ? text : `${text}\n`, stderr: "", exitCode: 0 };
    }
    case "search":
    case "brief": {
      const parsed = parseWikiSearchArgs(rest, subcommand === "brief" ? 10 : 30);
      const matches = await searchWikis(ctx, parsed.query, parsed.prefix, parsed.limit);
      return { stdout: formatWikiSearch(matches), stderr: "", exitCode: 0 };
    }
    case "ingest": {
      const parsed = parseWikiIngestArgs(rest);
      const result = await ingestWikiSource(ctx, parsed);
      return { stdout: `created ${result}\n`, stderr: "", exitCode: 0 };
    }
    case "source": {
      return await runWikiSourceCommand(rest, ctx);
    }
    case "db": {
      return await runWikiDbCommand(rest, ctx);
    }
    default:
      throw new Error(`Unknown wiki subcommand: ${subcommand}`);
  }
}

async function runWikiDbCommand(args: string[], ctx: KernelContext): Promise<ExecResult> {
  const [subcommand = "list", ...rest] = args;
  if (subcommand === "list" || subcommand === "ls") {
    const collections = await listWikiCollections(ctx);
    return { stdout: formatWikiList(collections), stderr: "", exitCode: 0 };
  }
  if (subcommand === "init") {
    const parsed = parseWikiDbInitArgs(rest);
    const result = await initWikiCollection(ctx, parsed.db, parsed.title);
    return { stdout: `${result.status} ${result.path}\n`, stderr: "", exitCode: 0 };
  }
  throw new Error(`Unknown wiki db subcommand: ${subcommand}`);
}

async function runWikiSourceCommand(args: string[], ctx: KernelContext): Promise<ExecResult> {
  const [subcommand, ...rest] = args;
  if (subcommand !== "add") {
    throw new Error("Usage: wiki source add <wiki-id/path.md> --source <target:/path::title>");
  }
  const parsed = parseWikiSourceAddArgs(rest);
  const updated = await addWikiSources(ctx, parsed.path, parsed.sources);
  return { stdout: `updated ${updated}\n`, stderr: "", exitCode: 0 };
}

async function listWikiCollections(ctx: KernelContext): Promise<WikiCollection[]> {
  requireCommandCapability(ctx, "repo.list");
  requireCommandCapability(ctx, "repo.read");
  const repos = handleRepoList({}, ctx).repos;
  const collections: WikiCollection[] = [];

  for (const repo of repos) {
    const manifest = await readWikiManifest(ctx, repo.repo);
    if (!manifest) {
      continue;
    }
    collections.push({
      id: normalizeWikiId(manifest.id || repo.name),
      title: manifest.title || titleFromPath(manifest.id || repo.name),
      repo: repo.repo,
      writable: repo.writable,
      updatedAt: typeof repo.updatedAt === "number" ? repo.updatedAt : null,
    });
  }

  return collections.sort((left, right) =>
    left.title.localeCompare(right.title) || left.id.localeCompare(right.id)
  );
}

async function readWikiManifest(
  ctx: KernelContext,
  repo: string,
): Promise<{ id?: string; title?: string } | null> {
  let result: RepoReadResult;
  try {
    result = await handleRepoRead({ repo, path: WIKI_MANIFEST_PATH }, ctx);
  } catch (error) {
    if (isMissingPathError(error)) {
      return null;
    }
    throw error;
  }
  if (result.kind !== "file" || !result.content) {
    return null;
  }
  try {
    const parsed = JSON.parse(result.content) as Record<string, unknown>;
    if (parsed.kind !== WIKI_MANIFEST_KIND) {
      return null;
    }
    return {
      id: typeof parsed.id === "string" ? parsed.id.trim() : undefined,
      title: typeof parsed.title === "string" ? parsed.title.trim() : undefined,
    };
  } catch {
    return null;
  }
}

async function resolveWikiCollection(ctx: KernelContext, rawId: string | undefined): Promise<WikiCollection> {
  const id = normalizePath(rawId ?? "");
  if (!id) {
    throw new Error("wiki id is required");
  }
  const collections = await listWikiCollections(ctx);
  const collection = findCollection(collections, id);
  if (!collection) {
    throw new Error(`wiki not found: ${id}`);
  }
  return collection;
}

async function resolveWikiPath(ctx: KernelContext, rawPath: string): Promise<WikiPathRef> {
  const collections = await listWikiCollections(ctx);
  const ref = splitWikiPath(rawPath, collections);
  if (!ref) {
    throw new Error(`wiki path does not identify a known wiki: ${rawPath}`);
  }
  return ref;
}

function splitWikiPath(rawPath: string, collections: WikiCollection[]): WikiPathRef | null {
  const path = stripSrcReposPrefix(normalizePath(rawPath));
  const parts = path.split("/").filter(Boolean);
  if (parts.length === 0) {
    return null;
  }

  if (parts.length >= 2) {
    const repo = `${parts[0]}/${parts[1]}`;
    const collection = collections.find((candidate) => candidate.repo === repo);
    if (collection) {
      return {
        collection,
        localPath: normalizePath(parts.slice(2).join("/") || "index.md"),
      };
    }
  }

  const collection = findCollection(collections, parts[0]);
  if (!collection) {
    return null;
  }
  return {
    collection,
    localPath: normalizePath(parts.slice(1).join("/") || "index.md"),
  };
}

function findCollection(collections: WikiCollection[], idOrRepo: string): WikiCollection | null {
  const normalized = stripSrcReposPrefix(normalizePath(idOrRepo));
  return collections.find((collection) =>
    collection.id === normalized
    || collection.repo === normalized
    || collection.repo.endsWith(`/${normalized}`)
  ) ?? null;
}

async function readWikiText(
  ctx: KernelContext,
  collection: WikiCollection,
  localPath: string,
): Promise<string> {
  requireCommandCapability(ctx, "repo.read");
  const result = await handleRepoRead({ repo: collection.repo, path: localPath }, ctx);
  if (result.kind !== "file") {
    throw new Error(`wiki path is not a file: ${collection.id}/${localPath}`);
  }
  if (result.isBinary || result.content === null) {
    throw new Error(`wiki path is binary: ${collection.id}/${localPath}`);
  }
  return result.content;
}

async function collectWikiPages(ctx: KernelContext, collection: WikiCollection): Promise<string[]> {
  requireCommandCapability(ctx, "repo.read");
  const pages: string[] = [];
  try {
    await readWikiText(ctx, collection, "index.md");
    pages.push("index.md");
  } catch (error) {
    if (!isMissingPathError(error)) {
      throw error;
    }
  }
  await collectMarkdownPages(ctx, collection, "pages", pages);
  return pages;
}

async function collectMarkdownPages(
  ctx: KernelContext,
  collection: WikiCollection,
  localPath: string,
  out: string[],
): Promise<void> {
  if (out.length >= 300) {
    return;
  }

  let result: RepoReadResult;
  try {
    result = await handleRepoRead({ repo: collection.repo, path: localPath }, ctx);
  } catch (error) {
    if (isMissingPathError(error)) {
      return;
    }
    throw error;
  }
  if (result.kind !== "tree") {
    return;
  }

  for (const entry of [...result.entries].sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name === ".dir") {
      continue;
    }
    if (entry.type === "tree") {
      await collectMarkdownPages(ctx, collection, entry.path, out);
      continue;
    }
    if (entry.type === "blob" && /\.md$/i.test(entry.name)) {
      out.push(entry.path);
      if (out.length >= 300) {
        return;
      }
    }
  }
}

async function searchWikis(
  ctx: KernelContext,
  query: string,
  prefix: string | undefined,
  limit: number,
): Promise<WikiSearchMatch[]> {
  requireCommandCapability(ctx, "repo.search");
  const collections = await listWikiCollections(ctx);
  const targets = searchTargets(collections, prefix);
  const matches: WikiSearchMatch[] = [];

  for (const target of targets) {
    const result = await handleRepoSearch({
      repo: target.collection.repo,
      query,
      ...(target.localPath ? { prefix: target.localPath } : {}),
    }, ctx) as RepoSearchResult;
    for (const match of result.matches) {
      matches.push({
        collection: target.collection,
        path: match.path,
        line: match.line,
        content: match.content,
      });
    }
  }

  return matches.slice(0, limit);
}

function searchTargets(
  collections: WikiCollection[],
  prefix: string | undefined,
): Array<{ collection: WikiCollection; localPath: string }> {
  const normalized = prefix ? stripSrcReposPrefix(normalizePath(prefix)) : "";
  if (!normalized) {
    return collections.map((collection) => ({ collection, localPath: "" }));
  }

  const direct = splitWikiPath(normalized, collections);
  if (direct) {
    return [{
      collection: direct.collection,
      localPath: isCollectionRootPrefix(normalized, direct.collection) ? "" : direct.localPath,
    }];
  }

  return collections.map((collection) => ({ collection, localPath: normalized }));
}

function isCollectionRootPrefix(path: string, collection: WikiCollection): boolean {
  return path === collection.id
    || path === collection.repo
    || collection.repo.endsWith(`/${path}`);
}

async function initWikiCollection(
  ctx: KernelContext,
  db: string,
  title: string | undefined,
): Promise<{ status: "created" | "exists"; path: string }> {
  requireCommandCapability(ctx, "repo.create");
  requireCommandCapability(ctx, "repo.apply");
  requireCommandCapability(ctx, "repo.read");
  const id = normalizeWikiId(db);
  const owner = ownerUsername(ctx);
  const repo = `${owner}/${id}`;
  const displayTitle = title?.trim() || titleFromPath(id);
  const created = await handleRepoCreate({ repo, description: `Wiki: ${displayTitle}` }, ctx);
  const existing = await readWikiManifest(ctx, repo);
  if (existing) {
    return { status: "exists", path: `/src/repos/${repo}` };
  }
  if (!created.created) {
    throw new Error(`repo already exists and is not a wiki: ${repo}`);
  }

  await handleRepoApply({
    repo,
    message: `wiki: init ${id}`,
    ops: [
      {
        type: "put",
        path: WIKI_MANIFEST_PATH,
        content: `${JSON.stringify({
          kind: WIKI_MANIFEST_KIND,
          version: 1,
          id,
          title: displayTitle,
        }, null, 2)}\n`,
      },
      {
        type: "put",
        path: "index.md",
        content: renderWikiIndex(displayTitle, []),
      },
      { type: "put", path: "pages/.dir", content: "" },
    ] satisfies RepoApplyOp[],
  }, ctx);

  return { status: "created", path: `/src/repos/${repo}` };
}

async function ingestWikiSource(
  ctx: KernelContext,
  input: {
    db: string;
    path?: string;
    sources: WikiSourceRef[];
    summary?: string;
    title?: string;
  },
): Promise<string> {
  requireCommandCapability(ctx, "repo.apply");
  const collection = await resolveWikiCollection(ctx, input.db);
  const title = input.title?.trim() || input.sources[0]?.title || titleFromPath(input.sources[0]?.path || "note");
  const localPath = normalizePath(input.path
    ? localPathForCollection(input.path, collection)
    : `pages/${slugify(title) || "note"}.md`);
  const summary = input.summary?.trim();
  const markdown = [
    "---",
    `db: ${collection.id}`,
    `created_at: ${new Date().toISOString()}`,
    "---",
    "",
    `# ${title}`,
    "",
    summary || "",
    "",
    "## Sources",
    "",
    ...input.sources.map(formatSourceBullet),
    "",
  ].join("\n");

  await handleRepoApply({
    repo: collection.repo,
    message: `wiki: ingest ${collection.id}/${localPath}`,
    ops: [{ type: "put", path: localPath, content: markdown }],
  }, ctx);

  return `/src/repos/${collection.repo}/${localPath}`;
}

async function addWikiSources(
  ctx: KernelContext,
  rawPath: string,
  sources: WikiSourceRef[],
): Promise<string> {
  requireCommandCapability(ctx, "repo.apply");
  const ref = await resolveWikiPath(ctx, rawPath);
  const current = await readWikiText(ctx, ref.collection, ref.localPath);
  const updated = appendSources(current, sources);
  await handleRepoApply({
    repo: ref.collection.repo,
    message: `wiki: source add ${ref.collection.id}/${ref.localPath}`,
    ops: [{ type: "put", path: ref.localPath, content: updated }],
  }, ctx);
  return `/src/repos/${ref.collection.repo}/${ref.localPath}`;
}

function parseWikiDbInitArgs(args: string[]): { db: string; title?: string } {
  const db = String(args[0] ?? "").trim();
  if (!db) {
    throw new Error("Usage: wiki db init <wiki-id> [--title TITLE]");
  }
  let title: string | undefined;
  for (let index = 1; index < args.length; index += 1) {
    const current = args[index];
    if (current === "--title") {
      title = requireShellOptionValue(args[index + 1], "--title");
      index += 1;
      continue;
    }
    throw new Error(`Unknown wiki db init argument: ${current}`);
  }
  return { db, ...(title ? { title } : {}) };
}

function parseWikiSearchArgs(args: string[], defaultLimit: number): {
  query: string;
  prefix?: string;
  limit: number;
} {
  let prefix: string | undefined;
  let limit = defaultLimit;
  const queryParts: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (current === "--prefix") {
      prefix = requireShellOptionValue(args[index + 1], "--prefix");
      index += 1;
      continue;
    }
    if (current === "--limit") {
      const raw = requireShellOptionValue(args[index + 1], "--limit");
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error("limit must be a positive integer");
      }
      limit = Math.min(100, parsed);
      index += 1;
      continue;
    }
    queryParts.push(current);
  }

  const query = queryParts.join(" ").trim();
  if (!query) {
    throw new Error("Usage: wiki search <query> [--prefix WIKI_OR_PATH]");
  }
  return { query, ...(prefix ? { prefix } : {}), limit };
}

function parseWikiIngestArgs(args: string[]): {
  db: string;
  path?: string;
  sources: WikiSourceRef[];
  summary?: string;
  title?: string;
} {
  const db = String(args[0] ?? "").trim();
  if (!db) {
    throw new Error("Usage: wiki ingest <wiki-id> --source <target:/path::title> [--title TITLE]");
  }
  const sources: WikiSourceRef[] = [];
  let title: string | undefined;
  let summary: string | undefined;
  let path: string | undefined;

  for (let index = 1; index < args.length; index += 1) {
    const current = args[index];
    if (current === "--source") {
      sources.push(parseSourceRef(requireShellOptionValue(args[index + 1], "--source")));
      index += 1;
      continue;
    }
    if (current === "--title") {
      title = requireShellOptionValue(args[index + 1], "--title");
      index += 1;
      continue;
    }
    if (current === "--summary") {
      summary = requireShellOptionValue(args[index + 1], "--summary");
      index += 1;
      continue;
    }
    if (current === "--path") {
      path = requireShellOptionValue(args[index + 1], "--path");
      index += 1;
      continue;
    }
    throw new Error(`Unknown wiki ingest argument: ${current}`);
  }
  if (sources.length === 0) {
    throw new Error("wiki ingest requires at least one --source");
  }
  return {
    db,
    sources,
    ...(path ? { path } : {}),
    ...(summary ? { summary } : {}),
    ...(title ? { title } : {}),
  };
}

function parseWikiSourceAddArgs(args: string[]): { path: string; sources: WikiSourceRef[] } {
  const path = String(args[0] ?? "").trim();
  if (!path) {
    throw new Error("Usage: wiki source add <wiki-id/path.md> --source <target:/path::title>");
  }
  const sources: WikiSourceRef[] = [];
  for (let index = 1; index < args.length; index += 1) {
    const current = args[index];
    if (current === "--source") {
      sources.push(parseSourceRef(requireShellOptionValue(args[index + 1], "--source")));
      index += 1;
      continue;
    }
    throw new Error(`Unknown wiki source add argument: ${current}`);
  }
  if (sources.length === 0) {
    throw new Error("wiki source add requires at least one --source");
  }
  return { path, sources };
}

function parseSourceRef(value: string): WikiSourceRef {
  const [location, title] = value.split("::", 2);
  const colon = location.indexOf(":");
  const target = colon > 0 ? location.slice(0, colon).trim() : "gsv";
  const path = (colon > 0 ? location.slice(colon + 1) : location).trim();
  if (!target || !path) {
    throw new Error(`invalid source reference: ${value}`);
  }
  return {
    target,
    path,
    ...(title?.trim() ? { title: title.trim() } : {}),
  };
}

function localPathForCollection(rawPath: string, collection: WikiCollection): string {
  const path = stripSrcReposPrefix(normalizePath(rawPath));
  if (path.startsWith(`${collection.repo}/`)) {
    return normalizePath(path.slice(collection.repo.length + 1));
  }
  if (path.startsWith(`${collection.id}/`)) {
    return normalizePath(path.slice(collection.id.length + 1));
  }
  return path;
}

function formatWikiList(collections: WikiCollection[]): string {
  if (collections.length === 0) {
    return "No wiki collections found.\n";
  }
  const lines = ["ID\tTITLE\tWRITABLE\tPATH"];
  for (const collection of collections) {
    lines.push([
      collection.id,
      collection.title,
      collection.writable ? "yes" : "no",
      `/src/repos/${collection.repo}`,
    ].join("\t"));
  }
  return `${lines.join("\n")}\n`;
}

function formatWikiInfo(collection: WikiCollection, pages: string[]): string {
  return [
    `wiki: ${collection.id}`,
    `title: ${collection.title}`,
    `repo: ${collection.repo}`,
    `path: /src/repos/${collection.repo}`,
    `writable: ${collection.writable ? "yes" : "no"}`,
    "pages:",
    ...(pages.length > 0
      ? pages.map((page) => `- /src/repos/${collection.repo}/${page}`)
      : ["- none"]),
    "",
  ].join("\n");
}

function formatWikiSearch(matches: WikiSearchMatch[]): string {
  if (matches.length === 0) {
    return "No wiki matches.\n";
  }
  const lines = ["PATH\tLINE\tSNIPPET"];
  for (const match of matches) {
    lines.push([
      `/src/repos/${match.collection.repo}/${match.path}`,
      String(match.line),
      match.content.replace(/\s+/g, " ").trim(),
    ].join("\t"));
  }
  return `${lines.join("\n")}\n`;
}

function renderWikiIndex(title: string, pages: readonly string[]): string {
  return [
    `# ${title}`,
    "",
    "## Pages",
    "",
    pages.length > 0 ? pages.map((page) => `- ${page}`).join("\n") : "- _No pages yet._",
    "",
  ].join("\n");
}

function appendSources(markdown: string, sources: WikiSourceRef[]): string {
  const sourceText = sources.map(formatSourceBullet).join("\n");
  const trimmed = markdown.trimEnd();
  if (/^## Sources\s*$/m.test(trimmed)) {
    return `${trimmed}\n${sourceText}\n`;
  }
  return `${trimmed}\n\n## Sources\n\n${sourceText}\n`;
}

function formatSourceBullet(source: WikiSourceRef): string {
  return `- [${source.target}] ${source.path}${source.title ? ` | ${source.title}` : ""}`;
}

function ownerUsername(ctx: KernelContext): string {
  const identity = ctx.identity?.process;
  if (!identity) {
    throw new Error("identity is required");
  }
  const ownerUid = resolveCallerOwnerUid(ctx);
  if (ctx.auth && typeof ctx.auth.getPasswdByUid === "function") {
    const owner = ctx.auth.getPasswdByUid(ownerUid);
    if (owner?.username) {
      return owner.username;
    }
  }
  return identity.username;
}

function normalizeWikiId(value: string): string {
  const normalized = normalizePath(value);
  if (!normalized || normalized.includes("/")) {
    throw new Error("wiki id is required");
  }
  return normalized;
}

function normalizePath(value: string): string {
  const normalized = value
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/{2,}/g, "/");
  if (!normalized) {
    return "";
  }
  const parts = normalized.split("/");
  for (const part of parts) {
    if (!part || part === "." || part === "..") {
      throw new Error(`invalid wiki path: ${value}`);
    }
  }
  return parts.join("/");
}

function stripSrcReposPrefix(path: string): string {
  return path.startsWith("src/repos/") ? path.slice("src/repos/".length) : path;
}

function titleFromPath(path: string): string {
  const leaf = normalizePath(path).split("/").filter(Boolean).pop() ?? "knowledge";
  return leaf
    .replace(/\.md$/i, "")
    .replace(/[-_]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.length <= 3 ? part.toUpperCase() : `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ") || "Knowledge";
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\.md$/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function isMissingPathError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes("path not found");
}

function wikiUsage(): string {
  return [
    "Usage: wiki <subcommand> [args]",
    "",
    "Collections:",
    "  wiki list",
    "  wiki info <wiki-id>",
    "  wiki db init <wiki-id> [--title TITLE]",
    "",
    "Pages:",
    "  wiki read <wiki-id/path.md>",
    "  wiki search <query> [--prefix WIKI_OR_PATH] [--limit N]",
    "  wiki brief <query> [--prefix WIKI_OR_PATH]",
    "",
    "Sources:",
    "  wiki ingest <wiki-id> --source <target:/path::title> [--title TITLE] [--summary TEXT] [--path pages/name.md]",
    "  wiki source add <wiki-id/path.md> --source <target:/path::title>",
    "",
    "Wiki repos are normal files under /src/repos/<owner>/<wiki>.",
    "",
  ].join("\n");
}
