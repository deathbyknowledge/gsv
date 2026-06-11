import { displayTitleFromPath } from "../../domain/wiki-model";
import { buildEntryHref } from "../../markdown";
import type { WikiEntry, WikiMode, WikiWorkspaceState } from "../../types";
import { WikiIcon, type WikiIconName } from "../ui/wiki-icon";

type Props = {
  mode: WikiMode;
  routeBase: string;
  onChangeMode(mode: WikiMode): void;
  state: WikiWorkspaceState;
  selectedDb: string;
  visiblePages: WikiEntry[];
  selectedInboxPath: string;
  mutating: boolean;
  newDatabaseOpen: boolean;
  newDatabaseTitle: string;
  newDatabaseId: string;
  onOpenDb(db: string): void;
  onOpenPage(path: string): void;
  onOpenInboxNote(path: string): void;
  onCompileSelectedInbox(): Promise<void> | void;
  onNewPage(): void;
  onToggleCreateDatabase(): void;
  onCreateDatabase(event: Event): void;
  onNewDatabaseTitleChange(value: string): void;
  onNewDatabaseIdChange(value: string): void;
};

const AUTHORING_MODES: Array<{ id: WikiMode; label: string; icon: WikiIconName; description: string }> = [
  { id: "edit", label: "Edit", icon: "edit", description: "Write or create pages" },
  { id: "inbox", label: "Inbox", icon: "inbox", description: "Review staged notes" },
  { id: "ingest", label: "Capture", icon: "folder", description: "Add source material to inbox" },
  { id: "build", label: "Build", icon: "build", description: "Build a manual from a folder" },
];

