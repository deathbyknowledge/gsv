import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import type { HilRequest, MessageRow, ToolRow } from "../../types";
import type { RunDetailEntry, TranscriptRunGroup } from "../../domain/run-groups";
import { runHasDetails } from "../../domain/run-groups";
import {
  BranchIcon,
  CheckIcon,
  ChevronRightIcon,
  CopyIcon,
  FileIcon,
  MessageIcon,
  MoreIcon,
  TerminalIcon,
  ThoughtIcon,
  XIcon,
} from "../../icons";
import {
  asNumber,
  asRecord,
  asString,
  basenamePath,
  closeChatMenus,
  closeContainingChatMenu,
  describeHilSummary,
  describeToolCard,
  formatInteractionOriginLabel,
  formatTimestamp,
  inferToolSyscall,
  labelForRole,
  normalizeToolOutput,
  prettyJson,
  renderMarkdownHtml,
  truncateBlock,
  truncateInline,
} from "../../view-helpers";
import { HilCard } from "./HilCard";
import { MessageBubble } from "./MessageBubble";
import { isHiddenInternalToolRow } from "./ToolCard";

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
  const responseRows = group.rows.filter((row): row is MessageRow => (
    row.kind === "message"
    && row.role !== "user"
    && !(row.role === "assistant" && interimRows.has(row))
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
  now,
  onClose,
  onHilDecision,
}: {
  group: TranscriptRunGroup | null;
  hilBusy: boolean;
  onClose(): void;
  onHilDecision(requestId: string, decision: "approve" | "deny", remember?: boolean): void;
  now?: number;
}) {
  if (!group) {
    return null;
  }
  const visibleEntries = group.detailEntries.filter((entry) => (
    entry.kind !== "tool" || !isHiddenInternalToolRow(entry.row, group.pendingHil)
  ));
  const summary = runDrawerSummary(group, visibleEntries, now);
  return (
    <aside class="thoughts-drawer" aria-label="Thoughts">
      <header class="thoughts-drawer-head">
        <div>
          <h2>Thoughts</h2>
          <p>{runDrawerSubtitle(group)}</p>
          <div class="thoughts-summary" aria-label="Run summary">
            {summary.map((item) => (
              <span key={item.label} class={item.tone ? `is-${item.tone}` : ""}>{item.label}</span>
            ))}
          </div>
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
    return <ToolTrajectoryEntry row={entry.row} />;
  }
  if (entry.kind === "hil") {
    return <HilTrajectoryEntry request={entry.request} busy={hilBusy} onDecision={onHilDecision} />;
  }
  if (entry.kind === "interimText") {
    return <InterimTextEntry row={entry.row} />;
  }
  return <ReasoningEntry text={entry.text} />;
}

function ReasoningEntry({ text }: { text: string }) {
  return (
    <TrajectoryEntry
      tone="reasoning"
      icon={<ThoughtIcon />}
      iconLabel="Reasoning"
      title="Reasoning"
      details={<pre>{text}</pre>}
      detailsLabel="Expand reasoning"
      detailsHideLabel="Collapse reasoning"
    />
  );
}

function InterimTextEntry({ row }: { row: MessageRow }) {
  return (
    <TrajectoryEntry
      tone="draft"
      icon={<MessageIcon />}
      iconLabel="Draft reply"
      title="Working draft"
      subtitle="Text produced before tools finished"
      body={<div class="message-markdown" dangerouslySetInnerHTML={{ __html: renderMarkdownHtml(row.text) }} />}
    />
  );
}

function ToolTrajectoryEntry({ row }: { row: ToolRow }) {
  const syscall = inferToolSyscall(row.toolName, row.syscall);
  const card = describeToolCard(row.toolName, row.args, syscall);
  const result = toolResultSummary(row, syscall);
  const display = toolTrajectoryDisplay(row, syscall, card, result);
  return (
    <TrajectoryEntry
      tone={result.tone}
      icon={toolEntryIcon(row, syscall)}
      iconLabel={display.iconLabel}
      title={display.title}
      subtitle={display.subtitle}
      status={display.status}
      meta={display.meta}
      body={display.body}
      details={display.details}
      detailsLabel={display.detailsLabel}
      detailsHideLabel={display.detailsHideLabel}
    />
  );
}

