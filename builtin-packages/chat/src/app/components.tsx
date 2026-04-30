import { useEffect, useRef } from "preact/hooks";
import type {
  ArchiveState,
  Attachment,
  ContextState,
  ConversationRecord,
  HilRequest,
  LogRow,
  MessageRow,
  PendingAssistantState,
  Profile,
  ThreadContext,
  ToolRow,
  WorkspaceEntry,
} from "./types";
import {
  ArchiveIcon,
  BranchIcon,
  CheckIcon,
  CopyIcon,
  GaugeIcon,
  HomeIcon,
  MessageIcon,
  MoreIcon,
  PaperclipIcon,
  PlusIcon,
  RefreshIcon,
  SendIcon,
  StopIcon,
  XIcon,
} from "./icons";
import {
  asNumber,
  asRecord,
  asString,
  basenamePath,
  closeChatMenus,
  closeContainingChatMenu,
  copyTextToClipboard,
  describeAttachment,
  describeHilSummary,
  describeToolCard,
  displayThreadLabel,
  formatContextPressure,
  formatRelativeTime,
  formatTimestamp,
  flattenHistory,
  inferToolSyscall,
  labelForRole,
  normalizeToolOutput,
  prettyJson,
  renderMarkdownHtml,
  shortId,
  truncateBlock,
} from "./view-helpers";

export function ChatNavigator(props: {
  active: ThreadContext | null;
  threads: WorkspaceEntry[];
  threadsLoading: boolean;
  threadsError: string;
  profiles: Profile[];
  draftProfileId: string;
  onDraftProfileChange(profileId: string): void;
  onHome(): void;
  onNew(): void;
  onRefreshThreads(): void;
  onOpenThread(workspaceId: string): void;
}) {
  return (
    <aside class="chat-nav">
      <ThreadsPane
        active={props.active}
        threads={props.threads}
        loading={props.threadsLoading}
        error={props.threadsError}
        profiles={props.profiles}
        draftProfileId={props.draftProfileId}
        onDraftProfileChange={props.onDraftProfileChange}
        onHome={props.onHome}
        onNew={props.onNew}
        onRefresh={props.onRefreshThreads}
        onOpenThread={props.onOpenThread}
      />
    </aside>
  );
}

function ThreadsPane(props: {
  active: ThreadContext | null;
  threads: WorkspaceEntry[];
  loading: boolean;
  error: string;
  profiles: Profile[];
  draftProfileId: string;
  onDraftProfileChange(profileId: string): void;
  onHome(): void;
  onNew(): void;
  onRefresh(): void;
  onOpenThread(workspaceId: string): void;
}) {
  const activeWorkspaceId = props.active?.workspaceId ?? null;
  const activePid = props.active?.pid ?? "";
  const status = props.loading
    ? "Refreshing..."
    : props.error || (props.threads.length === 0 ? "No task processes yet." : "Task processes");

  return (
    <section class="nav-pane">
      <header class="nav-pane-header">
        <div>
          <h1>Processes</h1>
          <p>{status}</p>
        </div>
        <div class="nav-pane-actions">
          <button class="icon-button small" type="button" title="New process" aria-label="New process" onClick={props.onNew}>
            <PlusIcon />
          </button>
          <button class="icon-button small" type="button" title="Refresh processes" aria-label="Refresh processes" onClick={props.onRefresh}>
            <RefreshIcon />
          </button>
        </div>
      </header>

      <div class="new-thread-strip">
        <label>
          <span>Profile</span>
          <select value={props.draftProfileId} onChange={(event) => props.onDraftProfileChange((event.currentTarget as HTMLSelectElement).value)}>
            {props.profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>{profile.displayName}</option>
            ))}
          </select>
        </label>
      </div>

      <nav class="thread-list" aria-label="Chat processes">
        <button type="button" class={"thread-row" + (activePid.startsWith("init:") ? " is-active" : "")} onClick={props.onHome}>
          <span class="row-icon"><HomeIcon /></span>
          <span class="thread-row-title">Home</span>
          <span class="thread-row-meta">Persistent init conversation</span>
        </button>
        {props.threads.map((thread) => (
          <button
            key={thread.workspaceId}
            type="button"
            class={"thread-row" + (activeWorkspaceId === thread.workspaceId ? " is-active" : "")}
            onClick={() => props.onOpenThread(thread.workspaceId)}
          >
            <span class="row-icon"><MessageIcon /></span>
            <span class="thread-row-title">{displayThreadLabel(thread)}</span>
            <span class="thread-row-meta">
              {thread.activeProcess ? "Live process" : "Stored thread"}
              {thread.processCount && thread.processCount > 1 ? ` - ${thread.processCount} agents` : ""}
              {" - "}
              {formatRelativeTime(thread.updatedAt)}
            </span>
          </button>
        ))}
      </nav>
    </section>
  );
}

