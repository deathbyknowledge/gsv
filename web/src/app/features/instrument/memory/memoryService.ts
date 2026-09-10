import type { GSVClient } from "@humansandmachines/gsv/client";
import { extractLibraryTitle, libraryPathInDb, libraryTitleFromPath, normalizeLibraryPath } from "../../../services/memory/libraryModel";
import type { LibraryCollection, LibraryEntry, LibraryNote } from "../../../services/memory/libraryTypes";

type MemoryClient = Pick<GSVClient, "call">;

export type MemorySearchResult = { entries: LibraryEntry[]; truncated: boolean };

/**
 * Memory reads one thing per ask. The page list comes from the tree alone,
 * titled from paths, so listing a collection reads no page; a page is read
 * when it is opened; a search runs in the gateway over the repository and
 * comes back as matches with their lines, so it reads no page either.
 */

async function treeEntries(client: MemoryClient, repo: string, path: string): Promise<Array<{ name: string; type: string }>> {
  try {
    const result = await client.call("repo.read", { repo, path });
    return result.kind === "tree" ? result.entries : [];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("Path not found:")) return [];
    throw error;
  }
}

async function collectPages(client: MemoryClient, collection: LibraryCollection, localPath: string, out: LibraryEntry[]): Promise<void> {
  const entries = await treeEntries(client, collection.repo, localPath);
  for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name === ".dir") continue;
    const childPath = `${localPath}/${entry.name}`;
    if (entry.type === "tree") {
      await collectPages(client, collection, childPath, out);
      continue;
    }
    if (!/\.md$/i.test(entry.name)) continue;
    out.push({ kind: "file", path: `${collection.id}/${childPath}`, title: libraryTitleFromPath(childPath) });
  }
}

/** The collection's pages, the overview first, without reading any of them. */
export async function listMemoryPages(client: MemoryClient, collection: LibraryCollection): Promise<LibraryEntry[]> {
  const pages: LibraryEntry[] = [];
  const root = await treeEntries(client, collection.repo, "");
  if (root.some((entry) => entry.name === "index.md" && entry.type !== "tree")) {
    pages.push({ kind: "file", path: `${collection.id}/index.md`, title: "Overview" });
  }
  await collectPages(client, collection, "pages", pages);
  return pages;
}

/** One page, read when opened. */
export async function readMemoryPage(client: MemoryClient, collection: LibraryCollection, externalPath: string): Promise<LibraryNote | null> {
  const path = normalizeLibraryPath(externalPath);
  if (!path.startsWith(`${collection.id}/`)) {
    throw new Error("This page does not belong to the selected collection.");
  }
  const localPath = libraryPathInDb(path, collection.id);
  try {
    const node = await client.call("repo.read", { repo: collection.repo, path: localPath });
    if (node.kind !== "file") return null;
    if (node.isBinary || node.content === null) {
      throw new Error("This page is not readable text.");
    }
    const markdown = node.content;
    return { path, title: extractLibraryTitle(markdown, path), markdown };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("Path not found:")) return null;
    throw error;
  }
}

/** Matches from the gateway's search over the repository, one entry per page with the first matching line as its snippet. */
export async function searchMemory(client: MemoryClient, collection: LibraryCollection, query: string): Promise<MemorySearchResult> {
  const result = await client.call("repo.search", { repo: collection.repo, query });
  const byPath = new Map<string, LibraryEntry & { hits: number }>();
  for (const match of result.matches) {
    if (!/\.md$/i.test(match.path)) continue;
    const externalPath = `${collection.id}/${match.path}`;
    const existing = byPath.get(externalPath);
    if (existing) {
      existing.hits += 1;
      continue;
    }
    byPath.set(externalPath, {
      kind: "file",
      path: externalPath,
      title: match.path === "index.md" ? "Overview" : libraryTitleFromPath(match.path),
      snippet: match.content.trim().slice(0, 160),
      hits: 1,
    });
  }
  return {
    entries: [...byPath.values()]
      .sort((left, right) => right.hits - left.hits || left.path.localeCompare(right.path))
      .map(({ hits: _hits, ...entry }) => entry),
    truncated: result.truncated === true,
  };
}

/** A new page stays in the selected collection's page tree. */
export function newMemoryPagePath(db: string, value: string): string {
  const name = value.trim().replace(/\.md$/i, "");
  if (!name || name === "." || name === ".." || /[\/\\\x00-\x1f\x7f]/.test(name)) throw new Error("Give the page a name without folders.");
  return `${db}/pages/${name}.md`;
}
