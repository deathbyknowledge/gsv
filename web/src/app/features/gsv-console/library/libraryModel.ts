import type { LibraryEntry, LibraryNote, LibraryTreeNode } from "./libraryTypes";

export function normalizeLibraryPath(value: unknown): string {
  const trimmed = String(value ?? "")
    .trim()
    .replace(/^\/+/, "")
    .replace(/\/+$/g, "")
    .replace(/\/{2,}/g, "/");

  if (!trimmed) {
    return "";
  }

  const parts = trimmed.split("/");
  for (const part of parts) {
    if (!part || part === "." || part === "..") {
      throw new Error(`invalid library path '${String(value)}'`);
    }
  }
  return parts.join("/");
}

export function normalizeLibraryDbId(value: unknown): string {
  const db = normalizeLibraryPath(value);
  if (!db || db.includes("/")) {
    throw new Error("collection id is required");
  }
  return db;
}

export function normalizeDbScopedLibraryPath(value: unknown, db: string): string {
  const path = normalizeLibraryPath(value);
  if (!path) {
    return "";
  }
  if (db && (path === "index.md" || path.startsWith("pages/"))) {
    return `${db}/${path}`;
  }
  return path;
}

export function libraryPathInDb(path: string, db: string): string {
  const normalized = normalizeLibraryPath(path);
  const prefix = `${db}/`;
  if (normalized === db) {
    return "";
  }
  return normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized;
}

export function libraryTitleFromPath(path: string): string {
  const leaf = normalizeLibraryPath(path).split("/").filter(Boolean).pop() ?? "knowledge";
  return titleCase(leaf.replace(/\.md$/i, "").replace(/[-_]+/g, " ").trim() || "knowledge");
}

export function stripLibraryFrontmatter(markdown: string): string {
  const text = String(markdown ?? "").replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n")) {
    return text;
  }
  const end = text.indexOf("\n---\n", 4);
  if (end < 0) {
    return text;
  }
  return text.slice(end + 5);
}

export function extractLibraryTitle(markdown: string, fallback: string): string {
  const text = stripLibraryFrontmatter(markdown);
  const match = text.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim() || libraryTitleFromPath(fallback);
}

