import type { Translate } from "../../../i18n/locale";
import { buildLibraryTree, libraryPathInDb } from "../../../services/memory/libraryModel";
import type { LibraryEntry, LibraryTreeNode } from "../../../services/memory/libraryTypes";

/** The collection is the root: show its overview and the folders inside pages/. */
export function buildMemoryTree(entries: readonly LibraryEntry[], db: string): LibraryTreeNode[] {
  const tree = buildLibraryTree(entries, db);
  return tree.children.flatMap((node) => node.kind === "folder" && node.path === "pages" ? node.children : [node]);
}

/** The collection overview is named by the interface; every other page shows its own title, else its path. */
export function memoryPageTitle(t: Translate, entry: LibraryEntry, db: string): string {
  return libraryPathInDb(entry.path, db) === "index.md" ? t("memory.overview") : entry.title || entry.path;
}

/** Page shortcuts follow the same order as the sidebar, revealing folders as needed. */
export function memoryTreePages(nodes: readonly LibraryTreeNode[]): LibraryEntry[] {
  return nodes.flatMap((node) => node.entry ? [node.entry] : memoryTreePages(node.children));
}