export function ConversationBar(props: {
  active: ThreadContext | null;
  activeConversationId: string;
  conversations: ConversationRecord[];
  loading: boolean;
  error: string;
  archiveCount: number;
  archiveActive: boolean;
  onSelect(conversation: ConversationRecord): void;
  onRefresh(): void;
  onArchiveToggle(): void;
}) {
  if (!props.active) {
    return null;
  }
  const activeConversation = props.conversations.find((conversation) => conversation.id === props.activeConversationId) ?? null;
  const activeDisplay: ConversationRecord = activeConversation ?? {
    id: props.activeConversationId,
    generation: 0,
    status: "open",
    title: props.active.conversationTitle || (props.activeConversationId === "default" ? "Default" : null),
    messageCount: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const visible: ConversationRecord[] = [];
  const seen = new Set<string>();
  function pushVisible(conversation: ConversationRecord | null | undefined): void {
    if (!conversation || seen.has(conversation.id) || visible.length >= 4) {
      return;
    }
    visible.push(conversation);
    seen.add(conversation.id);
  }
  pushVisible(props.conversations.find((conversation) => conversation.id === "default"));
  pushVisible(activeDisplay);
  for (const conversation of props.conversations) {
    pushVisible(conversation);
  }
  const overflow = props.conversations.filter((conversation) => !seen.has(conversation.id));
  const selectOverflow = (event: Event) => {
    const select = event.currentTarget as HTMLSelectElement;
    const conversation = props.conversations.find((candidate) => candidate.id === select.value);
    select.value = "";
    if (conversation) {
      props.onSelect(conversation);
    }
  };

  return (
    <div class="conversation-bar">
      <div class="conversation-bar-list" aria-label="Conversations">
        {visible.map((conversation) => (
          <span
            key={conversation.id}
            class={"conversation-chip-group" + (conversation.id === props.activeConversationId ? " is-active" : "")}
          >
            <button
              type="button"
              class={"conversation-chip" + (conversation.id === props.activeConversationId ? " is-active" : "")}
              title={conversation.title || conversation.id}
              onClick={() => props.onSelect(conversation)}
            >
              <BranchIcon />
              <span>{conversation.title || (conversation.id === "default" ? "Default" : shortId(conversation.id))}</span>
              {conversation.messageCount > 0 ? <small>{conversation.messageCount}</small> : null}
            </button>
            {conversation.id === props.activeConversationId ? (
              <button
                class={"archive-toggle" + (props.archiveActive ? " is-active" : "")}
                type="button"
                title={props.archiveActive ? "Return to live conversation" : "Open conversation archive"}
                aria-label={props.archiveActive ? "Return to live conversation" : "Open conversation archive"}
                onClick={props.onArchiveToggle}
              >
                <ArchiveIcon />
                {props.archiveCount > 0 ? <span>{props.archiveCount}</span> : null}
              </button>
            ) : null}
          </span>
        ))}
        {overflow.length > 0 ? (
          <label class="conversation-overflow" title="More branches">
            <BranchIcon />
            <select value="" aria-label="More branches" onChange={selectOverflow}>
              <option value="">+{overflow.length}</option>
              {overflow.map((conversation) => (
                <option key={conversation.id} value={conversation.id}>
                  {conversation.title || (conversation.id === "default" ? "Default" : shortId(conversation.id))}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {props.conversations.length === 0 && visible.length === 0 ? (
          <span class="conversation-bar-empty">{props.loading ? "Loading branches..." : props.error || "No branches"}</span>
        ) : null}
      </div>
      <div class="conversation-bar-actions">
        <button class="icon-button small" type="button" title="Refresh branches" aria-label="Refresh branches" onClick={props.onRefresh}>
          <RefreshIcon />
        </button>
      </div>
    </div>
  );
}

export function ArchiveWorkspace(props: {
  archive: ArchiveState;
  onRefresh(): void;
  onSelect(segmentId: string): void;
}) {
  const { archive } = props;
  const selected = archive.segments.find((segment) => segment.id === archive.selectedSegmentId) ?? null;
  const archiveRows = selected ? flattenHistory(archive.messages) : [];
  return (
    <section class="archive-workspace">
      <header class="archive-workspace-head">
        <div>
          <span class="archive-eyebrow"><ArchiveIcon /> Conversation archive</span>
          <h2>{selected ? `Messages ${selected.fromMessageId}-${selected.toMessageId}` : "Archived segments"}</h2>
          <p>{selected ? `${shortId(selected.id)} - ${formatTimestamp(selected.createdAt)}` : archive.loading ? "Loading..." : archive.error || "Read-only compacted history"}</p>
        </div>
        <button class="icon-button small" type="button" title="Refresh archive" aria-label="Refresh archive" onClick={props.onRefresh}>
          <RefreshIcon />
        </button>
      </header>
      <div class="archive-workspace-layout">
        <div class="archive-segments" aria-label="Archive segments">
          {archive.segments.length === 0 ? (
            <div class="panel-empty">{archive.loading ? "Loading archive..." : archive.error || "No compacted segments."}</div>
          ) : archive.segments.map((segment) => (
            <button
              key={segment.id}
              type="button"
              class={"archive-row" + (segment.id === archive.selectedSegmentId ? " is-active" : "")}
              onClick={() => props.onSelect(segment.id)}
            >
              <span class="row-icon"><ArchiveIcon /></span>
              <span>{segment.fromMessageId}-{segment.toMessageId}</span>
              <span>{formatRelativeTime(segment.createdAt)}</span>
            </button>
          ))}
        </div>
        <div class="archive-message-list">
          {selected ? (
            <>
              <div class="archive-count">{archive.messages.length}/{archive.messageCount}{archive.truncated ? " shown" : ""}</div>
              {archiveRows.map((row, index) => (
                <ArchiveRow key={`${row.kind}:${row.kind === "message" ? row.messageId ?? index : row.callId}:${index}`} row={row} />
              ))}
            </>
          ) : (
            <div class="archive-empty">
              <ArchiveIcon />
              <h2>No archived segment selected</h2>
              <p>Select a segment to read compacted history for this conversation.</p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

export function Transcript(props: {
  rows: LogRow[];
  pendingAssistant: PendingAssistantState;
  pendingHil: HilRequest | null;
  hilBusy: boolean;
  branchBusy: boolean;
  refNode: { current: HTMLDivElement | null };
  onCopy(text: string): void;
  onBranch(messageId: number): void;
  onHilDecision(requestId: string, decision: "approve" | "deny"): void;
}) {
  const hilRendered = props.pendingHil
    ? props.rows.some((row) => row.kind === "toolCall" && row.callId === props.pendingHil?.callId)
    : true;
  return (
    <div class="transcript" ref={(node) => { props.refNode.current = node; }}>
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
          return <ToolCard key={`${row.callId}:${index}`} row={row} />;
        }
        const messageRow = row as MessageRow;
        return <MessageBubble key={`${messageRow.messageId ?? index}:${messageRow.timestamp}`} row={messageRow} branchBusy={props.branchBusy} onCopy={props.onCopy} onBranch={props.onBranch} />;
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
  );
}

function MessageBubble({ row, branchBusy, branchable = true, onCopy, onBranch }: { row: MessageRow; branchBusy: boolean; branchable?: boolean; onCopy(text: string): void; onBranch(messageId: number): void }) {
  const thinking = row.thinking?.filter(Boolean) ?? [];
  return (
    <article class={`message message-${row.role}`}>
      <div class="message-head">
        <span>{labelForRole(row.role)}</span>
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
            {branchable && row.messageId ? (
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
      {thinking.length > 0 ? (
        <details class="message-thinking">
          <summary>Reasoning</summary>
          <div>{thinking.join("\n\n")}</div>
        </details>
      ) : null}
      {row.role === "assistant" ? (
        <div class="message-body message-markdown" dangerouslySetInnerHTML={{ __html: renderMarkdownHtml(row.text) }} />
      ) : (
        <pre class="message-body">{row.text}</pre>
      )}
      {row.media && row.media.length > 0 ? (
        <div class="message-media">
          {row.media.map((item, index) => <span key={index}>{describeAttachment(item)}</span>)}
        </div>
      ) : null}
    </article>
  );
}

function ToolCard({ row }: { row: ToolRow }) {
  const syscall = inferToolSyscall(row.toolName, row.syscall);
  const card = describeToolCard(row.toolName, row.args, syscall);
  const ok = row.kind === "toolCall" ? false : row.ok !== false;
  const statusClass = row.kind === "toolCall" ? "is-pending" : ok ? "is-ok" : "is-error";
  return (
    <article class={`tool-card ${statusClass}`}>
      <div class="tool-card-head">
        <div>
          <h3>{card.title}</h3>
          {card.subtitle ? <p>{card.subtitle}</p> : null}
        </div>
        <span class={`tool-status ${statusClass}`}>
          {row.kind === "toolCall" ? "Running" : ok ? "Done" : "Error"}
          <span>{card.target}</span>
        </span>
      </div>
      <div class="tool-preview">
        {row.kind === "toolCall"
          ? <p>Waiting for result.</p>
          : <ToolPreview row={row} syscall={syscall} />}
      </div>
      <details class="tool-details">
        <summary>{row.kind === "toolCall" ? "Input" : "Details"}</summary>
        <ToolDetails row={row} syscall={syscall} />
      </details>
    </article>
  );
}

function ToolPreview({ row, syscall }: { row: ToolRow; syscall: string | null }) {
  const normalized = normalizeToolOutput(row.output);
  const record = asRecord(normalized);
  if (row.ok === false || record?.ok === false) {
    return <p class="tool-error">{row.error || asString(record?.error) || "Tool call failed."}</p>;
  }
  if (isCodeModeTool(row.toolName, syscall)) {
    return <CodeModePreview row={row} output={normalized} />;
  }
  if (row.toolName === "Shell" || syscall === "shell.exec") {
    const stdout = asString(record?.stdout);
    const stderr = asString(record?.stderr);
    if (stdout?.trim()) return <pre>{truncateBlock(stdout, 800)}</pre>;
    if (stderr?.trim()) return <pre>{truncateBlock(stderr, 800)}</pre>;
    return <p>Command completed.</p>;
  }
  if (row.toolName === "Read" || syscall === "fs.read") {
    if (typeof record?.content === "string") return <pre>{truncateBlock(record.content, 800)}</pre>;
    const directories = Array.isArray(record?.directories) ? record.directories : [];
    const files = Array.isArray(record?.files) ? record.files : [];
    if (directories.length || files.length) {
      return <p>Listed {directories.length} dirs and {files.length} files.</p>;
    }
    return <p>Read completed.</p>;
  }
  if (row.toolName === "Search" || syscall === "fs.search") {
    const matches = Array.isArray(record?.matches) ? record.matches : [];
    const count = asNumber(record?.count) ?? matches.length;
    return <p>{count} matches.</p>;
  }
  if (typeof normalized === "string") {
    return <pre>{truncateBlock(normalized, 800)}</pre>;
  }
  return <pre>{truncateBlock(prettyJson(normalized), 800)}</pre>;
}

function ToolDetails({ row, syscall }: { row: ToolRow; syscall: string | null }) {
  const normalized = normalizeToolOutput(row.output);
  if (isCodeModeTool(row.toolName, syscall)) {
    return <CodeModeDetails row={row} syscall={syscall} output={normalized} />;
  }
  return (
    <div class="tool-detail-stack">
      <MetaGrid rows={[["call", row.callId], ["syscall", syscall || ""]]} />
      <pre>{truncateBlock(prettyJson(row.args), 2400)}</pre>
      {row.kind === "toolResult" && normalized !== undefined ? (
        <pre>{truncateBlock(typeof normalized === "string" ? normalized : prettyJson(normalized), 4000)}</pre>
      ) : null}
    </div>
  );
}

function isCodeModeTool(toolName: string, syscall: string | null): boolean {
  return toolName === "CodeMode" || syscall === "codemode.exec" || syscall === "codemode.run";
}

function CodeModePreview({ row, output }: { row: ToolRow; output: unknown }) {
  if (row.kind === "toolCall") {
    return <p>Executing process-local script.</p>;
  }
  const record = asRecord(output);
  const status = asString(record?.status);
  const logs = normalizeCodeModeLogs(record?.logs);
  if (status === "failed") {
    return (
      <div class="codemode-preview">
        <p class="tool-error">{asString(record?.error) || row.error || "CodeMode script failed."}</p>
        {logs.length > 0 ? <p>{logs.length} log {logs.length === 1 ? "line" : "lines"} captured.</p> : null}
      </div>
    );
  }
  if (status === "completed") {
    const result = record?.result;
    return (
      <div class="codemode-preview">
        <p>{describeCodeModeResult(result)}</p>
        {logs.length > 0 ? <p>{logs.length} log {logs.length === 1 ? "line" : "lines"} captured.</p> : null}
        {renderCodeModePreviewValue(result)}
      </div>
    );
  }
  return <p>CodeMode completed.</p>;
}

function CodeModeDetails({ row, syscall, output }: { row: ToolRow; syscall: string | null; output: unknown }) {
  const args = asRecord(row.args);
  const code = asString(args?.code);
  const record = asRecord(output);
  const status = asString(record?.status);
  const logs = normalizeCodeModeLogs(record?.logs);
  return (
    <div class="tool-detail-stack codemode-details">
      <MetaGrid rows={[["call", row.callId], ["syscall", syscall || ""], ["status", status || (row.kind === "toolCall" ? "running" : "")]]} />
      {code ? (
        <section>
          <h4>Script</h4>
          <pre>{truncateBlock(code, 4000)}</pre>
        </section>
      ) : null}
      {logs.length > 0 ? (
        <section>
          <h4>Logs</h4>
          <pre>{truncateBlock(logs.join("\n"), 4000)}</pre>
        </section>
      ) : null}
      {status === "failed" ? (
        <section>
          <h4>Error</h4>
          <pre>{truncateBlock(asString(record?.error) || row.error || "CodeMode script failed.", 2000)}</pre>
        </section>
      ) : null}
      {status === "completed" ? (
        <section>
          <h4>Result</h4>
          {renderCodeModeDetailsValue(record?.result)}
        </section>
      ) : null}
    </div>
  );
}

function normalizeCodeModeLogs(value: unknown): string[] {
  return (Array.isArray(value) ? value : [])
    .map((item) => typeof item === "string" ? item : prettyJson(item))
    .filter((item) => item.trim().length > 0);
}

function describeCodeModeResult(value: unknown): string {
  if (value === null || value === undefined) return "Completed with no return value.";
  if (typeof value === "string") return value.trim() ? "Returned text." : "Returned empty text.";
  if (typeof value === "number" || typeof value === "boolean") return `Returned ${String(value)}.`;
  if (Array.isArray(value)) return `Returned ${value.length} ${value.length === 1 ? "item" : "items"}.`;
  const record = asRecord(value);
  if (record) {
    const summary = asString(record.summary) || asString(record.message) || asString(record.output);
    if (summary) return truncateBlock(summary, 180);
    const keys = Object.keys(record);
    return keys.length > 0 ? `Returned object with ${keys.length} ${keys.length === 1 ? "field" : "fields"}: ${keys.slice(0, 4).join(", ")}${keys.length > 4 ? ", ..." : ""}.` : "Returned an empty object.";
  }
  return "Completed.";
}

function renderCodeModePreviewValue(value: unknown) {
  if (typeof value === "string" && value.trim()) {
    return <pre>{truncateBlock(value, 800)}</pre>;
  }
  const record = asRecord(value);
  const stdout = asString(record?.stdout);
  const stderr = asString(record?.stderr);
  if (stdout?.trim()) return <pre>{truncateBlock(stdout, 800)}</pre>;
  if (stderr?.trim()) return <pre>{truncateBlock(stderr, 800)}</pre>;
  return null;
}

function renderCodeModeDetailsValue(value: unknown) {
  if (value === null || value === undefined) return <p>No return value.</p>;
  if (typeof value === "string") return value.trim() ? <pre>{truncateBlock(value, 4000)}</pre> : <p>Empty text.</p>;
  if (typeof value === "number" || typeof value === "boolean") return <p>{String(value)}</p>;
  if (Array.isArray(value)) {
    return value.length === 0 ? <p>Empty array.</p> : <pre>{truncateBlock(prettyJson(value), 4000)}</pre>;
  }
  return <pre>{truncateBlock(prettyJson(value), 4000)}</pre>;
}

function MetaGrid({ rows }: { rows: Array<[string, string | number | null | undefined]> }) {
  return (
    <div class="meta-grid">
      {rows.filter((row) => row[1] !== null && row[1] !== undefined && String(row[1]).length > 0).map(([label, value]) => (
        <div key={label}>
          <span>{label}</span>
          <span>{String(value)}</span>
        </div>
      ))}
    </div>
  );
}

function HilCard(props: { request: HilRequest; busy: boolean; onDecision(requestId: string, decision: "approve" | "deny"): void }) {
  const card = describeToolCard(props.request.toolName, props.request.args, props.request.syscall);
  return (
    <article class="tool-card is-pending">
      <div class="tool-card-head">
        <div>
          <h3>{card.title}</h3>
          {card.subtitle ? <p>{card.subtitle}</p> : null}
        </div>
        <span class="tool-status is-pending">Awaiting approval<span>{card.target}</span></span>
      </div>
      <div class="tool-preview">
        <p>{describeHilSummary(props.request, props.request.syscall)}</p>
        <p>This tool will not run until you decide.</p>
      </div>
      <div class="approval-actions">
        <button class="icon-button approve" type="button" title="Allow tool call" aria-label="Allow tool call" disabled={props.busy} onClick={() => props.onDecision(props.request.requestId, "approve")}>
          <CheckIcon />
        </button>
        <button class="icon-button deny" type="button" title="Deny tool call" aria-label="Deny tool call" disabled={props.busy} onClick={() => props.onDecision(props.request.requestId, "deny")}>
          <XIcon />
        </button>
      </div>
      <details class="tool-details">
        <summary>Details</summary>
        <ToolDetails row={{ kind: "toolCall", toolName: props.request.toolName, callId: props.request.callId, args: props.request.args, syscall: props.request.syscall, timestamp: props.request.createdAt }} syscall={props.request.syscall} />
      </details>
    </article>
  );
}

export function Composer(props: {
  value: string;
  attachments: Attachment[];
  disabled: boolean;
  canSend: boolean;
  canStop: boolean;
  stopBusy: boolean;
  onValueChange(value: string): void;
  onSubmit(): void;
  onStop(): void;
  onFiles(files: FileList | null): void;
  onRemoveAttachment(index: number): void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const actionLabel = props.canStop ? (props.stopBusy ? "Stopping..." : "Stop") : "Send";
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }
    const maxHeight = 176;
    textarea.style.height = "auto";
    const nextHeight = Math.min(maxHeight, Math.max(42, textarea.scrollHeight));
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
  }, [props.value]);
  return (
    <form class="composer" onSubmit={(event) => { event.preventDefault(); props.onSubmit(); }}>
      {props.attachments.length > 0 ? (
        <div class="attachment-list">
          {props.attachments.map((attachment, index) => (
            <span class="attachment-chip" key={`${attachment.filename ?? "file"}:${index}`}>
              <span>{attachment.filename || "attachment"}</span>
              <button type="button" aria-label="Remove attachment" onClick={() => props.onRemoveAttachment(index)}>x</button>
            </span>
          ))}
        </div>
      ) : null}
      <div class="composer-shell">
        <label class="icon-button attach" title="Attach files" aria-label="Attach files">
          <PaperclipIcon />
          <input type="file" multiple disabled={props.disabled} onChange={(event) => {
            const input = event.currentTarget as HTMLInputElement;
            props.onFiles(input.files);
            input.value = "";
          }} />
        </label>
        <textarea
          ref={textareaRef}
          rows={1}
          value={props.value}
          disabled={props.disabled}
          placeholder="Ask, continue the thread, or describe work for this process."
          onInput={(event) => props.onValueChange((event.currentTarget as HTMLTextAreaElement).value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              props.onSubmit();
            }
          }}
        />
        <button
          class={props.canStop ? "composer-action icon-button danger" : "composer-action icon-button"}
          type={props.canStop ? "button" : "submit"}
          title={actionLabel}
          aria-label={actionLabel}
          disabled={props.canStop ? props.stopBusy : !props.canSend}
          onClick={props.canStop ? props.onStop : undefined}
        >
          {props.canStop ? <StopIcon /> : <SendIcon />}
        </button>
      </div>
    </form>
  );
}

export function ContextMeter({ state }: { state: ContextState | null }) {
  if (!state) {
    return null;
  }
  const pressure = state.pressure === null ? 0 : Math.max(0, Math.min(1, state.pressure));
  const text = formatContextPressure(state);
  return (
    <div class={`context-meter is-${state.level}`} title={`${text} - ${state.source === "provider" ? "provider usage" : "estimated"}`}>
      <GaugeIcon />
      <span class="context-track"><span style={{ width: `${Math.round(pressure * 100)}%` }} /></span>
      <span>{text}</span>
    </div>
  );
}

export function CompactDialog(props: {
  value: string;
  messageCount: number;
  compactBusy: boolean;
  onChange(value: string): void;
  onCancel(): void;
  onConfirm(): void;
}) {
  return (
    <div class="modal-backdrop" role="presentation">
      <section class="modal" role="dialog" aria-modal="true" aria-labelledby="compact-title">
        <header>
          <h2 id="compact-title">Compact Conversation</h2>
          <p>Archive older messages and keep the newest messages live in context.</p>
        </header>
        <label class="field-row">
          <span>Newest messages to keep</span>
          <input type="number" min="0" value={props.value} disabled={props.compactBusy} onInput={(event) => props.onChange((event.currentTarget as HTMLInputElement).value)} />
        </label>
        <p class="modal-note">Current live message count: {props.messageCount}</p>
        <footer>
          <button type="button" class="secondary-button" disabled={props.compactBusy} onClick={props.onCancel}>Cancel</button>
          <button type="button" class="primary-button" disabled={props.compactBusy} onClick={props.onConfirm}>
            {props.compactBusy ? "Compacting..." : "Compact"}
          </button>
        </footer>
      </section>
    </div>
  );
}

function ArchiveRow({ row }: { row: LogRow }) {
  if (row.kind === "toolCall" || row.kind === "toolResult") {
    return <ToolCard row={row} />;
  }
  return <MessageBubble row={row as MessageRow} branchBusy={false} branchable={false} onCopy={(text) => { void copyTextToClipboard(text).catch(() => {}); }} onBranch={() => {}} />;
}
