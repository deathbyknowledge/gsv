import { ArticleView } from "../../article-view";
import type { WikiPreviewRequest, WikiWorkspaceState } from "../../types";

type Props = {
  state: WikiWorkspaceState;
  currentTitle: string;
  selectedDb: string;
  onOpenPage(path: string): void;
  onPreviewOpen(anchor: HTMLElement, request: WikiPreviewRequest, pin: boolean): void;
  onPreviewHide(force: boolean): void;
};

export function BrowsePane(props: Props) {
  return (
    <section class="wiki-pane">
      <div class="wiki-pane-head">
        <div>
          <h2>{props.currentTitle || "Browse"}</h2>
          <p title={props.state.selectedPath || undefined}>{props.state.selectedPath || "Choose a page from navigation."}</p>
        </div>
      </div>
      <ArticleView
        markdown={props.state.selectedNote?.markdown || ""}
        articleTitle={props.currentTitle || "Untitled"}
        routeBase="/apps/wiki"
        selectedDb={props.selectedDb}
        selectedPath={props.state.selectedPath}
        onNavigate={props.onOpenPage}
        onPreviewOpen={props.onPreviewOpen}
        onPreviewHide={props.onPreviewHide}
      />
    </section>
  );
}
