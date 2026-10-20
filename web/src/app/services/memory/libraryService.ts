import type { GSVClient } from "@humansandmachines/gsv/client";
import { z } from "zod";
import { lexer } from "marked";
import type {
  RepoApplyOp,
  RepoApplyArgs,
  RepoReadResult,
} from "@humansandmachines/gsv/protocol";
import {
  libraryPathInDb,
  libraryTitleFromPath,
  normalizeDbScopedLibraryPath,
  normalizeLibraryDbId,
  normalizeLibraryPath,
} from "./libraryModel";
import type {
  LibraryCollection,
  LibraryMutationResult,
  LibrarySavePageInput,
} from "./libraryTypes";
import { t } from "../../i18n/locale";

type LibraryClient = Pick<GSVClient, "call" | "request">;

type RepoNode =
  | { kind: "missing" }
  | { kind: "tree"; entries: Extract<RepoReadResult, { kind: "tree" }>["entries"] }
  | { kind: "file"; content: string | null; isBinary: boolean; size: number };

const WIKI_MANIFEST_PATH = "wiki.json";
const WIKI_MANIFEST_KIND = "gsv.wiki";

export async function saveLibraryPage(
  client: LibraryClient,
  input: LibrarySavePageInput,
): Promise<LibraryMutationResult> {
  const db = normalizeLibraryDbId(input.db);
  const path = normalizeDbScopedLibraryPath(input.path, db);
  if (!path) {
    throw new Error("page path is required");
  }
  if (!path.startsWith(`${db}/`)) {
    throw new Error(t("memory.error.otherCollection"));
  }
  const collection = await requireCollection(client, db);
  const localPath = libraryPathInDb(path, db);
  let expectedHead: string | undefined;
  if (input.createOnly || input.expectedMarkdown !== undefined) {
    const history = await client.call("repo.log", { repo: collection.repo, limit: 1 });
    expectedHead = history.entries[0]?.hash;
    if (!expectedHead) throw new Error(t("memory.error.noRevision"));
    const current = await readRepoPath(client, collection.repo, localPath);
    if (input.createOnly && current.kind !== "missing") throw new Error(t("memory.error.exists"));
    if (input.expectedMarkdown !== undefined && (current.kind !== "file" || current.isBinary || current.content !== input.expectedMarkdown)) {
      throw new Error(t("memory.error.changed"));
    }
  }
  const ops: RepoApplyOp[] = [{
    type: "put",
    path: localPath,
    content: input.markdown,
  }];

  const indexOp = await indexUpdateOp(client, collection, pageEntryForLocalPath(localPath));
  if (indexOp) {
    ops.push(indexOp);
  }

  const write: RepoApplyArgs = {
    repo: collection.repo,
    message: `wiki: update ${path}`,
    ops,
  };
  if (expectedHead) write.expectedHead = expectedHead;
  await client.call("repo.apply", write);

  return {
    db,
    openPath: path,
  };
}

export async function listLibraryCollections(client: LibraryClient): Promise<LibraryCollection[]> {
  const result = await client.call("repo.list", {});
  const parsed = z.object({
    repos: z.array(z.object({
      repo: z.string(),
      name: z.string(),
      writable: z.boolean(),
      updatedAt: z.number().optional(),
    })).optional(),
  }).safeParse(result);
  const repos = parsed.success ? parsed.data.repos ?? [] : [];
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
      updatedAt: repo.updatedAt ?? null,
    });
  }

  return collections.sort((left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id));
}

async function readWikiManifest(client: LibraryClient, repo: string): Promise<{ id?: string; title?: string } | null> {
  const manifest = await readRepoPath(client, repo, WIKI_MANIFEST_PATH);
  if (manifest.kind !== "file" || !manifest.content) {
    return null;
  }
  try {
    const parsed = z.object({
      kind: z.string(),
      id: z.string().optional(),
      title: z.string().optional(),
    }).safeParse(JSON.parse(manifest.content));
    if (!parsed.success || parsed.data.kind !== WIKI_MANIFEST_KIND) {
      return null;
    }
    return {
      id: parsed.data.id?.trim(),
      title: parsed.data.title?.trim(),
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
    const result = await client.call("repo.read", { repo, path });
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
    if (formatError(error).startsWith("Path not found:")) {
      return { kind: "missing" };
    }
    throw error;
  }
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
  let current: string;
  if (existing.kind === "missing") {
    current = renderLibraryIndex(collection.title, undefined, []);
  } else if (existing.kind === "file" && !existing.isBinary && existing.content !== null) {
    current = existing.content;
  } else {
    throw new Error(t("memory.error.overviewUnreadable"));
  }
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
  const pageLine = `- ${pageEntry}`;
  const lines = libraryIndexTextLines(markdown);
  if (lines.some((line) => line.text.trim() === pageLine)) {
    return markdown;
  }
  const newline = markdown.includes("\r\n") ? "\r\n" : "\n";
  const heading = lines.find((line) => /^## Pages[ \t]*$/.test(line.text));
  if (!heading) {
    const separator = markdown ? (markdown.endsWith(newline) ? newline : newline + newline) : "";
    return `${markdown}${separator}## Pages${newline}${newline}${pageLine}${newline}`;
  }

  const start = heading.end;
  const nextHeading = lines.find((line) => line.start >= start && /^#{1,2}(?:[ \t]|$)/.test(line.text));
  const end = nextHeading?.start ?? markdown.length;
  const placeholder = lines.find((line) => line.start >= start && line.start < end && /^- _No pages yet\._[ \t]*$/.test(line.text));
  if (placeholder) {
    return markdown.slice(0, placeholder.start) + pageLine + markdown.slice(placeholder.start + placeholder.text.length);
  }
  const before = markdown.slice(0, end);
  const after = markdown.slice(end);
  return `${before}${before.endsWith(newline) ? "" : newline}${pageLine}${newline}${after ? newline : ""}${after}`;
}

function libraryIndexTextLines(markdown: string): Array<{ text: string; start: number; end: number }> {
  const lines = [...markdown.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/g)]
    .filter((match) => match[0] !== "")
    .map((match) => ({ text: match[0].replace(/\r?\n$|\r$/, ""), start: match.index, end: match.index + match[0].length }));
  const frontmatterEnd = lines[0]?.text === "---"
    ? lines.findIndex((line, index) => index > 0 && line.text === "---")
    : -1;
  const bodyStart = frontmatterEnd >= 0 ? lines[frontmatterEnd].end : 0;
  const examples: Array<{ start: number; end: number }> = [];
  let tokenOffset = 0;
  for (const token of lexer(markdown.slice(bodyStart))) {
    const end = tokenOffset + token.raw.length;
    if (token.type === "code" || token.type === "html") {
      examples.push({ start: tokenOffset, end });
    }
    tokenOffset = end;
  }
  // Keep source offsets so index edits never reconstruct authored Markdown.
  // The lexer normalizes every line ending to one character but retains tabs.
  let normalizedOffset = 0;
  return lines.filter((line, index) => {
    if (index <= frontmatterEnd) return false;
    const start = normalizedOffset;
    normalizedOffset += line.text.length + (line.end > line.start + line.text.length ? 1 : 0);
    return !examples.some((block) => start >= block.start && start < block.end);
  });
}

function pageEntryForLocalPath(path: string): string | null {
  const normalized = normalizeLibraryPath(path);
  return normalized.startsWith("pages/") && normalized !== "pages/.dir" ? normalized : null;
}

function formatError<T>(error: T): string {
  return error instanceof Error ? error.message : String(error);
}
