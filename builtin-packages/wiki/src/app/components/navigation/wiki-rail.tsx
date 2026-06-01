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
  searchDraft: string;
  newDatabaseOpen: boolean;
  newDatabaseTitle: string;
  newDatabaseId: string;
  onOpenDb(db: string): void;
  onOpenPage(path: string): void;
  onOpenInboxNote(path: string): void;
  onCompileSelectedInbox(): Promise<void> | void;
  onNewPage(): void;
  onSearchDraftChange(value: string): void;
  onApplySearch(event: Event): void;
  onToggleCreateDatabase(): void;
  onCreateDatabase(event: Event): void;
  onNewDatabaseTitleChange(value: string): void;
  onNewDatabaseIdChange(value: string): void;
};

const MODES: Array<{ id: WikiMode; label: string; icon: WikiIconName; description: string }> = [
  { id: "browse", label: "Browse", icon: "book", description: "Read pages" },
  { id: "edit", label: "Edit", icon: "edit", description: "Write pages" },
  { id: "build", label: "Build", icon: "build", description: "Draft from folders" },
  { id: "ingest", label: "Stage", icon: "folder", description: "Capture source" },
  { id: "inbox", label: "Inbox", icon: "inbox", description: "Review staged notes" },
];

export function WikiRail(props: Props) {
  return (
    <aside class="wiki-rail" aria-label="Wiki navigation">
      <section class="wiki-nav-block wiki-nav-block--modes">
        <div class="wiki-nav-heading">
          <span>Work</span>
        </div>
        <nav class="wiki-mode-list" aria-label="Wiki work modes">
          {MODES.map((item) => (
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
      </section>

      <section class="wiki-nav-block">
        <div class="wiki-nav-heading">
          <span>Database</span>
          <button
            type="button"
            class="wiki-inline-icon-button"
            onClick={props.onToggleCreateDatabase}
            title={props.newDatabaseOpen ? "Close database creator" : "Create database"}
            aria-label={props.newDatabaseOpen ? "Close database creator" : "Create database"}
            aria-expanded={props.newDatabaseOpen}
          >
            <WikiIcon name="database" />
          </button>
        </div>
        <label class="wiki-sidebar-field">
          <select
            value={props.selectedDb}
            onChange={(event) => props.onOpenDb((event.currentTarget as HTMLSelectElement).value)}
            aria-label="Database"
          >
            <option value="">Select database</option>
            {props.state.dbs.map((db) => <option key={db.id} value={db.id}>{db.title || db.id}</option>)}
          </select>
        </label>
        {props.newDatabaseOpen ? (
          <form class="wiki-new-db-form" onSubmit={props.onCreateDatabase}>
            <input
              value={props.newDatabaseTitle}
              onInput={(event) => props.onNewDatabaseTitleChange((event.currentTarget as HTMLInputElement).value)}
              placeholder="Database title"
              aria-label="Database title"
            />
            <input
              value={props.newDatabaseId}
              onInput={(event) => props.onNewDatabaseIdChange((event.currentTarget as HTMLInputElement).value)}
              placeholder="database-id"
              aria-label="Database id"
            />
            <div class="wiki-sidebar-action-row">
              <button type="submit" disabled={props.mutating}>Create</button>
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
            <span>{props.activeDb?.title || props.selectedDb}</span>
            <code title={props.state.selectedPath || props.selectedDb}>{props.state.selectedPath || props.selectedDb}</code>
          </a>
        ) : (
          <div class="wiki-empty wiki-empty--compact">Create or select a database to begin.</div>
        )}
      </section>

      {(props.mode === "browse" || props.mode === "edit") ? (
        <section class="wiki-nav-block">
          <div class="wiki-nav-heading">
            <span>Search</span>
          </div>
          <form class="wiki-sidebar-search" onSubmit={props.onApplySearch}>
            <input
              value={props.searchDraft}
              onInput={(event) => props.onSearchDraftChange((event.currentTarget as HTMLInputElement).value)}
              placeholder="Find matching pages"
              type="search"
              title="Find matching pages and snippets"
              aria-label="Find matching pages"
            />
            <button type="submit" title="Find matching pages" aria-label="Find matching pages"><WikiIcon name="search" /></button>
          </form>
        </section>
      ) : null}

      {(props.mode === "browse" || props.mode === "edit") ? (
        <section class="wiki-nav-block wiki-nav-block--list">
          <div class="wiki-nav-heading">
            <span>{props.state.searchMatches ? "Matches" : "Pages"}</span>
            <button type="button" class="wiki-inline-icon-button" onClick={props.onNewPage} title="Create a new page" aria-label="Create a new page">
              <WikiIcon name="edit" />
            </button>
          </div>
          <PageList
            entries={props.visiblePages}
            routeBase={props.routeBase}
            selectedPath={props.state.selectedPath}
            selectedDb={props.selectedDb}
            onOpenPage={props.onOpenPage}
            emptyText={props.state.searchMatches ? "No matches." : "No pages yet."}
          />
        </section>
      ) : null}

      {props.mode === "inbox" ? (
        <section class="wiki-nav-block wiki-nav-block--list">
          <div class="wiki-nav-heading">
            <span>Inbox</span>
            <button
              type="button"
              class="wiki-inline-icon-button"
              onClick={() => void props.onCompileSelectedInbox()}
              disabled={props.mutating || !props.selectedInboxPath}
              title="Compile inbox note into a page"
              aria-label="Compile inbox note into a page"
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
            <small title={entry.path}>{entry.path}</small>
          </span>
        </a>
      ))}
    </div>
  );
}