function HilTrajectoryEntry({
  request,
  busy,
  onDecision,
}: {
  request: HilRequest;
  busy: boolean;
  onDecision(requestId: string, decision: "approve" | "deny", remember?: boolean): void;
}) {
  const card = describeToolCard(request.toolName, request.args, request.syscall);
  return (
    <TrajectoryEntry
      tone="waiting"
      icon={<ThoughtIcon />}
      iconLabel="Waiting for approval"
      title="Approval required"
      subtitle={card.title}
      status="Waiting"
      body={<p>{describeHilSummary(request, request.syscall)}</p>}
      actions={(
        <div class="trajectory-actions">
          <button type="button" class="trajectory-action is-approve" title="Allow tool call" disabled={busy} onClick={() => onDecision(request.requestId, "approve")}>
            <CheckIcon />
            <span>Allow</span>
          </button>
          <button type="button" class="trajectory-action is-approve" title="Allow this tool for this process" disabled={busy} onClick={() => onDecision(request.requestId, "approve", true)}>
            <CheckIcon />
            <span>Always allow</span>
          </button>
          <button type="button" class="trajectory-action is-deny" title="Deny tool call" disabled={busy} onClick={() => onDecision(request.requestId, "deny")}>
            <XIcon />
            <span>Deny</span>
          </button>
        </div>
      )}
      details={<pre>{truncateBlock(prettyJson(request.args), 2400)}</pre>}
    />
  );
}

