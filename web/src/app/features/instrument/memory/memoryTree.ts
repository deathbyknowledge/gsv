import { buildLibraryTree } from "../../gsv-console/library/libraryModel";
import type { LibraryEntry, LibraryTreeNode } from "../../gsv-console/library/libraryTypes";

/** The collection is the root: show its overview and the folders inside pages/. */
export function buildMemoryTree(entries: readonly LibraryEntry[], db: string): LibraryTreeNode[] {
  const tree = buildLibraryTree(entries, db);
  return tree.children.flatMap((node) => node.kind === "folder" && node.path === "pages" ? node.children : [node]);
}

/** Page shortcuts follow the same order as the sidebar, revealing folders as needed. */
export function memoryTreePages(nodes: readonly LibraryTreeNode[]): LibraryEntry[] {
  return nodes.flatMap((node) => node.entry ? [node.entry] : memoryTreePages(node.children));
}
