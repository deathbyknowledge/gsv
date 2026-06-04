import type { MessageRow } from "../../types";
import type { TranscriptRunGroup } from "../../domain/run-groups";
import { runHasDetails } from "../../domain/run-groups";
import { BranchIcon, ChevronRightIcon, CopyIcon, MoreIcon, ThoughtIcon, XIcon } from "../../icons";
import {
  closeChatMenus,
  closeContainingChatMenu,
  formatInteractionOriginLabel,
  formatTimestamp,
  inferToolSyscall,
  labelForRole,
  renderMarkdownHtml,
} from "../../view-helpers";
import { HilCard } from "./HilCard";
import { MessageBubble } from "./MessageBubble";
import { isHiddenInternalToolRow, ToolCard } from "./ToolCard";

export function RunGroupView({
  group,
  now,
  selected,
  userLabel,
  assistantLabel,
  branchBusy,
  hilBusy,
  mediaSources,
  mediaSourceErrors,
  onCopy,
  onBranch,
  onHilDecision,
  onLoadMediaSource,
  onRetryMediaSource,
  onOpenThoughts,
}: {
  group: TranscriptRunGroup;
  now: number;
  selected: boolean;
  userLabel: string;
  assistantLabel: string;
  branchBusy: boolean;
  hilBusy: boolean;
  mediaSources: Record<string, string>;
  mediaSourceErrors: Record<string, string>;
  onCopy(text: string): void;
  onBranch(messageId: number): void;
  onHilDecision(requestId: string, decision: "approve" | "deny", remember?: boolean): void;
  onLoadMediaSource(media: unknown): void;
  onRetryMediaSource(media: unknown): void;
  onOpenThoughts(runId: string): void;
}) {
  const detailsAvailable = runHasDetails(group);
  const responseRows = group.rows.filter((row) => !(row.kind === "message" && row.role === "user"));
  return (
    <section class={`run-group${selected ? " is-selected" : ""}`}>
      {group.userRows.map((row, index) => (
        <MessageBubble
          key={`${row.messageId ?? "user"}:${row.timestamp}:${index}`}
          row={row}
          userLabel={userLabel}
          assistantLabel={assistantLabel}
          branchBusy={branchBusy}
          mediaSources={mediaSources}
          mediaSourceErrors={mediaSourceErrors}
          onCopy={onCopy}
          onBranch={onBranch}
          onLoadMediaSource={onLoadMediaSource}
          onRetryMediaSource={onRetryMediaSource}
        />
      ))}
      {detailsAvailable ? (
        <button
          type="button"
          class={`run-thought-button${group.status === "running" ? " is-live" : ""}`}
          aria-expanded={selected}
          onClick={() => onOpenThoughts(group.runId)}
        >
          {group.status === "running" ? <span class="spinner" aria-hidden="true" /> : <ThoughtIcon />}
          <span>{runThoughtLabel(group, now)}</span>
          <ChevronRightIcon />
        </button>
      ) : null}
      {group.pendingHil ? (
        <HilCard request={group.pendingHil} busy={hilBusy} onDecision={onHilDecision} />
      ) : null}
      {responseRows.map((row, index) => {
        if (row.kind === "toolCall" || row.kind === "toolResult") {
          return null;
        }
        if (row.role === "assistant") {
          return (
            <AssistantDocument
              key={`${row.messageId ?? "assistant"}:${row.timestamp}:${index}`}
              row={row}
              assistantLabel={assistantLabel}
              branchBusy={branchBusy}
              onCopy={onCopy}
              onBranch={onBranch}
            />
          );
        }
        return (
          <MessageBubble
            key={`${row.messageId ?? "system"}:${row.timestamp}:${index}`}
            row={row}
            userLabel={userLabel}
            assistantLabel={assistantLabel}
            branchBusy={branchBusy}
            mediaSources={mediaSources}
            mediaSourceErrors={mediaSourceErrors}
            onCopy={onCopy}
            onBranch={onBranch}
            onLoadMediaSource={onLoadMediaSource}
            onRetryMediaSource={onRetryMediaSource}
          />
        );
      })}
    </section>
  );
}

