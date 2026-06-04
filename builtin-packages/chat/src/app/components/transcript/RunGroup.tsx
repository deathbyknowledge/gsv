import type { MessageRow } from "../../types";
import type { RunDetailEntry, TranscriptRunGroup } from "../../domain/run-groups";
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
  const interimRows = new Set(group.interimAssistantRows);
  const responseRows = group.rows.filter((row) => (
    !(row.kind === "message" && row.role === "user")
    && !(row.kind === "toolCall" || row.kind === "toolResult")
    && !(row.kind === "message" && row.role === "assistant" && interimRows.has(row))
  ));
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
  const visibleEntries = group.detailEntries.filter((entry) => (
    entry.kind !== "tool" || !isHiddenInternalToolRow(entry.row, group.pendingHil)
  ));
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
        {visibleEntries.map((entry, index) => (
          <ThoughtDrawerEntry
            key={`${entry.kind}:${entry.kind === "tool" ? entry.row.callId : index}`}
            entry={entry}
            hilBusy={hilBusy}
            onHilDecision={onHilDecision}
          />
        ))}
        {visibleEntries.length === 0 ? (
          <p class="thought-empty">No tool activity</p>
        ) : null}
      </div>
    </aside>
  );
}

function ThoughtDrawerEntry({
  entry,
  hilBusy,
  onHilDecision,
}: {
  entry: RunDetailEntry;
  hilBusy: boolean;
  onHilDecision(requestId: string, decision: "approve" | "deny", remember?: boolean): void;
}) {
  if (entry.kind === "tool") {
    return <ToolCard row={entry.row} />;
  }
  if (entry.kind === "hil") {
    return <HilCard request={entry.request} busy={hilBusy} onDecision={onHilDecision} />;
  }
  if (entry.kind === "interimText") {
    return <InterimTextEntry row={entry.row} />;
  }
  return (
    <article class="thought-entry">
      <div class="thought-entry-head">
        <ThoughtIcon />
        <span>Reasoning</span>
      </div>
      <p>{entry.text}</p>
    </article>
  );
}

function InterimTextEntry({ row }: { row: MessageRow }) {
  return (
    <article class="thought-entry thought-entry-text">
      <div class="thought-entry-head">
        <ThoughtIcon />
        <span>Interim response</span>
      </div>
      <div class="message-markdown" dangerouslySetInnerHTML={{ __html: renderMarkdownHtml(row.text) }} />
    </article>
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
    const activity = latestRunActivity(group);
    return duration ? `${activity} · ${duration}` : activity;
  }
  return duration ? `Thought for ${duration}` : "Thought";
}

function runDrawerSubtitle(group: TranscriptRunGroup): string {
  if (group.status === "waiting") return "Waiting for approval";
  if (group.status === "running") return latestRunActivity(group);
  return group.toolRows.length > 0
    ? `${group.toolRows.length} ${group.toolRows.length === 1 ? "tool event" : "tool events"}`
    : "Reasoning";
}

function latestRunActivity(group: TranscriptRunGroup): string {
  const latest = [...group.detailEntries].reverse().find((entry) => entry.kind !== "hil");
  if (!latest) {
    return group.pendingAssistant === "tool" ? "Working" : "Thinking";
  }
  if (latest.kind === "thinking") return "Thinking";
  if (latest.kind === "interimText") return "Drafting interim response";
  return toolActivity(latest.row);
}

function toolActivity(row: Extract<RunDetailEntry, { kind: "tool" }>["row"]): string {
  const syscall = inferToolSyscall(row.toolName, row.syscall);
  if (row.kind === "toolResult") {
    return row.ok === false ? "Tool failed" : "Tool finished";
  }
  if (row.toolName === "Shell" || syscall === "shell.exec") return "Using shell";
  if (row.toolName === "Read" || syscall === "fs.read") return "Reading file";
  if (row.toolName === "Search" || syscall === "fs.search") return "Searching files";
  if (row.toolName === "Write" || syscall === "fs.write") return "Writing file";
  if (row.toolName === "Edit" || syscall === "fs.edit") return "Editing file";
  if (row.toolName === "CodeMode" || syscall === "codemode.exec" || syscall === "codemode.run") return "Using CodeMode";
  return `Using ${row.toolName}`;
}

function formatRunDuration(start: number, end: number): string {
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds <= 0) return "";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder > 0 ? `${minutes}m ${remainder}s` : `${minutes}m`;
}