export function extractLibraryHeadings(markdown: string): Array<{ level: number; text: string; id: string }> {
  const seen = new Map<string, number>();
  return stripLibraryFrontmatter(markdown)
    .split("\n")
    .flatMap((line) => {
      const match = line.match(/^(#{2,4})\s+(.+)$/);
      if (!match) {
        return [];
      }
      const text = match[2].trim();
      const base = slugifyHeading(text);
      const count = seen.get(base) ?? 0;
      seen.set(base, count + 1);
      return [{ level: match[1].length, text, id: count === 0 ? base : `${base}-${count + 1}` }];
    });
}

export function prepareLibraryArticleMarkdown(note: LibraryNote): string {
  const title = note.title.trim();
  const text = stripLibraryFrontmatter(note.markdown).replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  let offset = 0;
  while (offset < lines.length && !lines[offset].trim()) {
    offset += 1;
  }
  const heading = lines[offset]?.match(/^#\s+(.+)$/);
  if (heading?.[1]?.trim() === title) {
    offset += 1;
    while (offset < lines.length && !lines[offset].trim()) {
      offset += 1;
    }
  }
  return lines.slice(offset).join("\n").trim();
}

export function slugifyLibraryId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\.md$/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

export function suggestLibraryPagePath(db: string, title: string, nearbyPath?: string): string {
  const cleanDb = normalizeLibraryDbId(db);
  const stem = slugifyLibraryId(title) || "note";
  const nearby = nearbyPath ? normalizeDbScopedLibraryPath(nearbyPath, cleanDb) : "";
  if (nearby.includes("/pages/")) {
    const folder = nearby.slice(0, nearby.lastIndexOf("/") + 1);
    return `${folder}${stem}.md`;
  }
  return `${cleanDb}/pages/${stem}.md`;
}

export function sortLibraryEntries(entries: readonly LibraryEntry[]): LibraryEntry[] {
  return [...entries].sort((left, right) => {
    if (left.path.endsWith("/index.md") && !right.path.endsWith("/index.md")) return -1;
    if (!left.path.endsWith("/index.md") && right.path.endsWith("/index.md")) return 1;
    return left.title.localeCompare(right.title) || left.path.localeCompare(right.path);
  });
}

export function localLibraryPath(path: string, db: string): string {
  return libraryPathInDb(path, db) || "index.md";
}

export function buildLibraryTree(entries: readonly LibraryEntry[], db: string): LibraryTreeNode {
  const root: LibraryTreeNode = {
    id: "root",
    name: "root",
    path: "",
    title: "ROOT",
    kind: "root",
    children: [],
    count: 0,
  };
  const folders = new Map<string, LibraryTreeNode>([["", root]]);

  for (const entry of sortLibraryEntries(entries)) {
    const local = localLibraryPath(entry.path, db);
    const parts = local.split("/").filter(Boolean);
    let parent = root;
    let folderKey = "";

    for (const part of parts.slice(0, -1)) {
      const nextKey = folderKey ? `${folderKey}/${part}` : part;
      let folder = folders.get(nextKey);
      if (!folder) {
        folder = {
          id: `folder:${nextKey}`,
          name: part,
          path: nextKey,
          title: folderTitle(part),
          kind: "folder",
          children: [],
          count: 0,
        };
        folders.set(nextKey, folder);
        parent.children.push(folder);
      }
      folder.count += 1;
      parent = folder;
      folderKey = nextKey;
    }

    root.count += 1;
    parent.children.push({
      id: `file:${entry.path}`,
      name: parts[parts.length - 1] ?? entry.path,
      path: local,
      title: local === "index.md" ? "Overview" : entry.title,
      kind: "file",
      children: [],
      entry,
      count: 1,
    });
  }

  sortTreeChildren(root);
  return root;
}

export function ancestorFolderPaths(localPath: string): string[] {
  const parts = normalizeLibraryPath(localPath).split("/").filter(Boolean);
  const paths: string[] = [];
  for (let index = 1; index < parts.length; index += 1) {
    paths.push(parts.slice(0, index).join("/"));
  }
  return paths;
}

export function libraryEntrySub(entry: LibraryEntry, db: string): string {
  const local = libraryPathInDb(entry.path, db);
  return local || entry.path;
}

export function librarySnippet(markdown: string, title: string, query: string): string {
  const text = stripLibraryFrontmatter(markdown).replace(/\s+/g, " ").trim();
  if (!text) {
    return title;
  }
  const target = query.trim().toLowerCase();
  const lower = text.toLowerCase();
  const index = target ? lower.indexOf(target) : -1;
  if (index < 0) {
    return text.slice(0, 180);
  }
  const start = Math.max(0, index - 64);
  const end = Math.min(text.length, index + target.length + 116);
  return `${start > 0 ? "..." : ""}${text.slice(start, end)}${end < text.length ? "..." : ""}`;
}

export function scoreLibraryMatch(path: string, title: string, markdown: string, terms: readonly string[]): number {
  const haystacks = {
    title: title.toLowerCase(),
    path: path.toLowerCase(),
    body: markdown.toLowerCase(),
  };
  let score = 0;
  for (const term of terms) {
    if (haystacks.title.includes(term)) score += 120;
    if (haystacks.path.includes(term)) score += 40;
    if (haystacks.body.includes(term)) score += 10;
  }
  return score;
}

export function normalizeLibraryQueryTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function slugifyHeading(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-") || "section";
}

function titleCase(value: string): string {
  return value
    .split(/\s+/g)
    .filter(Boolean)
    .map((part) => part.length <= 3 ? part.toUpperCase() : `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function folderTitle(value: string): string {
  if (value === "pages") {
    return "Pages";
  }
  return titleCase(value.replace(/[-_]+/g, " "));
}

function sortTreeChildren(node: LibraryTreeNode): void {
  node.children.sort((left, right) => {
    if (left.kind !== right.kind) {
      if (left.kind === "file" && left.path === "index.md") return -1;
      if (right.kind === "file" && right.path === "index.md") return 1;
      return left.kind === "folder" ? -1 : 1;
    }
    return left.title.localeCompare(right.title) || left.path.localeCompare(right.path);
  });
  for (const child of node.children) {
    sortTreeChildren(child);
  }
}