export function ThoughtsDrawer({
  group,
  hilBusy,
  onClose,
  onHilDecision,
}: {
  group: TranscriptRunGroup | null;
  hilBusy: boolean;
  onClose(): void;
  onHilDecision(requestId: string, decision: "approve" | "deny", remember?: boolean): void;
}) {
  if (!group) {
    return null;
  }
  const thinkingBlocks = group.assistantRows.flatMap((row) => row.thinking?.filter(Boolean) ?? []);
  const visibleToolRows = group.toolRows.filter((row) => !isHiddenInternalToolRow(row, group.pendingHil));
  const hasDetails = thinkingBlocks.length > 0 || visibleToolRows.length > 0 || group.pendingHil !== null;
  return (
    <aside class="thoughts-drawer" aria-label="Thoughts">
      <header class="thoughts-drawer-head">
        <div>
          <h2>Thoughts</h2>
          <p>{runDrawerSubtitle(group)}</p>
        </div>
        <button type="button" class="icon-button small" title="Close thoughts" aria-label="Close thoughts" onClick={onClose}>
          <XIcon />
        </button>
      </header>
      <div class="thoughts-drawer-body">
        {thinkingBlocks.map((text, index) => (
          <article class="thought-entry" key={`thinking:${index}`}>
            <div class="thought-entry-head">
              <ThoughtIcon />
              <span>Reasoning</span>
            </div>
            <p>{text}</p>
          </article>
        ))}
        {group.pendingHil ? (
          <HilCard request={group.pendingHil} busy={hilBusy} onDecision={onHilDecision} />
        ) : null}
        {visibleToolRows.map((row, index) => (
          <ToolCard key={`${row.callId}:${index}`} row={row} />
        ))}
        {!hasDetails ? (
          <p class="thought-empty">No tool activity</p>
        ) : null}
      </div>
    </aside>
  );
}

function AssistantDocument({
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
      <div class="message-body message-markdown" dangerouslySetInnerHTML={{ __html: renderMarkdownHtml(row.text) }} />
    </article>
  );
}

function runThoughtLabel(group: TranscriptRunGroup, now: number): string {
  const end = group.status === "completed" ? group.updatedAt : now;
  const duration = formatRunDuration(group.startedAt, end);
  if (group.status === "waiting") {
    return duration ? `Waiting for approval · ${duration}` : "Waiting for approval";
  }
  if (group.status === "running") {
    const activity = group.pendingAssistant === "tool" ? latestToolActivity(group) : "Thinking";
    return duration ? `${activity} · ${duration}` : activity;
  }
  return duration ? `Thought for ${duration}` : "Thought";
}

function runDrawerSubtitle(group: TranscriptRunGroup): string {
  if (group.status === "waiting") return "Waiting for approval";
  if (group.status === "running") return latestToolActivity(group);
  return group.toolRows.length > 0
    ? `${group.toolRows.length} ${group.toolRows.length === 1 ? "tool event" : "tool events"}`
    : "Reasoning";
}

function latestToolActivity(group: TranscriptRunGroup): string {
  const latest = group.toolRows[group.toolRows.length - 1];
  if (!latest) return "Thinking";
  const syscall = inferToolSyscall(latest.toolName, latest.syscall);
  if (latest.kind === "toolResult") {
    return latest.ok === false ? "Tool failed" : "Tool finished";
  }
  if (latest.toolName === "Shell" || syscall === "shell.exec") return "Using shell";
  if (latest.toolName === "Read" || syscall === "fs.read") return "Reading file";
  if (latest.toolName === "Search" || syscall === "fs.search") return "Searching files";
  if (latest.toolName === "Write" || syscall === "fs.write") return "Writing file";
  if (latest.toolName === "Edit" || syscall === "fs.edit") return "Editing file";
  if (latest.toolName === "CodeMode" || syscall === "codemode.exec" || syscall === "codemode.run") return "Using CodeMode";
  return `Using ${latest.toolName}`;
}

function formatRunDuration(start: number, end: number): string {
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds <= 0) return "";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder > 0 ? `${minutes}m ${remainder}s` : `${minutes}m`;
}
