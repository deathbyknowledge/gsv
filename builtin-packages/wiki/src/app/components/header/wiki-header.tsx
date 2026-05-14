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
};

export function WikiHeader(props: Props) {
  const scope = props.activeDb?.title || props.selectedDb || "No database";
  const detail = props.selectedPath || labelForMode(props.mode);

  return (
    <header class="wiki-header">
      <div class="wiki-app-title">
        <span class="wiki-app-mark"><WikiIcon name="book" /></span>
        <div>
          <h1>Wiki</h1>
          <p>{scope}</p>
        </div>
      </div>
      <div class="wiki-header-context">
        <span>{props.currentTitle || labelForMode(props.mode)}</span>
        <code title={detail}>{detail}</code>
      </div>
      <div class="wiki-header-counts" aria-label="Wiki counts">
        <span title={`${props.pageCount} pages`}>{props.pageCount} pages</span>
        <span title={`${props.inboxCount} inbox notes`}>{props.inboxCount} inbox</span>
      </div>
    </header>
  );
}

function labelForMode(mode: WikiMode): string {
  if (mode === "browse") return "Browse";
  if (mode === "edit") return "Edit";
  if (mode === "build") return "Build";
  if (mode === "ingest") return "Ingest";
  return "Inbox";
}
