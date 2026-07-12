import type { GSVClient } from "@humansandmachines/gsv/client";
import type {
  RepoApplyOp,
  RepoReadResult,
  RepoSummary,
} from "@humansandmachines/gsv/protocol";
import {
  extractLibraryTitle,
  libraryPathInDb,
  librarySnippet,
  libraryTitleFromPath,
  normalizeDbScopedLibraryPath,
  normalizeLibraryDbId,
  normalizeLibraryPath,
  normalizeLibraryQueryTerms,
  scoreLibraryMatch,
  slugifyLibraryId,
  suggestLibraryPagePath,
} from "./libraryModel";
import type {
  LibraryBuildInput,
  LibraryCollection,
  LibraryCreateCollectionInput,
  LibraryEntry,
  LibraryIngestSourceInput,
  LibraryMutationResult,
  LibraryPreviewPayload,
  LibraryPreviewRequest,
  LibrarySavePageInput,
  LibraryWorkspaceState,
} from "./libraryTypes";
import { requestFsRead } from "../../../services/gateway/fsRead";

type LibraryClient = Pick<GSVClient, "call" | "request">;

type RepoNode =
  | { kind: "missing" }
  | { kind: "tree"; entries: Extract<RepoReadResult, { kind: "tree" }>["entries"] }
  | { kind: "file"; content: string | null; isBinary: boolean; size: number };

const WIKI_MANIFEST_PATH = "wiki.json";
const WIKI_MANIFEST_KIND = "gsv.wiki";

export async function loadLibraryWorkspace(
  client: LibraryClient,
  args: { db?: string; path?: string; q?: string; newPage?: boolean },
): Promise<LibraryWorkspaceState> {
  let errorText = "";
  let selectedDb = String(args.db ?? "").trim();
  let selectedPath = "";
  const searchQuery = String(args.q ?? "").trim();
  let dbs: LibraryCollection[] = [];
  let pages: LibraryEntry[] = [];
  let selectedNote = null as LibraryWorkspaceState["selectedNote"];
  let searchMatches = null as LibraryWorkspaceState["searchMatches"];

  try {
    dbs = await listLibraryCollections(client);
    if (!dbs.some((db) => db.id === selectedDb)) {
      selectedDb = dbs[0]?.id ?? "";
    }
  } catch (error) {
    errorText ||= formatError(error);
  }

  const collection = dbs.find((db) => db.id === selectedDb) ?? null;
  if (collection) {
    try {
      pages = await listLibraryPages(client, collection);
    } catch (error) {
      errorText ||= formatError(error);
    }

    // A new-page editor route carries no path. Without this guard the loader
    // defaults the path to `${db}/index.md` and returns the collection Overview
    // as the selected note, so the blank editor would bind to (and overwrite)
    // index.md on save. Leave the note unselected; the editor generates a fresh
    // page path of its own.
    if (!args.newPage) {
      selectedPath = normalizeDbScopedLibraryPath(args.path ?? "", selectedDb) || `${selectedDb}/index.md`;
      try {
        selectedNote = await readLibraryNote(client, collection, selectedPath);
        if (!selectedNote && !args.path && pages.length > 0) {
          selectedPath = pages[0].path;
          selectedNote = await readLibraryNote(client, collection, selectedPath);
        }
      } catch (error) {
        errorText ||= formatError(error);
      }
    }

    if (searchQuery) {
      try {
        searchMatches = await searchLibrary(client, collection, pages, searchQuery);
      } catch (error) {
        errorText ||= formatError(error);
      }
    }
  }

  return {
    selectedDb,
    selectedPath,
    dbs,
    pages,
    selectedNote,
    searchQuery,
    searchMatches,
    errorText,
  };
}