export function WikiRail(props: Props) {
  const pageCount = props.visiblePages.length;
  const authoringDetailsProps = props.mode !== "browse" ? { open: true } : {};

  return (
    <aside class="wiki-rail" aria-label="Wiki navigation">
      <section class="wiki-nav-block">
        <div class="wiki-nav-heading">
          <span>Library</span>
          <button
            type="button"
            class="wiki-inline-icon-button"
            onClick={props.onToggleCreateDatabase}
            title={props.newDatabaseOpen ? "Close collection creator" : "Create collection"}
            aria-label={props.newDatabaseOpen ? "Close collection creator" : "Create collection"}
            aria-expanded={props.newDatabaseOpen}
          >
            <WikiIcon name={props.newDatabaseOpen ? "close" : "plus"} />
          </button>
        </div>
        <label class="wiki-sidebar-field">
          <span>Collection</span>
          <select
            value={props.selectedDb}
            onChange={(event) => props.onOpenDb((event.currentTarget as HTMLSelectElement).value)}
            aria-label="Collection"
          >
            <option value="">Select collection</option>
            {props.state.dbs.map((db) => <option key={db.id} value={db.id}>{db.title || db.id}</option>)}
          </select>
        </label>
        {props.newDatabaseOpen ? (
          <form class="wiki-new-db-form" onSubmit={props.onCreateDatabase}>
            <input
              value={props.newDatabaseTitle}
              onInput={(event) => props.onNewDatabaseTitleChange((event.currentTarget as HTMLInputElement).value)}
              placeholder="Collection title"
              aria-label="Collection title"
            />
            <input
              value={props.newDatabaseId}
              onInput={(event) => props.onNewDatabaseIdChange((event.currentTarget as HTMLInputElement).value)}
              placeholder="short-id"
              aria-label="Collection short id"
            />
            <div class="wiki-sidebar-action-row">
              <button type="submit" disabled={props.mutating}><WikiIcon name="plus" /><span>Create</span></button>
              <button type="button" onClick={props.onToggleCreateDatabase}>Cancel</button>
            </div>
          </form>
        ) : null}
        {!props.selectedDb ? <div class="wiki-empty wiki-empty--compact">Select or create a collection to start reading.</div> : null}
      </section>

      <section class="wiki-nav-block wiki-nav-block--list">
        <div class="wiki-nav-heading">
          <span>Pages<em>{pageCount}</em></span>
          <button type="button" class="wiki-inline-icon-button" onClick={props.onNewPage} title="Create page" aria-label="Create page">
            <WikiIcon name="plus" />
          </button>
        </div>
        {props.selectedDb ? (
          <a
            href={buildEntryHref(props.routeBase, props.selectedDb, `${props.selectedDb}/index.md`)}
            class={`wiki-tree-file wiki-tree-overview${props.state.selectedPath === `${props.selectedDb}/index.md` ? " is-active" : ""}`}
            style="--tree-level: 0"
            onClick={(event) => {
              event.preventDefault();
              props.onOpenPage(`${props.selectedDb}/index.md`);
            }}
          >
            <WikiIcon name="book" />
            <span title="Collection overview">Overview</span>
          </a>
        ) : null}
        <PageTree
          entries={props.visiblePages}
          routeBase={props.routeBase}
          selectedPath={props.state.selectedPath}
          selectedDb={props.selectedDb}
          onOpenPage={props.onOpenPage}
          emptyText={props.selectedDb ? "No pages in this collection yet." : "No collection selected."}
        />
      </section>

      {props.mode === "inbox" ? (
        <section class="wiki-nav-block wiki-nav-block--list">
          <div class="wiki-nav-heading">
            <span>Inbox<em>{props.state.inbox.length}</em></span>
            <button
              type="button"
              class="wiki-inline-icon-button"
              onClick={() => void props.onCompileSelectedInbox()}
              disabled={props.mutating || !props.selectedInboxPath}
              title="Compile inbox item into a page"
              aria-label="Compile inbox item into a page"
            >
              <WikiIcon name="build" />
            </button>
          </div>
          <PageTree
            entries={props.state.inbox}
            routeBase={props.routeBase}
            selectedPath={props.selectedInboxPath}
            selectedDb={props.selectedDb}
            onOpenPage={props.onOpenInboxNote}
            emptyText="Inbox is empty."
          />
        </section>
      ) : null}

      <section class="wiki-nav-block wiki-authoring-block">
        <details class="wiki-authoring-details" {...authoringDetailsProps}>
          <summary>
            <span><WikiIcon name="settings" /> Authoring</span>
            {props.state.inbox.length > 0 ? <em>{props.state.inbox.length}</em> : null}
          </summary>
          <nav class="wiki-mode-list wiki-mode-list--authoring" aria-label="Authoring tools">
            <button
              type="button"
              class={`wiki-mode-row${props.mode === "browse" ? " is-active" : ""}`}
              onClick={() => props.onChangeMode("browse")}
              title="Read pages"
              aria-current={props.mode === "browse" ? "page" : undefined}
            >
              <WikiIcon name="book" />
              <span>Read</span>
            </button>
            {AUTHORING_MODES.map((item) => (
              <button
                key={item.id}
                type="button"
                class={`wiki-mode-row${props.mode === item.id ? " is-active" : ""}`}
                onClick={() => props.onChangeMode(item.id)}
                title={item.description}
                aria-current={props.mode === item.id ? "page" : undefined}
              >
                <WikiIcon name={item.icon} />
                <span>{item.label}</span>
                {item.id === "inbox" && props.state.inbox.length > 0 ? <em>{props.state.inbox.length}</em> : null}
              </button>
            ))}
          </nav>
        </details>
      </section>
    </aside>
  );
}

type PageTreeNode = {
  key: string;
  name: string;
  children: PageTreeNode[];
  entry?: WikiEntry;
  count: number;
};

function PageTree({
  entries,
  routeBase,
  selectedPath,
  selectedDb,
  onOpenPage,
  emptyText,
}: {
  entries: WikiEntry[];
  routeBase: string;
  selectedPath: string;
  selectedDb: string;
  onOpenPage(path: string): void;
  emptyText: string;
}) {
  if (entries.length === 0) {
    return <div class="wiki-empty wiki-empty--compact">{emptyText}</div>;
  }

  const tree = buildPageTree(entries, selectedDb);

  return (
    <div class="wiki-page-tree">
      {tree.children.map((node) => (
        <PageTreeBranch
          key={node.key}
          node={node}
          routeBase={routeBase}
          selectedPath={selectedPath}
          selectedDb={selectedDb}
          onOpenPage={onOpenPage}
          level={0}
        />
      ))}
    </div>
  );
}

