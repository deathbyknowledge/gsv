import type { MessageRow } from "../../types";
import { BranchIcon, CopyIcon } from "../../icons";
import {
  formatInteractionOriginLabel,
  formatTimestamp,
  labelForRole,
  renderMarkdownHtml,
} from "../../view-helpers";
import { AssistantMarkdown } from "./AssistantMarkdown";

export function AssistantDocument({
  row,
  assistantLabel,
  branchBusy,
  onCopy,
  onBranch,
}: {
  row: MessageRow;
  assistantLabel: string;
  branchBusy: boolean;
  onCopy(text: string): void;
  onBranch(messageId: number): void;
}) {
  const hasText = row.text.trim().length > 0;
  if (!hasText) {
    return null;
  }
  const originLabel = formatInteractionOriginLabel(row.origin);
  const roleLabel = labelForRole("assistant", "You", assistantLabel);
  const timestampLabel = formatTimestamp(row.timestamp);
  return (
    <article class={`assistant-document${row.streaming ? " is-live" : ""}`}>
      <div class="assistant-document-inner">
        {row.streaming ? (
          <div class="message-body message-markdown" dangerouslySetInnerHTML={{ __html: renderMarkdownHtml(row.text) }} />
        ) : (
          <AssistantMarkdown text={row.text} />
        )}
      </div>
      <footer class="assistant-document-footer">
        <span class="message-role-label">{roleLabel}</span>
        {originLabel ? <span class="message-origin-label" title={originLabel}>{originLabel}</span> : null}
        <span class="message-spacer" />
        <button type="button" class="message-action" title="Copy" aria-label="Copy" onClick={() => onCopy(row.text)}>
          <CopyIcon />
        </button>
        {row.messageId ? (
          <button
            type="button"
            class="message-action"
            title="Branch"
            aria-label="Branch"
            disabled={branchBusy}
            onClick={() => onBranch(row.messageId as number)}
          >
            <BranchIcon />
          </button>
        ) : null}
        <span>{timestampLabel}</span>
      </footer>
    </article>
  );
}