export async function createLibraryCollection(
  client: LibraryClient,
  input: LibraryCreateCollectionInput,
): Promise<LibraryMutationResult> {
  const db = normalizeLibraryDbId(input.dbId);
  const title = input.dbTitle?.trim() || libraryTitleFromPath(db);
  const owner = await homeRepoOwner(client);
  const repo = `${owner}/${db}`;

  await client.call("repo.create", {
    repo,
    description: `Wiki: ${title}`,
  });

  await client.call("repo.apply", {
    repo,
    message: `wiki: init ${db}`,
    ops: [
      {
        type: "put",
        path: WIKI_MANIFEST_PATH,
        content: `${JSON.stringify({ kind: WIKI_MANIFEST_KIND, version: 1, id: db, title }, null, 2)}\n`,
      },
      {
        type: "put",
        path: "index.md",
        content: renderLibraryIndex(title, undefined, []),
      },
      { type: "put", path: "pages/.dir", content: "" },
    ] satisfies RepoApplyOp[],
  });

  return {
    db,
    openPath: `${db}/index.md`,
    statusText: `Created ${db}`,
  };
}

export async function saveLibraryPage(
  client: LibraryClient,
  input: LibrarySavePageInput,
): Promise<LibraryMutationResult> {
  const db = normalizeLibraryDbId(input.db);
  const path = normalizeDbScopedLibraryPath(input.path, db);
  if (!path) {
    throw new Error("page path is required");
  }
  const collection = await requireCollection(client, db);
  const localPath = libraryPathInDb(path, db);
  const ops: RepoApplyOp[] = [{
    type: "put",
    path: localPath,
    content: input.markdown,
  }];

  const indexOp = await indexUpdateOp(client, collection, pageEntryForLocalPath(localPath));
  if (indexOp) {
    ops.push(indexOp);
  }

  await client.call("repo.apply", {
    repo: collection.repo,
    message: `wiki: update ${path}`,
    ops,
  });

  return {
    db,
    openPath: path,
    statusText: `Saved ${path}`,
  };
}

export async function ingestLibrarySource(
  client: LibraryClient,
  input: LibraryIngestSourceInput,
): Promise<LibraryMutationResult> {
  const db = normalizeLibraryDbId(input.db);
  const sourceTarget = input.sourceTarget.trim() || "gsv";
  const sourcePath = input.sourcePath.trim();
  if (!sourcePath) {
    throw new Error("source path is required");
  }
  const title = input.sourceTitle?.trim() || libraryTitleFromPath(sourcePath);
  const path = suggestLibraryPagePath(db, title);
  const summary = input.summary?.trim();
  const markdown = [
    "---",
    `db: ${db}`,
    `created_at: ${new Date().toISOString()}`,
    "---",
    "",
    `# ${title}`,
    "",
    summary || "",
    "",
    "## Sources",
    "",
    `- [${sourceTarget}] ${sourcePath}${title ? ` | ${title}` : ""}`,
    "",
  ].join("\n");

  const result = await saveLibraryPage(client, { db, path, markdown });
  return {
    ...result,
    statusText: `Captured ${sourceTarget}:${sourcePath}`,
  };
}

export async function startLibraryBuild(
  client: LibraryClient,
  input: LibraryBuildInput,
): Promise<LibraryMutationResult> {
  const sourceTarget = input.sourceTarget.trim() || "gsv";
  const sourcePath = input.sourcePath.trim();
  const db = normalizeLibraryDbId(input.dbId);
  const title = input.dbTitle?.trim();
  if (!sourcePath) {
    throw new Error("source directory is required");
  }

  const spawn = await client.call("proc.spawn", {
    runAs: "wiki#builder",
    label: `wiki build (${db})`,
  }) as { ok?: boolean; pid?: string; error?: string };
  if (!spawn.ok || !spawn.pid) {
    throw new Error(spawn.error || "failed to start wiki builder");
  }

  const prompt = [
    "Build a knowledge wiki from a directory.",
    `Source target: ${sourceTarget}`,
    `Source directory: ${sourcePath}`,
    `Target wiki: ${db}`,
    ...(title ? [`Wiki title: ${title}`] : []),
    "",
    "Requirements:",
    "- The source directory may be on a device target, but the wiki itself must be created on gsv as a wiki repo.",
    "- Treat the source target as read-only. Do not create wiki files, support files, or scratch files there.",
    "- Use `wiki db init` on gsv to create the wiki if needed, then edit wiki pages under `/src/repos/<owner>/<wiki>`.",
    "- Initialize the target wiki if it does not exist.",
    "- Create a readable `index.md` homepage for the wiki.",
    "- Create canonical pages under `<db>/pages/` with meaningful boundaries instead of one giant dump.",
    "- Add links between related pages.",
    "- Keep live source references back to the original files and directories.",
    "- Prefer a small useful first draft over exhaustive coverage.",
  ].join("\n");

  const sent = await client.call("proc.send", {
    pid: spawn.pid,
    message: prompt,
  }) as { ok?: boolean; error?: string };
  if (!sent.ok) {
    throw new Error(sent.error || "failed to send builder prompt");
  }

  return {
    db,
    openPath: `${db}/index.md`,
    statusText: `Started background wiki build for ${db}`,
  };
}

