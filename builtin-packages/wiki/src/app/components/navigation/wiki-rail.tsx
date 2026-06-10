import { buildWikiHref, type WikiRoute } from "../../domain/route";
import { displayTitleFromPath } from "../../domain/wiki-model";
import { buildEntryHref } from "../../markdown";
import type { WikiDb, WikiEntry, WikiMode, WikiWorkspaceState } from "../../types";
import { WikiIcon, type WikiIconName } from "../ui/wiki-icon";

type Props = {
  mode: WikiMode;
  routeBase: string;
  onChangeMode(mode: WikiMode): void;
  state: WikiWorkspaceState;
  route: WikiRoute;
  selectedDb: string;
  activeDb: WikiDb | undefined;
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
  const collectionTitle = props.activeDb?.title || props.selectedDb || "No collection";
  const pageHeading = props.state.searchMatches ? "Search results" : "Pages";
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
        {props.selectedDb ? (
          <a
            class="wiki-current-context"
            href={buildWikiHref(props.mode, { ...props.route, db: props.selectedDb, path: props.state.selectedPath || `${props.selectedDb}/index.md` })}
            onClick={(event) => event.preventDefault()}
          >
            <span>{collectionTitle}</span>
            <code title={props.state.selectedPath || props.selectedDb}>{props.state.selectedPath || "Collection home"}</code>
          </a>
        ) : (
          <div class="wiki-empty wiki-empty--compact">Select or create a collection to start reading.</div>
        )}
      </section>

      <section class="wiki-nav-block wiki-nav-block--list">
        <div class="wiki-nav-heading">
          <span>{pageHeading}<em>{pageCount}</em></span>
          <button type="button" class="wiki-inline-icon-button" onClick={props.onNewPage} title="Create page" aria-label="Create page">
            <WikiIcon name="plus" />
          </button>
        </div>
        <PageList
          entries={props.visiblePages}
          routeBase={props.routeBase}
          selectedPath={props.state.selectedPath}
          selectedDb={props.selectedDb}
          onOpenPage={props.onOpenPage}
          emptyText={props.state.searchMatches ? "No matching pages." : props.selectedDb ? "No pages in this collection yet." : "No collection selected."}
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
          <PageList
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

function PageList({
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

  return (
    <div class="wiki-entry-list">
      {entries.map((entry) => (
        <a
          key={entry.path}
          href={buildEntryHref(routeBase, selectedDb, entry.path)}
          class={`wiki-entry-row${selectedPath === entry.path ? " is-active" : ""}`}
          onClick={(event) => {
            event.preventDefault();
            onOpenPage(entry.path);
          }}
        >
          <WikiIcon name={entry.path.includes("/inbox/") ? "inbox" : "file"} />
          <span>
            <strong title={entry.title || displayTitleFromPath(entry.path)}>{entry.title || displayTitleFromPath(entry.path)}</strong>
            <small title={entry.path}>{entry.snippet || entry.path}</small>
          </span>
        </a>
      ))}
    </div>
  );
}
