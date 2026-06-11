import { ArticleView } from "../../article-view";
import type { WikiPreviewRequest, WikiWorkspaceState } from "../../types";
import { WikiIcon } from "../ui/wiki-icon";

type Props = {
  state: WikiWorkspaceState;
  currentTitle: string;
  routeBase: string;
  selectedDb: string;
  pageHeadings: Array<{ level: number; text: string; id: string }>;
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
        </div>
        <div class="wiki-pane-actions">
          <button type="button" class="is-secondary" onClick={props.onEditPage} disabled={!props.selectedDb} title="Edit current page" aria-label="Edit current page">
            <WikiIcon name="edit" />
            <span>Edit</span>
          </button>
        </div>
      </div>
      <div class="wiki-reader-grid">
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
        {props.pageHeadings.length > 0 ? (
          <nav class="wiki-reader-outline" aria-label="Page outline">
            <h3>Outline</h3>
            {props.pageHeadings.map((heading) => (
              <a key={heading.id} href={`#${heading.id}`} class={`wiki-outline-row level-${heading.level}`}>{heading.text}</a>
            ))}
          </nav>
        ) : null}
      </div>
    </section>
  );
}