export async function previewLibraryContent(
  client: LibraryClient,
  request: LibraryPreviewRequest,
): Promise<LibraryPreviewPayload> {
  try {
    if (request.kind === "page") {
      const db = String(request.db ?? "").trim();
      const path = normalizeDbScopedLibraryPath(request.path, db);
      if (!path) {
        return { ok: false, error: "Preview path is required." };
      }
      const collection = await requireCollection(client, path.split("/")[0]);
      const note = await readLibraryNote(client, collection, path);
      if (!note) {
        return { ok: false, error: `Page '${path}' does not exist.` };
      }
      return {
        ok: true,
        kind: "page",
        title: note.title,
        path: note.path,
        markdown: note.markdown,
      };
    }

    const target = request.target.trim();
    const path = request.path.trim();
    const title = request.title?.trim() || path.split("/").pop() || path;
    if (!target || !path) {
      return { ok: false, error: "Source target and path are required." };
    }
    if (target !== "gsv") {
      return {
        ok: true,
        kind: "source",
        target,
        path,
        title,
        mode: "unavailable",
        text: `Preview is not available yet for target '${target}'.`,
      };
    }

    const source = await requestFsRead(client, { path });
    if (!source.ok) {
      return { ok: false, error: source.error || `Failed to read ${path}` };
    }
    const sourcePath = source.path;
    if ("files" in source) {
      return {
        ok: true,
        kind: "source",
        target,
        path: sourcePath,
        title,
        mode: "directory",
        files: source.files,
        directories: source.directories,
      };
    }
    if (source.kind === "image") {
      const [description, image] = source.content;
      return {
        ok: true,
        kind: "source",
        target,
        path: sourcePath,
        title,
        mode: "image",
        text: description.text,
        image,
      };
    }

    const text = stripReadLineNumbers(source.content);
    return {
      ok: true,
      kind: "source",
      target,
      path: sourcePath,
      title,
      mode: inferPreviewMode(sourcePath, text),
      text,
    };
  } catch (error) {
    return { ok: false, error: formatError(error) };
  }
}

async function listLibraryCollections(client: LibraryClient): Promise<LibraryCollection[]> {
  const result = await client.call("repo.list", {}) as { repos?: RepoSummary[] };
  const repos = Array.isArray(result.repos) ? result.repos : [];
  const collections: LibraryCollection[] = [];

  for (const repo of repos) {
    const manifest = await readWikiManifest(client, repo.repo);
    if (!manifest) {
      continue;
    }
    const id = normalizeLibraryDbId(manifest.id || repo.name);
    collections.push({
      id,
      title: manifest.title || libraryTitleFromPath(id),
      repo: repo.repo,
      writable: repo.writable,
      updatedAt: typeof repo.updatedAt === "number" ? repo.updatedAt : null,
    });
  }

  return collections.sort((left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id));
}

