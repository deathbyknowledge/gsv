import type { WikiDb } from "../../types";
import type { WikiEntry } from "../../types";
import { displayTitleFromPath } from "../../domain/wiki-model";
import { WikiIcon } from "../ui/wiki-icon";

type Props = {
  activeDb: WikiDb | undefined;
  selectedDb: string;
  searchDraft: string;
  searchQuery: string;
  searchMatches: WikiEntry[] | null;
  searchOpen: boolean;
  searching: boolean;
  onSearchDraftChange(value: string): void;
  onSearchFocus(): void;
  onApplySearch(event: Event): void;
  onClearSearch(): void;
  onOpenMatch(path: string): void;
};

export function WikiHeader(props: Props) {
  const scope = props.activeDb?.title || props.selectedDb || "wiki";
  const matches = props.searchMatches ?? [];
  const showDropdown = props.searchOpen && props.searchDraft.trim().length > 0;

  return (
    <header class="wiki-header">
      <div class="wiki-search-wrap">
        <form class="wiki-global-search" onSubmit={props.onApplySearch} role="search">
          <WikiIcon name="search" />
          <input
            value={props.searchDraft}
            onInput={(event) => props.onSearchDraftChange((event.currentTarget as HTMLInputElement).value)}
            onFocus={props.onSearchFocus}
            placeholder={props.selectedDb ? `Search ${scope}` : "Search pages"}
            type="text"
            title="Search pages"
            aria-label="Search pages"
            autoComplete="off"
          />
          {props.searchDraft ? (
            <button type="button" class="wiki-search-icon-button" title="Clear search" aria-label="Clear search" onClick={props.onClearSearch}>
              <WikiIcon name="close" />
            </button>
          ) : null}
          <button type="submit" class="wiki-search-icon-button" title="Open first match" aria-label="Open first match">
            <WikiIcon name="search" />
          </button>
        </form>

        {showDropdown ? (
          <div class="wiki-search-popover" role="listbox" aria-label="Search matches">
            {props.searching ? <div class="wiki-search-state">Searching...</div> : null}
            {!props.searching && matches.length === 0 ? <div class="wiki-search-state">No matching pages.</div> : null}
            {!props.searching ? matches.map((match) => (
              <button
                key={match.path}
                type="button"
                class="wiki-search-result"
                onClick={() => props.onOpenMatch(match.path)}
              >
                <strong class="wiki-search-title">
                  <HighlightedText text={match.title || displayTitleFromPath(match.path)} query={props.searchQuery || props.searchDraft} />
                </strong>
                {match.snippet ? (
                  <span class="wiki-search-snippet">
                    <HighlightedText text={match.snippet} query={props.searchQuery || props.searchDraft} />
                  </span>
                ) : null}
              </button>
            )) : null}
          </div>
        ) : null}
      </div>
    </header>
  );
}

function HighlightedText({ text, query }: { text: string; query: string }) {
  const terms = query.trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) {
    return <>{text}</>;
  }
  const pattern = new RegExp(`(${terms.map(escapeRegExp).join("|")})`, "ig");
  const parts = text.split(pattern);
  return (
    <>
      {parts.map((part, index) => {
        const highlighted = terms.some((term) => part.toLowerCase() === term.toLowerCase());
        return highlighted ? <mark key={`${part}-${index}`}>{part}</mark> : part;
      })}
    </>
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
