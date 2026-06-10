import type { WikiMode } from "../../types";
import type { WikiDb } from "../../types";
import { WikiIcon } from "../ui/wiki-icon";

type Props = {
  mode: WikiMode;
  activeDb: WikiDb | undefined;
  selectedDb: string;
  selectedPath: string;
  currentTitle: string;
  pageCount: number;
  inboxCount: number;
  searchDraft: string;
  searchQuery: string;
  searchMatchCount: number | null;
  onSearchDraftChange(value: string): void;
  onApplySearch(event: Event): void;
};

export function WikiHeader(props: Props) {
  const scope = props.activeDb?.title || props.selectedDb || "No collection";
  const detail = props.selectedPath || labelForMode(props.mode);
  const resultText = resultLabel(props.searchQuery, props.searchMatchCount);

  return (
    <header class="wiki-header">
      <div class="wiki-app-title">
        <span class="wiki-app-mark"><WikiIcon name="book" /></span>
        <div>
          <h1>Wiki</h1>
          <p title={scope}>{scope}</p>
        </div>
      </div>

      <form class="wiki-global-search" onSubmit={props.onApplySearch} role="search">
        <WikiIcon name="search" />
        <input
          value={props.searchDraft}
          onInput={(event) => props.onSearchDraftChange((event.currentTarget as HTMLInputElement).value)}
          placeholder={props.selectedDb ? `Search ${scope}` : "Search pages"}
          type="search"
          title="Search pages"
          aria-label="Search pages"
        />
        <button type="submit" title="Search pages">
          <WikiIcon name="search" />
          <span>Search</span>
        </button>
      </form>

      <div class="wiki-header-context">
        <span title={props.currentTitle || undefined}>{props.currentTitle || labelForMode(props.mode)}</span>
        <code title={detail}>{detail}</code>
        <p title={resultText || undefined}>
          {resultText || `${props.pageCount} pages${props.inboxCount ? `, ${props.inboxCount} inbox` : ""}`}
        </p>
      </div>
    </header>
  );
}

function resultLabel(query: string, count: number | null): string {
  if (!query || count === null) {
    return "";
  }
  return `${count} ${count === 1 ? "match" : "matches"} for ${query}`;
}

function labelForMode(mode: WikiMode): string {
  if (mode === "browse") return "Read";
  if (mode === "edit") return "Edit page";
  if (mode === "build") return "Build manual";
  if (mode === "ingest") return "Add to inbox";
  return "Inbox";
}