async function listLibraryPages(client: LibraryClient, collection: LibraryCollection): Promise<LibraryEntry[]> {
  const entries: LibraryEntry[] = [];
  const index = await readRepoPath(client, collection.repo, "index.md");
  if (index.kind === "file") {
    entries.push({
      kind: "file",
      path: `${collection.id}/index.md`,
      title: extractLibraryTitle(index.content ?? "", "Overview"),
    });
  }

  const pagesRoot = await readRepoPath(client, collection.repo, "pages");
  if (pagesRoot.kind === "tree") {
    await collectPageEntries(client, collection, "pages", pagesRoot, entries);
  }

  return entries.sort((left, right) => {
    if (left.path.endsWith("/index.md") && !right.path.endsWith("/index.md")) return -1;
    if (!left.path.endsWith("/index.md") && right.path.endsWith("/index.md")) return 1;
    return left.title.localeCompare(right.title) || left.path.localeCompare(right.path);
  });
}

async function collectPageEntries(
  client: LibraryClient,
  collection: LibraryCollection,
  localPath: string,
  node: Extract<RepoNode, { kind: "tree" }>,
  out: LibraryEntry[],
): Promise<void> {
  for (const entry of [...node.entries].sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name === ".dir") {
      continue;
    }
    const childPath = joinPath(localPath, entry.name);
    if (entry.type === "tree") {
      const child = await readRepoPath(client, collection.repo, childPath);
      if (child.kind === "tree") {
        await collectPageEntries(client, collection, childPath, child, out);
      }
      continue;
    }
    if (!/\.md$/i.test(entry.name)) {
      continue;
    }
    const note = await readRepoPath(client, collection.repo, childPath);
    const externalPath = `${collection.id}/${childPath}`;
    out.push({
      kind: "file",
      path: externalPath,
      title: note.kind === "file" ? extractLibraryTitle(note.content ?? "", childPath) : libraryTitleFromPath(childPath),
    });
  }
}

async function readLibraryNote(
  client: LibraryClient,
  collection: LibraryCollection,
  externalPath: string,
) {
  const localPath = libraryPathInDb(externalPath, collection.id);
  const node = await readRepoPath(client, collection.repo, localPath);
  if (node.kind === "missing") {
    return null;
  }
  if (node.kind !== "file") {
    throw new Error(`library path '${externalPath}' is not a file`);
  }
  const markdown = node.content ?? "";
  return {
    path: externalPath,
    title: extractLibraryTitle(markdown, externalPath),
    markdown,
  };
}

async function searchLibrary(
  client: LibraryClient,
  collection: LibraryCollection,
  pages: readonly LibraryEntry[],
  query: string,
): Promise<LibraryEntry[]> {
  const terms = normalizeLibraryQueryTerms(query);
  if (terms.length === 0) {
    return [];
  }

  const matches: Array<LibraryEntry & { score: number }> = [];
  for (const entry of pages) {
    const note = await readLibraryNote(client, collection, entry.path);
    if (!note) {
      continue;
    }
    const score = scoreLibraryMatch(note.path, note.title, note.markdown, terms);
    if (score <= 0) {
      continue;
    }
    matches.push({
      ...entry,
      title: note.title,
      snippet: librarySnippet(note.markdown, note.title, query),
      score,
    });
  }

  return matches
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .slice(0, 30)
    .map(({ score: _score, ...entry }) => entry);
}

