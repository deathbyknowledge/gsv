import type { HilRequest, LogRow, MessageRow, PendingAssistantState } from "../../types";
import { ArrowDownIcon } from "../../icons";
import { HilCard } from "./HilCard";
import { MessageBubble } from "./MessageBubble";
import { isHiddenInternalToolRow, ToolCard } from "./ToolCard";

export function Transcript(props: {
  rows: LogRow[];
  userLabel: string;
  pendingAssistant: PendingAssistantState;
  pendingHil: HilRequest | null;
  hasOlderHistory: boolean;
  loadingOlderHistory: boolean;
  hasNewMessages: boolean;
  hilBusy: boolean;
  branchBusy: boolean;
  refNode: { current: HTMLDivElement | null };
  mediaSources: Record<string, string>;
  mediaSourceErrors: Record<string, string>;
  onCopy(text: string): void;
  onBranch(messageId: number): void;
  onHilDecision(requestId: string, decision: "approve" | "deny", remember?: boolean): void;
  onLoadOlderHistory(): void;
  onJumpToLatest(): void;
  onViewedLatest(node: HTMLDivElement): void;
  onLoadMediaSource(media: unknown): void;
  onRetryMediaSource(media: unknown): void;
}) {
  const hilRendered = props.pendingHil
    ? props.rows.some((row) => row.kind === "toolCall" && row.callId === props.pendingHil?.callId)
    : true;
  return (
    <div class="transcript-shell">
      <div
        class="transcript"
        ref={(node) => { props.refNode.current = node; }}
        onScroll={(event) => {
          const node = event.currentTarget;
          if (props.hasOlderHistory && !props.loadingOlderHistory && node.scrollTop <= 96) {
            props.onLoadOlderHistory();
          }
          props.onViewedLatest(node);
        }}
      >
        {props.hasOlderHistory || props.loadingOlderHistory ? (
          <button
            type="button"
            class="history-loader"
            disabled={props.loadingOlderHistory}
            onClick={props.onLoadOlderHistory}
          >
            {props.loadingOlderHistory ? <span class="spinner" aria-hidden="true" /> : null}
            <span>{props.loadingOlderHistory ? "Loading older messages" : "Load older messages"}</span>
          </button>
        ) : null}
        {props.rows.map((row, index) => {
          if (row.kind === "toolCall" || row.kind === "toolResult") {
            if (props.pendingHil && row.kind === "toolCall" && row.callId === props.pendingHil.callId) {
              return (
                <HilCard
                  key={`${row.callId}:${index}`}
                  request={{ ...props.pendingHil, toolName: row.toolName || props.pendingHil.toolName, syscall: row.syscall || props.pendingHil.syscall, args: row.args ?? props.pendingHil.args }}
                  busy={props.hilBusy}
                  onDecision={props.onHilDecision}
                />
              );
            }
            if (isHiddenInternalToolRow(row, props.pendingHil)) {
              return null;
            }
            return <ToolCard key={`${row.callId}:${index}`} row={row} />;
          }
          const messageRow = row as MessageRow;
          return (
            <MessageBubble
              key={`${messageRow.messageId ?? index}:${messageRow.timestamp}`}
              row={messageRow}
              userLabel={props.userLabel}
              branchBusy={props.branchBusy}
              mediaSources={props.mediaSources}
              mediaSourceErrors={props.mediaSourceErrors}
              onCopy={props.onCopy}
              onBranch={props.onBranch}
              onLoadMediaSource={props.onLoadMediaSource}
              onRetryMediaSource={props.onRetryMediaSource}
            />
          );
        })}
        {props.pendingHil && !hilRendered ? (
          <HilCard request={props.pendingHil} busy={props.hilBusy} onDecision={props.onHilDecision} />
        ) : null}
        {props.pendingAssistant ? (
          <article class="message-pending">
            <span class="spinner" aria-hidden="true" />
            <span>{props.pendingAssistant === "tool" ? "Working..." : "Thinking..."}</span>
          </article>
        ) : null}
      </div>
      {props.hasNewMessages ? (
        <button type="button" class="new-messages-button" onClick={props.onJumpToLatest}>
          <ArrowDownIcon />
          <span>New messages</span>
        </button>
      ) : null}
    </div>
  );
}