function PageTreeBranch({
  node,
  routeBase,
  selectedPath,
  selectedDb,
  onOpenPage,
  level,
}: {
  node: PageTreeNode;
  routeBase: string;
  selectedPath: string;
  selectedDb: string;
  onOpenPage(path: string): void;
  level: number;
}) {
  if (node.entry) {
    const label = displayEntryTitle(node.entry);
    return (
      <a
        href={buildEntryHref(routeBase, selectedDb, node.entry.path)}
        class={`wiki-tree-file${selectedPath === node.entry.path ? " is-active" : ""}`}
        style={`--tree-level: ${level}`}
        onClick={(event) => {
          event.preventDefault();
          onOpenPage(node.entry!.path);
        }}
      >
        <WikiIcon name={node.entry.path.includes("/inbox/") ? "inbox" : "file"} />
        <span title={label}>{label}</span>
      </a>
    );
  }

  const selectedInside = containsSelectedPath(node, selectedPath);
  return (
    <details class="wiki-tree-folder" open={selectedInside}>
      <summary style={`--tree-level: ${level}`}>
        <WikiIcon name="folder" />
        <span title={node.name}>{displayFolderName(node.name)}</span>
        <em>{node.count}</em>
      </summary>
      <div class="wiki-tree-children">
        {node.children.map((child) => (
          <PageTreeBranch
            key={child.key}
            node={child}
            routeBase={routeBase}
            selectedPath={selectedPath}
            selectedDb={selectedDb}
            onOpenPage={onOpenPage}
            level={level + 1}
          />
        ))}
      </div>
    </details>
  );
}

function buildPageTree(entries: WikiEntry[], selectedDb: string): PageTreeNode {
  const root: PageTreeNode = { key: "root", name: "root", children: [], count: 0 };
  const folders = new Map<string, PageTreeNode>([["", root]]);

  for (const entry of entries) {
    const segments = displayPathSegments(entry.path, selectedDb);
    let parent = root;
    let parentKey = "";
    for (const segment of segments.slice(0, -1)) {
      const key = parentKey ? `${parentKey}/${segment}` : segment;
      let folder = folders.get(key);
      if (!folder) {
        folder = { key, name: segment, children: [], count: 0 };
        folders.set(key, folder);
        parent.children.push(folder);
      }
      folder.count += 1;
      parent = folder;
      parentKey = key;
    }
    root.count += 1;
    parent.children.push({
      key: entry.path,
      name: segments[segments.length - 1] || entry.path,
      children: [],
      entry,
      count: 1,
    });
  }

  sortPageTree(root);
  return root;
}

function sortPageTree(node: PageTreeNode): void {
  node.children.sort((left, right) => {
    if (Boolean(left.entry) !== Boolean(right.entry)) {
      return left.entry ? 1 : -1;
    }
    return left.name.localeCompare(right.name);
  });
  node.children.forEach(sortPageTree);
}

function displayPathSegments(path: string, selectedDb: string): string[] {
  let relativePath = path;
  const dbPrefix = selectedDb ? `${selectedDb}/` : "";
  if (dbPrefix && relativePath.startsWith(dbPrefix)) {
    relativePath = relativePath.slice(dbPrefix.length);
  }
  if (relativePath.startsWith("pages/")) {
    relativePath = relativePath.slice("pages/".length);
  } else if (relativePath.startsWith("inbox/")) {
    relativePath = relativePath.slice("inbox/".length);
  }
  return relativePath.split("/").filter(Boolean);
}

function displayFolderName(name: string): string {
  return titleCaseLabel(name.replace(/[-_]+/g, " "));
}

function displayEntryTitle(entry: WikiEntry): string {
  const fileName = entry.path.split("/").pop() || entry.path;
  if (/^index\.md$/i.test(fileName)) {
    return "Overview";
  }
  return titleCaseLabel(entry.title || displayTitleFromPath(entry.path));
}

function titleCaseLabel(value: string): string {
  const acronyms = new Map([
    ["ai", "AI"],
    ["api", "API"],
    ["cli", "CLI"],
    ["gsv", "GSV"],
    ["mcp", "MCP"],
    ["oauth", "OAuth"],
    ["pdf", "PDF"],
  ]);
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => {
      const normalized = word.toLowerCase();
      return acronyms.get(normalized) ?? `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`;
    })
    .join(" ");
}

function containsSelectedPath(node: PageTreeNode, selectedPath: string): boolean {
  if (!selectedPath) {
    return false;
  }
  if (node.entry?.path === selectedPath) {
    return true;
  }
  return node.children.some((child) => containsSelectedPath(child, selectedPath));
}
