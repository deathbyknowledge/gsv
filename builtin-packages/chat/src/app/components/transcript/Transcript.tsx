import { useEffect, useMemo, useState } from "preact/hooks";
import type { HilRequest, LogRow, MessageRow, PendingAssistantState } from "../../types";
import type { TranscriptRunGroup } from "../../domain/run-groups";
import { groupTranscriptRows } from "../../domain/run-groups";
import { ArrowDownIcon } from "../../icons";
import { HilCard } from "./HilCard";
import { MessageBubble } from "./MessageBubble";
import { RunGroupView, ThoughtsDrawer } from "./RunGroup";
import { isHiddenInternalToolRow, ToolCard } from "./ToolCard";

export function Transcript(props: {
  rows: LogRow[];
  userLabel: string;
  assistantLabel: string;
  activeRunId?: string | null;
  pendingAssistant: PendingAssistantState;
  pendingHil: HilRequest | null;
  hasOlderHistory: boolean;
  loadingOlderHistory: boolean;
  hasNewMessages: boolean;
  hilBusy: boolean;
  branchBusy: boolean;
  refNode: { current: HTMLDivElement | null };
  onContentNode(node: HTMLDivElement | null): void;
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
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const items = useMemo(
    () => groupTranscriptRows(props.rows, props.pendingAssistant, props.pendingHil, props.activeRunId),
    [props.rows, props.pendingAssistant, props.pendingHil, props.activeRunId],
  );
  const selectedRun = useMemo(() => {
    if (!selectedRunId) {
      return null;
    }
    return items.find((item): item is TranscriptRunGroup => item.kind === "run" && item.runId === selectedRunId) ?? null;
  }, [items, selectedRunId]);
  const hilRendered = props.pendingHil
    ? items.some((item) => (
        item.kind === "run"
          ? item.pendingHil?.requestId === props.pendingHil?.requestId
          : item.row.kind === "toolCall" && item.row.callId === props.pendingHil?.callId
      ))
    : true;
  const pendingRendered = items.some((item) =>
    item.kind === "run" && (item.pendingAssistant !== null || item.pendingHil !== null)
  );

  useEffect(() => {
    if (selectedRunId && !selectedRun) {
      setSelectedRunId(null);
    }
  }, [selectedRun, selectedRunId]);

  useEffect(() => {
    if (!props.pendingAssistant && !props.pendingHil) {
      return undefined;
    }
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [props.pendingAssistant, props.pendingHil]);

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
        <div class="transcript-content" ref={props.onContentNode}>
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
          {items.map((item, index) => {
            if (item.kind === "run") {
              return (
                <RunGroupView
                  key={`run:${item.runId}:${index}`}
                  group={item}
                  now={now}
                  selected={selectedRunId === item.runId}
                  userLabel={props.userLabel}
                  assistantLabel={props.assistantLabel}
                  branchBusy={props.branchBusy}
                  hilBusy={props.hilBusy}
                  mediaSources={props.mediaSources}
                  mediaSourceErrors={props.mediaSourceErrors}
                  onCopy={props.onCopy}
                  onBranch={props.onBranch}
                  onHilDecision={props.onHilDecision}
                  onLoadMediaSource={props.onLoadMediaSource}
                  onRetryMediaSource={props.onRetryMediaSource}
                  onOpenThoughts={setSelectedRunId}
                />
              );
            }
            const row = item.row;
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
                assistantLabel={props.assistantLabel}
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
          {props.pendingAssistant && !pendingRendered ? (
            <article class="message-pending">
              <span class="spinner" aria-hidden="true" />
              <span>{props.pendingAssistant === "tool" ? "Working..." : "Thinking..."}</span>
            </article>
          ) : null}
        </div>
      </div>
      {props.hasNewMessages ? (
        <button type="button" class="new-messages-button" onClick={props.onJumpToLatest}>
          <ArrowDownIcon />
          <span>New messages</span>
        </button>
      ) : null}
      <ThoughtsDrawer
        group={selectedRun}
        hilBusy={props.hilBusy}
        now={now}
        onClose={() => setSelectedRunId(null)}
        onHilDecision={props.onHilDecision}
      />
    </div>
  );
}
