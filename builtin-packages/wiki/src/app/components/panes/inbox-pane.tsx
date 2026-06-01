import { ArticleView } from "../../article-view";
import { extractTitle } from "../../markdown";
import type { WikiPreviewRequest, WikiWorkspaceState } from "../../types";

type Props = {
  state: WikiWorkspaceState;
  routeBase: string;
  selectedDb: string;
  selectedInboxPath: string;
  mutating: boolean;
  onCompileSelectedInbox(): Promise<void> | void;
  onOpenPageAndBrowse(path: string): void;
  onPreviewOpen(anchor: HTMLElement, request: WikiPreviewRequest, pin: boolean): void;
  onPreviewHide(force: boolean): void;
};

export function InboxPane(props: Props) {
  return (
    <section class="wiki-pane">
      <div class="wiki-pane-head">
        <div>
          <h2>Inbox review</h2>
          <p>Preview staged notes and compile them into canonical pages when they are ready.</p>
        </div>
        <div class="wiki-pane-actions">
          <button type="button" onClick={() => void props.onCompileSelectedInbox()} disabled={props.mutating || !props.selectedInboxPath} title="Compile inbox note into a page" aria-label="Compile inbox note into a page">Compile</button>
        </div>
      </div>
      {props.state.selectedNote ? (
        <ArticleView
          markdown={props.state.selectedNote.markdown || ""}
          articleTitle={extractTitle(props.state.selectedNote.markdown || "", props.state.selectedNote.path)}
          routeBase={props.routeBase}
          selectedDb={props.selectedDb}
          selectedPath={props.state.selectedPath}
          onNavigate={props.onOpenPageAndBrowse}
          onPreviewOpen={props.onPreviewOpen}
          onPreviewHide={props.onPreviewHide}
        />
      ) : <div class="wiki-empty">Select an inbox note from navigation.</div>}
    </section>
  );
}
