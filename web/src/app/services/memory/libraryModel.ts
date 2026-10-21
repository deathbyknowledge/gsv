import type { LibraryEntry, LibraryTreeNode } from "./libraryTypes";

export function normalizeLibraryPath<T>(value: T): string {
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

export function normalizeLibraryDbId<T>(value: T): string {
  const db = normalizeLibraryPath(value);
  if (!db || db.includes("/")) {
    throw new Error("collection id is required");
  }
  return db;
}

export function normalizeDbScopedLibraryPath<T>(value: T, db: string): string {
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
      title: entry.title,
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
