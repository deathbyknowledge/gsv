import { ArticleView } from "../../article-view";
import type { WikiPreviewRequest, WikiWorkspaceState } from "../../types";
import { WikiIcon } from "../ui/wiki-icon";

type Props = {
  state: WikiWorkspaceState;
  currentTitle: string;
  routeBase: string;
  selectedDb: string;
  searchQuery: string;
  searchMatchCount: number | null;
  onOpenPage(path: string): void;
  onEditPage(): void;
  onPreviewOpen(anchor: HTMLElement, request: WikiPreviewRequest, pin: boolean): void;
  onPreviewHide(force: boolean): void;
};

export function BrowsePane(props: Props) {
  return (
    <section class="wiki-pane wiki-reader-pane">
      <div class="wiki-pane-head wiki-reader-head">
        <div>
          <h2>{props.currentTitle || "Manual reader"}</h2>
          <p title={props.state.selectedPath || undefined}>{props.state.selectedPath || "Choose a page from the library or search for a topic."}</p>
        </div>
        <div class="wiki-pane-actions">
          <button type="button" class="is-secondary" onClick={props.onEditPage} disabled={!props.selectedDb} title="Edit current page" aria-label="Edit current page">
            <WikiIcon name="edit" />
            <span>Edit</span>
          </button>
        </div>
      </div>
      {props.searchQuery ? (
        <div class="wiki-search-summary" aria-live="polite">
          <WikiIcon name="search" />
          <span>{summaryText(props.searchQuery, props.searchMatchCount)}</span>
        </div>
      ) : null}
      <ArticleView
        markdown={props.state.selectedNote?.markdown || ""}
        articleTitle={props.currentTitle || "Untitled"}
        routeBase={props.routeBase}
        selectedDb={props.selectedDb}
        selectedPath={props.state.selectedPath}
        onNavigate={props.onOpenPage}
        onPreviewOpen={props.onPreviewOpen}
        onPreviewHide={props.onPreviewHide}
      />
    </section>
  );
}

function summaryText(query: string, count: number | null): string {
  if (count === null) {
    return `Search active for ${query}`;
  }
  if (count === 0) {
    return `No matching pages for ${query}`;
  }
  return `${count} ${count === 1 ? "match" : "matches"} for ${query}`;
}