function TrajectoryEntry({
  tone,
  icon,
  iconLabel,
  title,
  subtitle,
  status,
  meta,
  body,
  actions,
  details,
  detailsLabel = "Details",
  detailsHideLabel,
}: {
  tone: TrajectoryTone;
  icon: ComponentChildren;
  iconLabel: string;
  title: string;
  subtitle?: string;
  status?: string;
  meta?: string[];
  body?: ComponentChildren;
  actions?: ComponentChildren;
  details?: ComponentChildren;
  detailsLabel?: string;
  detailsHideLabel?: string;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const disclosureLabel = detailsOpen ? detailsHideLabel ?? detailsLabel : detailsLabel;
  return (
    <article class={`trajectory-entry is-${tone}`}>
      <div class="trajectory-marker" role="img" aria-label={iconLabel} title={iconLabel}>{icon}</div>
      <div class="trajectory-panel">
        <div class="trajectory-title-row">
          <div>
            <h3>{title}</h3>
            {subtitle ? <p>{subtitle}</p> : null}
          </div>
          <div class="trajectory-title-actions">
            {status ? <span class={`trajectory-status is-${tone}`}>{status}</span> : null}
            {details ? (
              <button
                type="button"
                class={`trajectory-disclosure${detailsOpen ? " is-open" : ""}`}
                title={disclosureLabel}
                aria-label={disclosureLabel}
                aria-expanded={detailsOpen}
                onClick={() => setDetailsOpen((open) => !open)}
              >
                <ChevronRightIcon />
              </button>
            ) : null}
          </div>
        </div>
        {meta && meta.length > 0 ? (
          <div class="trajectory-meta">
            {meta.map((item) => <span key={item}>{item}</span>)}
          </div>
        ) : null}
        {body ? <div class="trajectory-body">{body}</div> : null}
        {actions}
        {details && detailsOpen ? <div class="trajectory-detail-body">{details}</div> : null}
      </div>
    </article>
  );
}

type ToolCardDescription = ReturnType<typeof describeToolCard>;
type ToolResultDisplay = { tone: TrajectoryTone; status: string; preview: string };

function toolTrajectoryDisplay(
  row: ToolRow,
  syscall: string | null,
  card: ToolCardDescription,
  result: ToolResultDisplay,
): {
  iconLabel: string;
  title: string;
  subtitle?: string;
  status?: string;
  meta?: string[];
  body?: ComponentChildren;
  details?: ComponentChildren;
  detailsLabel?: string;
  detailsHideLabel?: string;
} {
  const kind = fileToolKind(row, syscall);
  const targetMeta = card.target ? [card.target] : undefined;
  const details = toolDisclosureContent(row, syscall);
  const disclosureLabels = toolDisclosureLabels(row, syscall);
  const isDelete = kind === "delete";
  const showResultBody = row.kind === "toolCall"
    || result.tone === "error" && !isDelete
    || (!kind && result.preview.trim().length > 0);
  return {
    iconLabel: toolMarkerLabel(result),
    title: toolTrajectoryTitle(row, syscall, card),
    subtitle: card.subtitle || undefined,
    status: result.tone === "ok" ? undefined : result.status,
    meta: targetMeta,
    body: showResultBody ? <p class={result.tone === "error" ? "trajectory-error" : ""}>{result.preview}</p> : undefined,
    details,
    detailsLabel: details ? disclosureLabels.expand : undefined,
    detailsHideLabel: details ? disclosureLabels.collapse : undefined,
  };
}

function toolMarkerLabel(result: ToolResultDisplay): string {
  if (result.tone === "error") return result.preview ? `Error: ${result.preview}` : "Error";
  return result.status;
}

function toolTrajectoryTitle(row: ToolRow, syscall: string | null, card: ToolCardDescription): string {
  const kind = fileToolKind(row, syscall);
  const path = asString(asRecord(row.args)?.path);
  const subject = path ? basenamePath(path) : "file";
  const ok = row.kind === "toolResult" && row.ok !== false;
  const failed = row.kind === "toolResult" && row.ok === false;
  if (kind === "read") return failed ? `Could not read ${subject}` : row.kind === "toolCall" ? `Reading ${subject}` : `Read ${subject}`;
  if (kind === "write") return failed ? `Could not write ${subject}` : row.kind === "toolCall" ? `Writing ${subject}` : `Wrote ${subject}`;
  if (kind === "edit") return failed ? `Could not edit ${subject}` : row.kind === "toolCall" ? `Editing ${subject}` : `Edited ${subject}`;
  if (kind === "delete") return failed ? `Could not delete ${subject}` : row.kind === "toolCall" ? `Deleting ${subject}` : ok ? `Deleted ${subject}` : card.title;
  if (row.toolName === "Shell" || syscall === "shell.exec") return failed ? "Command failed" : row.kind === "toolCall" ? "Running command" : "Ran command";
  if (row.toolName === "Search" || syscall === "fs.search") return failed ? "Search failed" : row.kind === "toolCall" ? "Searching files" : "Searched files";
  if (isCodeModeTool(row.toolName, syscall)) return failed ? "CodeMode failed" : row.kind === "toolCall" ? "Running CodeMode script" : "Ran CodeMode script";
  return card.title;
}

function toolDisclosureContent(row: ToolRow, syscall: string | null): ComponentChildren | null {
  const kind = fileToolKind(row, syscall);
  const args = asRecord(row.args);
  if (kind === "write") {
    const content = asString(args?.content);
    if (content === null) return null;
    return content.length > 0
      ? <pre>{clipBlock(content, 12000)}</pre>
      : <p class="trajectory-muted">Empty file.</p>;
  }
  if (kind === "edit") {
    const oldString = asString(args?.oldString);
    const newString = asString(args?.newString);
    if (oldString === null && newString === null) return null;
    return <DiffPreview oldText={oldString ?? ""} newText={newString ?? ""} />;
  }
  if (kind === "read") {
    if (row.kind !== "toolResult" || row.ok === false) return null;
    return readToolDisclosure(row.output);
  }
  if (kind === "delete") {
    return null;
  }
  if (row.kind !== "toolResult" || row.output === undefined) {
    return null;
  }
  const normalized = normalizeToolOutput(row.output);
  return <pre>{clipBlock(formatToolOutputForDisclosure(row, syscall, normalized), 12000)}</pre>;
}

function toolDisclosureLabels(row: ToolRow, syscall: string | null): { expand: string; collapse: string } {
  const kind = fileToolKind(row, syscall);
  if (kind === "read" || kind === "write") {
    return { expand: "Expand content", collapse: "Collapse content" };
  }
  if (kind === "edit") {
    return { expand: "Expand diff", collapse: "Collapse diff" };
  }
  if (row.toolName === "Shell" || syscall === "shell.exec") {
    return { expand: "Expand command output", collapse: "Collapse command output" };
  }
  return { expand: "Expand output", collapse: "Collapse output" };
}

function readToolDisclosure(output: unknown): ComponentChildren | null {
  const normalized = normalizeToolOutput(output);
  const record = asRecord(normalized);
  const content = record?.content;
  if (typeof content === "string") {
    return content.length > 0
      ? <pre>{clipBlock(content, 12000)}</pre>
      : <p class="trajectory-muted">No content.</p>;
  }
  if (Array.isArray(content)) {
    return <pre>{clipBlock(prettyJson(content), 12000)}</pre>;
  }
  const directories = Array.isArray(record?.directories) ? record.directories : [];
  const files = Array.isArray(record?.files) ? record.files : [];
  if (directories.length || files.length) {
    const listing = [
      ...directories.map((item) => `${String(item)}/`),
      ...files.map((item) => String(item)),
    ].join("\n");
    return <pre>{clipBlock(listing, 12000)}</pre>;
  }
  return null;
}

function formatToolOutputForDisclosure(row: ToolRow, syscall: string | null, output: unknown): string {
  const record = asRecord(output);
  if (row.toolName === "Shell" || syscall === "shell.exec") {
    const stdout = asString(record?.stdout);
    const stderr = asString(record?.stderr);
    const parts = [stdout, stderr].filter((item): item is string => Boolean(item?.trim()));
    return parts.length > 0 ? parts.join("\n") : prettyJson(output);
  }
  return typeof output === "string" ? output : prettyJson(output);
}

function DiffPreview({ oldText, newText }: { oldText: string; newText: string }) {
  const removed = oldText.length > 0 ? oldText.split("\n") : [""];
  const added = newText.length > 0 ? newText.split("\n") : [""];
  const removedLines = removed.map((line, index) => (
    <span key={`old:${index}`} class="trajectory-diff-line is-removed">- {line}</span>
  ));
  const addedLines = added.map((line, index) => (
    <span key={`new:${index}`} class="trajectory-diff-line is-added">+ {line}</span>
  ));
  return <pre class="trajectory-diff">{removedLines}{addedLines}</pre>;
}

function fileToolKind(row: ToolRow, syscall: string | null): "read" | "write" | "edit" | "delete" | null {
  if (row.toolName === "Read" || syscall === "fs.read") return "read";
  if (row.toolName === "Write" || syscall === "fs.write") return "write";
  if (row.toolName === "Edit" || syscall === "fs.edit") return "edit";
  if (row.toolName === "Delete" || syscall === "fs.delete") return "delete";
  return null;
}

function clipBlock(value: unknown, maxLength: number): string {
  const text = String(value ?? "");
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}\n...`;
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

type TrajectoryTone = "reasoning" | "draft" | "running" | "ok" | "error" | "waiting";

function runDrawerSummary(
  group: TranscriptRunGroup,
  entries: RunDetailEntry[],
  now = Date.now(),
): Array<{ label: string; tone?: TrajectoryTone }> {
  const duration = formatRunDuration(group.startedAt, group.status === "completed" ? group.updatedAt : now);
  const tools = entries.filter((entry) => entry.kind === "tool").length;
  const approvals = entries.filter((entry) => entry.kind === "hil").length;
  const drafts = entries.filter((entry) => entry.kind === "interimText").length;
  const reasoning = entries.filter((entry) => entry.kind === "thinking").length;
  return [
    { label: runStatusLabel(group), tone: runStatusTone(group) },
    ...(duration ? [{ label: duration }] : []),
    ...(tools ? [{ label: `${tools} ${tools === 1 ? "tool" : "tools"}` }] : []),
    ...(approvals ? [{ label: `${approvals} approval${approvals === 1 ? "" : "s"}`, tone: "waiting" as const }] : []),
    ...(drafts ? [{ label: `${drafts} ${drafts === 1 ? "draft" : "drafts"}` }] : []),
    ...(reasoning ? [{ label: `${reasoning} reasoning` }] : []),
  ];
}

function runStatusLabel(group: TranscriptRunGroup): string {
  if (group.status === "waiting") return "Waiting";
  if (group.status === "running") return "Running";
  return "Completed";
}

function runStatusTone(group: TranscriptRunGroup): TrajectoryTone {
  if (group.status === "waiting") return "waiting";
  if (group.status === "running") return "running";
  return "ok";
}

function latestRunActivity(group: TranscriptRunGroup): string {
  const latest = [...group.detailEntries].reverse().find((entry) => entry.kind !== "hil");
  if (!latest) {
    return group.pendingAssistant === "tool" ? "Working" : "Thinking";
  }
  if (latest.kind === "thinking") return "Thinking";
  if (latest.kind === "interimText") return "Drafting a reply";
  if (latest.kind !== "tool") return "Thinking";
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

function toolResultSummary(row: ToolRow, syscall: string | null): { tone: TrajectoryTone; status: string; preview: string } {
  if (row.kind === "toolCall") {
    return {
      tone: "running",
      status: row.phase === "planning" ? "Preparing" : "Running",
      preview: planningToolStatus(row.toolName, syscall),
    };
  }

  const normalized = normalizeToolOutput(row.output);
  const record = asRecord(normalized);
  if (row.ok === false || record?.ok === false) {
    return {
      tone: "error",
      status: "Error",
      preview: row.error || asString(record?.error) || "Tool call failed.",
    };
  }

  return {
    tone: "ok",
    status: "Done",
    preview: completedToolPreview(row, syscall, normalized),
  };
}

function planningToolStatus(toolName: string, syscall: string | null): string {
  if (toolName === "Shell" || syscall === "shell.exec") return "Running command.";
  if (toolName === "Read" || syscall === "fs.read") return "Reading file.";
  if (toolName === "Search" || syscall === "fs.search") return "Searching files.";
  if (toolName === "Write" || syscall === "fs.write") return "Writing file.";
  if (toolName === "Edit" || syscall === "fs.edit") return "Editing file.";
  if (toolName === "Delete" || syscall === "fs.delete") return "Deleting file.";
  if (toolName === "CodeMode" || syscall === "codemode.exec" || syscall === "codemode.run") return "Running process-local script.";
  if (syscall === "sys.mcp.call") return "Calling MCP tool.";
  return `Using ${toolName}.`;
}

function completedToolPreview(row: ToolRow, syscall: string | null, output: unknown): string {
  const record = asRecord(output);
  if (isCodeModeTool(row.toolName, syscall)) {
    return describeCodeModeOutput(record, output);
  }
  if (row.toolName === "Shell" || syscall === "shell.exec") {
    const exitCode = asNumber(record?.exitCode);
    const stdout = asString(record?.stdout);
    const stderr = asString(record?.stderr);
    if (stdout?.trim()) return truncateInline(stdout, 180);
    if (stderr?.trim()) return truncateInline(stderr, 180);
    return exitCode !== null ? `Command exited ${exitCode}.` : "Command completed.";
  }
  if (row.toolName === "Read" || syscall === "fs.read") {
    const content = asString(record?.content);
    const directories = Array.isArray(record?.directories) ? record.directories : [];
    const files = Array.isArray(record?.files) ? record.files : [];
    if (content?.trim()) return "Read file content.";
    if (directories.length || files.length) {
      return `Listed ${directories.length} dirs and ${files.length} files.`;
    }
    return "Read completed.";
  }
  if (row.toolName === "Write" || syscall === "fs.write") {
    const size = asNumber(record?.size);
    return size !== null ? `Wrote ${size} ${size === 1 ? "byte" : "bytes"}.` : "Wrote file.";
  }
  if (row.toolName === "Edit" || syscall === "fs.edit") {
    const replacements = asNumber(record?.replacements);
    return replacements !== null ? `${replacements} ${replacements === 1 ? "replacement" : "replacements"}.` : "Edited file.";
  }
  if (row.toolName === "Delete" || syscall === "fs.delete") {
    return "Deleted file.";
  }
  if (row.toolName === "Search" || syscall === "fs.search") {
    const matches = Array.isArray(record?.matches) ? record.matches : [];
    const count = asNumber(record?.count) ?? matches.length;
    return `${count} ${count === 1 ? "match" : "matches"}.`;
  }
  if (typeof output === "string") {
    return output.trim() ? truncateInline(output, 180) : "Completed with empty output.";
  }
  return summarizeObject(output);
}

function describeCodeModeOutput(record: Record<string, unknown> | null, output: unknown): string {
  const status = asString(record?.status);
  const logs = Array.isArray(record?.logs) ? record.logs.length : 0;
  if (status === "failed") return asString(record?.error) || "CodeMode script failed.";
  if (status === "completed") {
    const result = record?.result;
    const summary = summarizeObject(result);
    return logs > 0 ? `${summary} ${logs} log ${logs === 1 ? "line" : "lines"}.` : summary;
  }
  return typeof output === "string" ? truncateInline(output, 180) : "CodeMode completed.";
}

function summarizeObject(value: unknown): string {
  if (value === null || value === undefined) return "Completed with no output.";
  if (typeof value === "string") return value.trim() ? truncateInline(value, 180) : "Completed with empty output.";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `Returned ${value.length} ${value.length === 1 ? "item" : "items"}.`;
  const record = asRecord(value);
  if (!record) return "Completed.";
  const summary = asString(record.summary) || asString(record.message) || asString(record.output);
  if (summary) return truncateInline(summary, 180);
  const keys = Object.keys(record);
  return keys.length > 0
    ? `Returned ${keys.length} ${keys.length === 1 ? "field" : "fields"}: ${keys.slice(0, 4).join(", ")}${keys.length > 4 ? ", ..." : ""}.`
    : "Returned an empty object.";
}

function toolEntryIcon(row: ToolRow, syscall: string | null): ComponentChildren {
  if (row.kind === "toolResult" && row.ok === false) return <XIcon />;
  if (row.kind === "toolResult") return <CheckIcon />;
  if (row.toolName === "Shell" || syscall === "shell.exec" || isCodeModeTool(row.toolName, syscall)) return <TerminalIcon />;
  if (syscall?.startsWith("fs.")) return <FileIcon />;
  return <ThoughtIcon />;
}

function isCodeModeTool(toolName: string, syscall: string | null): boolean {
  return toolName === "CodeMode" || syscall === "codemode.exec" || syscall === "codemode.run";
}

function formatRunDuration(start: number, end: number): string {
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds <= 0) return "";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder > 0 ? `${minutes}m ${remainder}s` : `${minutes}m`;
}