async function readWikiManifest(client: LibraryClient, repo: string): Promise<{ id?: string; title?: string } | null> {
  const manifest = await readRepoPath(client, repo, WIKI_MANIFEST_PATH);
  if (manifest.kind !== "file" || !manifest.content) {
    return null;
  }
  try {
    const parsed = JSON.parse(manifest.content) as Record<string, unknown>;
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

async function requireCollection(client: LibraryClient, db: string): Promise<LibraryCollection> {
  const collections = await listLibraryCollections(client);
  const collection = collections.find((entry) => entry.id === db);
  if (!collection) {
    throw new Error(`collection '${db}' does not exist`);
  }
  return collection;
}

async function readRepoPath(client: LibraryClient, repo: string, path: string): Promise<RepoNode> {
  try {
    const result = await client.call("repo.read", { repo, path }) as RepoReadResult;
    if (result.kind === "tree") {
      return { kind: "tree", entries: result.entries };
    }
    return {
      kind: "file",
      content: result.content,
      isBinary: result.isBinary,
      size: result.size,
    };
  } catch (error) {
    const message = formatError(error).toLowerCase();
    if (message.includes("not found") || message.includes("enoent")) {
      return { kind: "missing" };
    }
    throw error;
  }
}

async function homeRepoOwner(client: LibraryClient): Promise<string> {
  const result = await client.call("repo.list", {}) as { repos?: RepoSummary[] };
  const home = result.repos?.find((repo) => repo.kind === "home");
  if (!home?.owner) {
    throw new Error("home repository owner is not available");
  }
  return home.owner;
}

async function indexUpdateOp(
  client: LibraryClient,
  collection: LibraryCollection,
  pageEntry: string | null,
): Promise<RepoApplyOp | null> {
  if (!pageEntry) {
    return null;
  }
  const existing = await readRepoPath(client, collection.repo, "index.md");
  const current = existing.kind === "file" ? existing.content ?? "" : renderLibraryIndex(collection.title, undefined, []);
  const updated = mergeLibraryIndexPage(current, pageEntry);
  return updated === current ? null : { type: "put", path: "index.md", content: updated };
}

function renderLibraryIndex(title: string, description: string | undefined, pages: readonly string[]): string {
  const cleanPages = [...new Set(pages.map((page) => page.trim()).filter(Boolean))].sort();
  const parts = [`# ${title}`];
  if (description) {
    parts.push(description.trim());
  }
  parts.push("## Pages");
  parts.push(cleanPages.length === 0 ? "- _No pages yet._" : cleanPages.map((page) => `- ${page}`).join("\n"));
  return `${parts.join("\n\n")}\n`;
}

function mergeLibraryIndexPage(markdown: string, pageEntry: string): string {
  const normalized = markdown.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const title = lines.find((line) => line.startsWith("# "))?.slice(2).trim() || "Library";
  const headerIndex = lines.findIndex((line) => line.trim() === "## Pages");
  const description = headerIndex > 1 ? trimEmptyLines(lines.slice(1, headerIndex)).join("\n") : undefined;
  const pages = lines
    .slice(headerIndex >= 0 ? headerIndex + 1 : 0)
    .map((line) => line.match(/^\s*-\s+(.*)$/)?.[1] ?? "")
    .filter((line) => line && line !== "_No pages yet._");
  return renderLibraryIndex(title, description, [...pages, pageEntry]);
}

function pageEntryForLocalPath(path: string): string | null {
  const normalized = normalizeLibraryPath(path);
  return normalized.startsWith("pages/") && normalized !== "pages/.dir" ? normalized : null;
}

function trimEmptyLines(lines: string[]): string[] {
  const copy = [...lines];
  while (copy.length > 0 && !copy[0].trim()) copy.shift();
  while (copy.length > 0 && !copy[copy.length - 1].trim()) copy.pop();
  return copy;
}

function joinPath(left: string, right: string): string {
  return [left, right]
    .map((part) => normalizeLibraryPath(part))
    .filter(Boolean)
    .join("/");
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function inferPreviewMode(path: string, text: string): "markdown" | "text" {
  const lowerPath = path.toLowerCase();
  if (/\.(md|markdown|mdown|mkd)$/.test(lowerPath)) {
    return "markdown";
  }
  const sample = text.trim();
  if (/^#{1,6}\s/m.test(sample) || /\[[^\]]+\]\([^)]+\)/.test(sample) || /^[-*]\s/m.test(sample)) {
    return "markdown";
  }
  return "text";
}

function stripReadLineNumbers(value: string): string {
  return value
    .split("\n")
    .map((line) => line.replace(/^\s*\d+\t/, ""))
    .join("\n");
}
