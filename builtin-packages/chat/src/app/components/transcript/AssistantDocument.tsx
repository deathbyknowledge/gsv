import type { MessageRow } from "../../types";
import { BranchIcon, CopyIcon, MoreIcon } from "../../icons";
import {
  closeChatMenus,
  closeContainingChatMenu,
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
  return (
    <article class={`assistant-document${row.streaming ? " is-live" : ""}`}>
      <div class="message-head">
        <span class="message-role-label">{labelForRole("assistant", "You", assistantLabel)}</span>
        {originLabel ? <span class="message-origin-label" title={originLabel}>{originLabel}</span> : null}
        <span class="message-spacer" />
        <span>{formatTimestamp(row.timestamp)}</span>
        <details class="message-menu">
          <summary class="message-action" title="Message actions" aria-label="Message actions" onClick={(event) => {
            closeChatMenus((event.currentTarget as HTMLElement).closest("details") as HTMLDetailsElement | null);
          }}>
            <MoreIcon />
          </summary>
          <div class="message-menu-popover">
            <button type="button" class="menu-action" onClick={(event) => { closeContainingChatMenu(event.currentTarget); onCopy(row.text); }}>
              <CopyIcon />
              <span>Copy</span>
            </button>
            {row.messageId ? (
              <button
                type="button"
                class="menu-action"
                disabled={branchBusy}
                onClick={(event) => { closeContainingChatMenu(event.currentTarget); onBranch(row.messageId as number); }}
              >
                <BranchIcon />
                <span>Branch</span>
              </button>
            ) : null}
          </div>
        </details>
      </div>
      {row.streaming ? (
        <div class="message-body message-markdown" dangerouslySetInnerHTML={{ __html: renderMarkdownHtml(row.text) }} />
      ) : (
        <AssistantMarkdown text={row.text} />
      )}
    </article>
  );
}
