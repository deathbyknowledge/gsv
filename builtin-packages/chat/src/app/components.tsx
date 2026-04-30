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
  SideView,
  ThreadContext,
  ToolRow,
  WorkspaceEntry,
} from "./types";
import {
  ArchiveIcon,
  BranchIcon,
  CheckIcon,
  GaugeIcon,
  HomeIcon,
  MessageIcon,
  PaperclipIcon,
  PlusIcon,
  RefreshIcon,
  ThreadsIcon,
  XIcon,
} from "./icons";
import {
  asNumber,
  asRecord,
  asString,
  basenamePath,
  describeAttachment,
  describeHilSummary,
  describeToolCard,
  displayThreadLabel,
  formatContextPressure,
  formatMessageContent,
  formatRelativeTime,
  formatTimestamp,
  inferToolSyscall,
  labelForRole,
  normalizeTimestampMs,
  normalizeToolOutput,
  prettyJson,
  renderMarkdownHtml,
  shortId,
  truncateBlock,
} from "./view-helpers";

export function ChatNavigator(props: {
  mode: SideView;
  active: ThreadContext | null;
  threads: WorkspaceEntry[];
  threadsLoading: boolean;
  threadsError: string;
  profiles: Profile[];
  draftProfileId: string;
  conversations: ConversationRecord[];
  conversationsLoading: boolean;
  conversationError: string;
  activeConversationId: string;
  archive: ArchiveState;
  onModeChange(mode: SideView): void;
  onDraftProfileChange(profileId: string): void;
  onHome(): void;
  onNew(): void;
  onRefreshThreads(): void;
  onOpenThread(workspaceId: string): void;
  onConversationSelect(conversation: ConversationRecord): void;
  onRefreshConversations(): void;
  onArchiveRefresh(): void;
  onArchiveSegmentSelect(segmentId: string): void;
}) {
  const counts = {
    threads: props.threads.length + 1,
    conversations: props.conversations.length,
    archive: props.archive.segments.length,
  };

  return (
    <aside class="chat-nav">
      <div class="nav-mode-strip" aria-label="Chat sections">
        <button type="button" class={modeButtonClass(props.mode, "threads")} title="Threads" aria-label="Threads" onClick={() => props.onModeChange("threads")}>
          <ThreadsIcon />
          <span>{counts.threads}</span>
        </button>
        <button type="button" class={modeButtonClass(props.mode, "conversations")} title="Branches" aria-label="Branches" disabled={!props.active} onClick={() => props.onModeChange("conversations")}>
          <BranchIcon />
          <span>{counts.conversations}</span>
        </button>
        <button type="button" class={modeButtonClass(props.mode, "archive")} title="Archive" aria-label="Archive" disabled={!props.active} onClick={() => props.onModeChange("archive")}>
          <ArchiveIcon />
          <span>{counts.archive}</span>
        </button>
      </div>
      <div class="nav-content">
        {props.mode === "threads" ? (
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
        ) : props.mode === "conversations" ? (
          <BranchesPane
            active={props.active}
            activeConversationId={props.activeConversationId}
            conversations={props.conversations}
            loading={props.conversationsLoading}
            error={props.conversationError}
            onSelect={props.onConversationSelect}
            onRefresh={props.onRefreshConversations}
          />
        ) : (
          <ArchiveNavPane
            active={props.active}
            archive={props.archive}
            onRefresh={props.onArchiveRefresh}
            onSelect={props.onArchiveSegmentSelect}
          />
        )}
      </div>
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
    : props.error || (props.threads.length === 0 ? "No task threads yet." : "Task workspaces");

  return (
    <section class="nav-pane">
      <header class="nav-pane-header">
        <div>
          <h1>Threads</h1>
          <p>{status}</p>
        </div>
        <div class="nav-pane-actions">
          <button class="icon-button small" type="button" title="New thread" aria-label="New thread" onClick={props.onNew}>
            <PlusIcon />
          </button>
          <button class="icon-button small" type="button" title="Refresh threads" aria-label="Refresh threads" onClick={props.onRefresh}>
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

      <nav class="thread-list" aria-label="Chat threads">
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
              {thread.activeProcess ? "Live" : "Stored"}
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

function BranchesPane(props: {
  active: ThreadContext | null;
  activeConversationId: string;
  conversations: ConversationRecord[];
  loading: boolean;
  error: string;
  onSelect(conversation: ConversationRecord): void;
  onRefresh(): void;
}) {
  if (!props.active) {
    return <div class="panel-empty">Open a process to see its conversations and branches.</div>;
  }
  return (
    <section class="nav-pane">
      <header class="nav-pane-header">
        <div>
          <h1>Branches</h1>
          <p>{props.loading ? "Loading..." : props.error || `${props.conversations.length} conversations`}</p>
        </div>
        <button class="icon-button small" type="button" title="Refresh conversations" aria-label="Refresh conversations" onClick={props.onRefresh}>
          <RefreshIcon />
        </button>
      </header>
      <div class="conversation-list">
        {props.conversations.map((conversation) => (
          <button
            key={conversation.id}
            type="button"
            class={"conversation-row" + (conversation.id === props.activeConversationId ? " is-active" : "")}
            onClick={() => props.onSelect(conversation)}
          >
            <span class="row-icon"><BranchIcon /></span>
            <span class="conversation-title">{conversation.title || (conversation.id === "default" ? "Default" : conversation.id)}</span>
            <span class="conversation-meta">
              {conversation.id === "default" ? "main" : shortId(conversation.id)}
              {" - "}
              {conversation.messageCount} messages
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}

function ArchiveNavPane(props: {
  active: ThreadContext | null;
  archive: ArchiveState;
  onRefresh(): void;
  onSelect(segmentId: string): void;
}) {
  if (!props.active) {
    return <div class="panel-empty">Open a process to inspect archived segments.</div>;
  }
  return (
    <section class="nav-pane">
      <header class="nav-pane-header">
        <div>
          <h1>Archive</h1>
          <p>{props.archive.loading ? "Loading..." : props.archive.error || `${props.archive.segments.length} segments`}</p>
        </div>
        <button class="icon-button small" type="button" title="Refresh archive" aria-label="Refresh archive" onClick={props.onRefresh}>
          <RefreshIcon />
        </button>
      </header>
      {props.archive.segments.length === 0 ? (
        <div class="panel-empty">No compacted segments.</div>
      ) : (
        <div class="archive-segments">
          {props.archive.segments.map((segment) => (
            <button
              key={segment.id}
              type="button"
              class={"archive-row" + (segment.id === props.archive.selectedSegmentId ? " is-active" : "")}
              onClick={() => props.onSelect(segment.id)}
            >
              <span class="row-icon"><ArchiveIcon /></span>
              <span>{segment.fromMessageId}-{segment.toMessageId}</span>
              <span>{formatRelativeTime(segment.createdAt)}</span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

export function ArchiveWorkspace({ archive }: { archive: ArchiveState }) {
  const selected = archive.segments.find((segment) => segment.id === archive.selectedSegmentId) ?? null;
  if (!selected) {
    return (
      <section class="archive-workspace">
        <div class="archive-empty">
          <ArchiveIcon />
          <h2>No archived segment selected</h2>
          <p>Select a segment from the Archive navigator to read compacted history.</p>
        </div>
      </section>
    );
  }
  return (
    <section class="archive-workspace">
      <header class="archive-workspace-head">
        <div>
          <span class="archive-eyebrow"><ArchiveIcon /> Read-only segment</span>
          <h2>Messages {selected.fromMessageId}-{selected.toMessageId}</h2>
          <p>{shortId(selected.id)} - {formatTimestamp(selected.createdAt)}</p>
        </div>
        <span class="archive-count">{archive.messages.length}/{archive.messageCount}{archive.truncated ? " shown" : ""}</span>
      </header>
      <div class="archive-message-list">
        {archive.messages.map((message, index) => (
          <ArchiveMessage key={index} entry={message} />
        ))}
      </div>
    </section>
  );
}

function modeButtonClass(active: SideView, mode: SideView): string {
  return "nav-mode-button" + (active === mode ? " is-active" : "");
}

export function Transcript(props: {
  rows: LogRow[];
  pendingAssistant: PendingAssistantState;
  pendingHil: HilRequest | null;
  hilBusy: boolean;
  branchBusy: boolean;
  refNode: { current: HTMLDivElement | null };
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
        return <MessageBubble key={`${messageRow.messageId ?? index}:${messageRow.timestamp}`} row={messageRow} branchBusy={props.branchBusy} onBranch={props.onBranch} />;
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

function MessageBubble({ row, branchBusy, onBranch }: { row: MessageRow; branchBusy: boolean; onBranch(messageId: number): void }) {
  const thinking = row.thinking?.filter(Boolean) ?? [];
  return (
    <article class={`message message-${row.role}`}>
      <div class="message-head">
        <span>{labelForRole(row.role)}</span>
        <span class="message-spacer" />
        <span>{formatTimestamp(row.timestamp)}</span>
        {row.messageId ? (
          <button
            type="button"
            class="message-action"
            title="Branch from this message"
            aria-label="Branch from this message"
            disabled={branchBusy}
            onClick={() => onBranch(row.messageId as number)}
          >
            <BranchIcon />
          </button>
        ) : null}
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
  const actionLabel = props.canStop ? (props.stopBusy ? "Stopping..." : "Stop") : "Send";
  return (
    <form class="composer" onSubmit={(event) => { event.preventDefault(); props.onSubmit(); }}>
      <div class="composer-top">
        <label class="icon-button attach" title="Attach files" aria-label="Attach files">
          <PaperclipIcon />
          <input type="file" multiple disabled={props.disabled} onChange={(event) => {
            const input = event.currentTarget as HTMLInputElement;
            props.onFiles(input.files);
            input.value = "";
          }} />
        </label>
        <div class="attachment-list">
          {props.attachments.map((attachment, index) => (
            <span class="attachment-chip" key={`${attachment.filename ?? "file"}:${index}`}>
              <span>{attachment.filename || "attachment"}</span>
              <button type="button" aria-label="Remove attachment" onClick={() => props.onRemoveAttachment(index)}>x</button>
            </span>
          ))}
        </div>
      </div>
      <textarea
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
      <div class="composer-foot">
        <span>Enter sends. Shift+Enter inserts a line.</span>
        <button
          class={props.canStop ? "primary-button danger" : "primary-button"}
          type={props.canStop ? "button" : "submit"}
          disabled={props.canStop ? props.stopBusy : !props.canSend}
          onClick={props.canStop ? props.onStop : undefined}
        >
          {actionLabel}
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

function ArchiveMessage({ entry }: { entry: unknown }) {
  const record = asRecord(entry);
  const role = record?.role === "user" || record?.role === "assistant" ? record.role : "system";
  const timestamp = normalizeTimestampMs(record?.timestamp);
  return (
    <article class="archive-message">
      <div>
        <span>{labelForRole(role)}</span>
        <span>{timestamp ? formatTimestamp(timestamp) : ""}</span>
      </div>
      <pre>{formatMessageContent(record?.content)}</pre>
    </article>
  );
}
