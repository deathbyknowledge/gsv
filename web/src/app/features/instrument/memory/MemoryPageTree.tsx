import { useEffect, useState } from "preact/hooks";
import { ancestorFolderPaths } from "../../gsv-console/library/libraryModel";
import type { LibraryEntry, LibraryTreeNode } from "../../gsv-console/library/libraryTypes";

export function MemoryPageTree({ nodes, db, selectedPath, hidden, onOpen }: {
  nodes: readonly LibraryTreeNode[];
  db: string;
  selectedPath: string | null;
  hidden: boolean;
  onOpen(entry: LibraryEntry): void;
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    if (!selectedPath) return;
    const ancestors = ancestorFolderPaths(selectedPath);
    setExpanded((current) => new Set([...current, ...ancestors]));
  }, [selectedPath]);

  const toggle = (path: string, open: boolean) => setExpanded((current) => {
    if (current.has(path) === open) return current;
    const next = new Set(current);
    if (open) next.add(path);
    else next.delete(path);
    return next;
  });

  const renderNodes = (children: readonly LibraryTreeNode[]) => children.map((node) => {
    if (node.entry) {
      const entry = node.entry;
      return <button
        type="button"
        key={node.id}
        aria-current={entry.path === selectedPath ? "page" : undefined}
        class={`page${entry.path === selectedPath ? " is-sel" : ""}`}
        title={node.path}
        onClick={() => onOpen(entry)}
      ><span class="title">{node.title || entry.path}</span></button>;
    }
    const path = `${db}/${node.path}`;
    return <details
      key={path}
      class={`memory-folder${selectedPath?.startsWith(`${path}/`) ? " has-current" : ""}`}
      data-folder={path}
      open={expanded.has(path)}
      onToggle={(event) => toggle(path, event.currentTarget.open)}
    >
      <summary onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        toggle(path, event.key === "ArrowRight");
      }}>
        <span class="tri" aria-hidden="true">{expanded.has(path) ? "▾" : "▸"}</span>
        <span>{node.title}</span>
      </summary>
      <div class="memory-folder-pages">{renderNodes(node.children)}</div>
    </details>;
  });

  return <div hidden={hidden}>{renderNodes(nodes)}</div>;
}
