import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
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
  VoiceRecordingState,
  WorkspaceEntry,
} from "./types";
import {
  ArchiveIcon,
  BranchIcon,
  CheckIcon,
  CopyIcon,
  FileIcon,
  GaugeIcon,
  HomeIcon,
  ImageIcon,
  MessageIcon,
  MicIcon,
  MoreIcon,
  PauseIcon,
  PaperclipIcon,
  PlayIcon,
  PlusIcon,
  RefreshIcon,
  SendIcon,
  StopIcon,
  VideoIcon,
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
  describeHilSummary,
  describeToolCard,
  displayThreadLabel,
  formatContextPressure,
  formatRelativeTime,
  formatTimestamp,
  flattenHistory,
  formatAttachmentDuration,
  formatAttachmentSize,
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
  userLabel: string;
  mediaSources: Record<string, string>;
  mediaSourceErrors: Record<string, string>;
  onRefresh(): void;
  onSelect(segmentId: string): void;
  onLoadMediaSource(media: unknown): void;
  onRetryMediaSource(media: unknown): void;
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
                <ArchiveRow
                  key={`${row.kind}:${row.kind === "message" ? row.messageId ?? index : row.callId}:${index}`}
                  row={row}
                  userLabel={props.userLabel}
                  mediaSources={props.mediaSources}
                  mediaSourceErrors={props.mediaSourceErrors}
                  onLoadMediaSource={props.onLoadMediaSource}
                  onRetryMediaSource={props.onRetryMediaSource}
                />
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
  userLabel: string;
  pendingAssistant: PendingAssistantState;
  pendingHil: HilRequest | null;
  hilBusy: boolean;
  branchBusy: boolean;
  refNode: { current: HTMLDivElement | null };
  autoscrollAnchorRef: { current: HTMLDivElement | null };
  mediaSources: Record<string, string>;
  mediaSourceErrors: Record<string, string>;
  onCopy(text: string): void;
  onBranch(messageId: number): void;
  onHilDecision(requestId: string, decision: "approve" | "deny", remember?: boolean): void;
  onLoadMediaSource(media: unknown): void;
  onRetryMediaSource(media: unknown): void;
}) {
  const hilRendered = props.pendingHil
    ? props.rows.some((row) => row.kind === "toolCall" && row.callId === props.pendingHil?.callId)
    : true;
  return (
    <div class="transcript" ref={(node) => { props.refNode.current = node; }}>
      <div class="transcript-anchor" ref={(node) => { props.autoscrollAnchorRef.current = node; }} />
      {props.rows.map((row, index) => {
        if (row.kind === "toolCall" || row.kind === "toolResult") {
          return null;
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
        <HilOverlay request={props.pendingHil} busy={props.hilBusy} onDecision={props.onHilDecision} />
      ) : null}
      {props.pendingAssistant ? (
        <ThinkingStatus pendingAssistant={props.pendingAssistant} rows={props.rows} />
      ) : null}
    </div>
  );
}

function MessageBubble({
  row,
  userLabel,
  branchBusy,
  branchable = true,
  mediaSources,
  mediaSourceErrors,
  onCopy,
  onBranch,
  onLoadMediaSource,
  onRetryMediaSource,
}: {
  row: MessageRow;
  userLabel: string;
  branchBusy: boolean;
  branchable?: boolean;
  mediaSources: Record<string, string>;
  mediaSourceErrors: Record<string, string>;
  onCopy(text: string): void;
  onBranch(messageId: number): void;
  onLoadMediaSource(media: unknown): void;
  onRetryMediaSource(media: unknown): void;
}) {
  const thinking = row.thinking?.filter(Boolean) ?? [];
  const media = row.media ?? [];
  const voiceMedia = media.filter(isAudioMedia);
  const otherMedia = media.filter((item) => !isAudioMedia(item));
  const hasText = row.text.trim().length > 0;
  const mediaTranscript = media.map(mediaTranscription).filter(Boolean).join("\n\n");
  const copyValue = row.text.trim()
    || mediaTranscript
    || row.text;
  return (
    <article class={`message message-${row.role}`}>
      <div class="message-head">
        <span class="message-role-label">{labelForRole(row.role, userLabel)}</span>
        <span class="message-spacer" />
        <span>{formatTimestamp(row.timestamp)}</span>
        <details class="message-menu">
          <summary class="message-action" title="Message actions" aria-label="Message actions" onClick={(event) => {
            closeChatMenus((event.currentTarget as HTMLElement).closest("details") as HTMLDetailsElement | null);
          }}>
            <MoreIcon />
          </summary>
          <div class="message-menu-popover">
            <button type="button" class="menu-action" onClick={(event) => { closeContainingChatMenu(event.currentTarget); onCopy(copyValue); }}>
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
      {hasText && row.role === "assistant" ? (
        <div class="message-body message-markdown" dangerouslySetInnerHTML={{ __html: renderMarkdownHtml(row.text) }} />
      ) : hasText ? (
        <pre class="message-body">{row.text}</pre>
      ) : null}
      {voiceMedia.length > 0 ? (
        <div class="voice-message-list">
          {voiceMedia.map((item, index) => (
            <VoiceMessage
              key={`${mediaSourceKey(item) ?? "voice"}:${index}`}
              media={item}
              source={mediaSourceFor(item, mediaSources)}
              error={mediaSourceErrorFor(item, mediaSourceErrors)}
              onLoadMediaSource={onLoadMediaSource}
              onRetryMediaSource={onRetryMediaSource}
            />
          ))}
        </div>
      ) : null}
      {otherMedia.length > 0 ? (
        <div class="message-media">
          {otherMedia.map((item, index) => (
            <MediaAttachment
              key={`${mediaSourceKey(item) ?? mediaFilename(item) ?? mediaKind(item)}:${index}`}
              media={item}
              source={mediaSourceFor(item, mediaSources)}
              error={mediaSourceErrorFor(item, mediaSourceErrors)}
              onLoadMediaSource={onLoadMediaSource}
              onRetryMediaSource={onRetryMediaSource}
            />
          ))}
        </div>
      ) : null}
    </article>
  );
}

function ThinkingStatus(props: { pendingAssistant: PendingAssistantState; rows: LogRow[] }) {
  const [open, setOpen] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(() => {
    const end = props.pendingAssistant?.finishedAt ?? Date.now();
    return Math.max(0, end - props.pendingAssistant.startedAt);
  });
  const [showDoneSummary, setShowDoneSummary] = useState(props.pendingAssistant.mode !== "done");

  useEffect(() => {
    if (props.pendingAssistant.mode === "done") {
      setElapsedMs(Math.max(0, (props.pendingAssistant.finishedAt ?? Date.now()) - props.pendingAssistant.startedAt));
      setShowDoneSummary(true);
      const timer = window.setTimeout(() => setShowDoneSummary(false), 4000);
      return () => window.clearTimeout(timer);
    }
    setShowDoneSummary(true);
    const timer = window.setInterval(() => {
      setElapsedMs(Date.now() - props.pendingAssistant.startedAt);
    }, 250);
    return () => window.clearInterval(timer);
  }, [props.pendingAssistant]);

  const toolRows = useMemo(
    () => props.rows.filter((row) => row.kind === "toolCall" || row.kind === "toolResult") as ToolRow[],
    [props.rows],
  );
  const toolSummary = useMemo(() => summarizeToolRows(toolRows), [toolRows]);

  const label = props.pendingAssistant.mode === "tool"
    ? describeThinkingStatus(toolRows)
    : props.pendingAssistant.mode === "thinking"
      ? "Looking up stuff..."
      : showDoneSummary
        ? `Thought for ${formatThinkingElapsed(elapsedMs)}`
        : "Thought";

  return (
    <>
      <button type="button" class="thinking-status" onClick={() => setOpen(true)}>
        <span class="spinner" aria-hidden="true" />
        <span>{label}</span>
      </button>
      {open ? (
        <div class="thinking-sidebar-backdrop" onClick={() => setOpen(false)}>
          <aside class="thinking-sidebar" onClick={(event) => event.stopPropagation()}>
            <header class="thinking-sidebar-head">
              <div>
                <h2>Thinking trace</h2>
                <p>{props.pendingAssistant.mode === "done" ? `Thought for ${formatThinkingElapsed(elapsedMs)}` : label}</p>
              </div>
              <button type="button" class="icon-button small" onClick={() => setOpen(false)}>
                <XIcon />
              </button>
            </header>
            <div class="thinking-sidebar-body">
              {toolRows.length === 0 ? (
                <div class="panel-empty">No tool activity recorded.</div>
              ) : (
                <>
                  <section class="thinking-summary-panel">
                    <h3>Summary</h3>
                    <ul>
                      {toolSummary.map((item, index) => <li key={`${item}:${index}`}>{item}</li>)}
                    </ul>
                  </section>
                  <details class="thinking-raw-panel">
                    <summary>Raw trace</summary>
                    <div class="thinking-raw-panel-body">
                      {toolRows.map((row, index) => (
                        <ToolCard key={`${row.callId}:${index}`} row={row} />
                      ))}
                    </div>
                  </details>
                </>
              )}
            </div>
          </aside>
        </div>
      ) : null}
    </>
  );
}

function formatThinkingElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.round(elapsedMs / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

function describeThinkingStatus(toolRows: ToolRow[]): string {
  const latest = toolRows[toolRows.length - 1];
  const syscall = inferToolSyscall(latest?.toolName || "", latest?.syscall);
  if (syscall === "shell.exec" || syscall === "fs.search" || syscall === "fs.read") {
    return "Looking up stuff...";
  }
  if (syscall === "sys.mcp.call") {
    return "Accessing the web...";
  }
  if (syscall === "fs.write" || syscall === "fs.edit" || syscall === "fs.delete") {
    return "Working on files...";
  }
  return "Thinking...";
}

function summarizeToolRows(toolRows: ToolRow[]): string[] {
  const counts = new Map<string, number>();
  for (const row of toolRows) {
    const syscall = inferToolSyscall(row.toolName, row.syscall);
    let label = "Used a tool";
    if (syscall === "fs.read") label = "Read files";
    else if (syscall === "fs.search") label = "Searched workspace";
    else if (syscall === "shell.exec") label = "Ran shell commands";
    else if (syscall === "fs.write" || syscall === "fs.edit" || syscall === "fs.delete") label = "Modified files";
    else if (syscall === "sys.mcp.call") label = "Accessed external services";
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  return Array.from(counts.entries()).map(([label, count]) => `${label}${count > 1 ? ` (${count})` : ""}`);
}

function MediaAttachment(props: {
  media: unknown;
  source: string | null;
  error: string;
  onLoadMediaSource(media: unknown): void;
  onRetryMediaSource(media: unknown): void;
}) {
  const kind = mediaKind(props.media);
  const key = mediaSourceKey(props.media);

  useEffect(() => {
    if (!props.source && !props.error && key) {
      props.onLoadMediaSource(props.media);
    }
  }, [key, props.error, props.media, props.onLoadMediaSource, props.source]);

  if (props.error) {
    return (
      <MediaLoadError
        icon={mediaKindIcon(kind)}
        label={`${mediaKindLabel(kind)} failed to load.`}
        error={props.error}
        onRetry={() => props.onRetryMediaSource(props.media)}
      />
    );
  }

  if (kind === "image") {
    return <ImageAttachment media={props.media} source={props.source} />;
  }
  if (kind === "video") {
    return <VideoAttachment media={props.media} source={props.source} />;
  }
  return <DocumentAttachment media={props.media} source={props.source} />;
}

function ImageAttachment(props: { media: unknown; source: string | null }) {
  const filename = mediaFilename(props.media) || "Image";
  if (!props.source) {
    return <MediaLoading icon={<ImageIcon />} label="Loading image..." />;
  }
  return (
    <figure class="media-preview media-preview-image">
      <img src={props.source} alt={filename} loading="lazy" />
      <figcaption>{filename}</figcaption>
    </figure>
  );
}

function VideoAttachment(props: { media: unknown; source: string | null }) {
  const filename = mediaFilename(props.media) || "Video";
  const duration = asNumber(asRecord(props.media)?.duration);
  if (!props.source) {
    return <MediaLoading icon={<VideoIcon />} label="Loading video..." />;
  }
  return (
    <section class="media-preview media-preview-video">
      <video controls preload="metadata" src={props.source} />
      <div class="media-preview-caption">
        <span>{filename}</span>
        {formatAttachmentDuration(duration) ? <time>{formatAttachmentDuration(duration)}</time> : null}
      </div>
    </section>
  );
}

function DocumentAttachment(props: { media: unknown; source: string | null }) {
  const filename = mediaFilename(props.media) || "Attachment";
  const mimeType = mediaMimeType(props.media);
  const size = asNumber(asRecord(props.media)?.size);
  const sizeLabel = formatAttachmentSize(size);
  const label = [mimeType, sizeLabel].filter(Boolean).join(" - ");
  const content = (
    <>
      <span class="media-file-icon" aria-hidden="true"><FileIcon /></span>
      <span class="media-file-main">
        <span>{filename}</span>
        {label ? <span>{label}</span> : null}
      </span>
    </>
  );
  if (props.source) {
    return (
      <a class="media-file" href={props.source} download={filename} target="_blank" rel="noreferrer">
        {content}
      </a>
    );
  }
  return (
    <div class="media-file is-loading">
      {content}
    </div>
  );
}

function MediaLoading(props: { icon: ComponentChildren; label: string }) {
  return (
    <div class="media-loading">
      <span aria-hidden="true">{props.icon}</span>
      <span>{props.label}</span>
    </div>
  );
}

function MediaLoadError(props: { icon: ComponentChildren; label: string; error: string; onRetry(): void }) {
  return (
    <div class="media-loading is-error" title={props.error}>
      <span aria-hidden="true">{props.icon}</span>
      <span>{props.label}</span>
      <button type="button" onClick={props.onRetry}>Retry</button>
    </div>
  );
}

function VoiceMessage(props: {
  media: unknown;
  source: string | null;
  error: string;
  onLoadMediaSource(media: unknown): void;
  onRetryMediaSource(media: unknown): void;
}) {
  const key = mediaSourceKey(props.media);
  const record = asRecord(props.media);
  const duration = asNumber(record?.duration);
  const transcription = asString(record?.transcription)?.trim() || "";

  useEffect(() => {
    if (!props.source && !props.error && key) {
      props.onLoadMediaSource(props.media);
    }
  }, [key, props.error, props.media, props.onLoadMediaSource, props.source]);

  return (
    <section class="voice-message">
      <div class="voice-message-player">
        <span class="voice-message-icon" aria-hidden="true"><MicIcon /></span>
        <div class="voice-message-main">
          {props.error ? (
            <div class="voice-message-loading is-error" title={props.error}>
              <span>Audio failed to load.</span>
              <button type="button" onClick={() => props.onRetryMediaSource(props.media)}>Retry</button>
            </div>
          ) : props.source ? (
            <VoiceAudioPlayer source={props.source} duration={duration} />
          ) : (
            <div class="voice-message-loading">Loading audio...</div>
          )}
        </div>
      </div>
      {transcription ? (
        <details class="voice-transcript">
          <summary>Transcription</summary>
          <p>{transcription}</p>
        </details>
      ) : null}
    </section>
  );
}

function VoiceAudioPlayer(props: { source: string; duration: number | null }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(() => normalizeAudioTime(props.duration));
  const [isPlaying, setIsPlaying] = useState(false);
  const max = duration > 0 ? duration : Math.max(currentTime, 1);
  const progress = max > 0 ? Math.min(100, Math.max(0, (currentTime / max) * 100)) : 0;

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }

    const syncDuration = () => {
      const nextDuration = normalizeAudioTime(audio.duration) || normalizeAudioTime(props.duration);
      setDuration(nextDuration);
    };
    const syncTime = () => {
      setCurrentTime(normalizeAudioTime(audio.currentTime));
    };
    const syncPlaying = () => {
      setIsPlaying(!audio.paused && !audio.ended);
    };

    setCurrentTime(0);
    setIsPlaying(false);
    syncDuration();
    audio.addEventListener("loadedmetadata", syncDuration);
    audio.addEventListener("durationchange", syncDuration);
    audio.addEventListener("timeupdate", syncTime);
    audio.addEventListener("play", syncPlaying);
    audio.addEventListener("pause", syncPlaying);
    audio.addEventListener("ended", syncPlaying);

    return () => {
      audio.removeEventListener("loadedmetadata", syncDuration);
      audio.removeEventListener("durationchange", syncDuration);
      audio.removeEventListener("timeupdate", syncTime);
      audio.removeEventListener("play", syncPlaying);
      audio.removeEventListener("pause", syncPlaying);
      audio.removeEventListener("ended", syncPlaying);
    };
  }, [props.duration, props.source]);

  async function togglePlayback(): Promise<void> {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }
    if (audio.paused || audio.ended) {
      try {
        await audio.play();
      } catch {
        setIsPlaying(false);
      }
      return;
    }
    audio.pause();
  }

  function seek(event: Event): void {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }
    const input = event.currentTarget as HTMLInputElement;
    const nextTime = Number(input.value);
    if (!Number.isFinite(nextTime)) {
      return;
    }
    audio.currentTime = nextTime;
    setCurrentTime(nextTime);
  }

  return (
    <div class="voice-audio-player">
      <audio class="voice-audio-native" ref={audioRef} preload="metadata" src={props.source} />
      <button
        type="button"
        class="voice-audio-button"
        title={isPlaying ? "Pause voice message" : "Play voice message"}
        aria-label={isPlaying ? "Pause voice message" : "Play voice message"}
        onClick={() => void togglePlayback()}
      >
        {isPlaying ? <PauseIcon /> : <PlayIcon />}
      </button>
      <input
        class="voice-audio-range"
        type="range"
        min="0"
        max={String(max)}
        step="0.01"
        value={String(Math.min(currentTime, max))}
        aria-label="Voice message position"
        style={{ background: `linear-gradient(to right, var(--blue) 0%, var(--blue) ${progress}%, rgba(31, 92, 153, 0.14) ${progress}%, rgba(31, 92, 153, 0.14) 100%)` }}
        onInput={seek}
      />
      <span class="voice-audio-time">{formatAudioPlayerTime(currentTime)} / {formatAudioPlayerTime(duration)}</span>
    </div>
  );
}

function normalizeAudioTime(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function formatAudioPlayerTime(value: number): string {
  const totalSeconds = Math.floor(normalizeAudioTime(value));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function isAudioMedia(media: unknown): boolean {
  return mediaKind(media) === "audio";
}

function mediaKind(media: unknown): string {
  const record = asRecord(media);
  const type = asString(record?.type);
  const mimeType = asString(record?.mimeType);
  if (type === "image" || type === "audio" || type === "video" || type === "document") {
    return type;
  }
  const normalizedMimeType = mimeType?.toLowerCase() || "";
  if (normalizedMimeType.startsWith("image/")) return "image";
  if (normalizedMimeType.startsWith("audio/")) return "audio";
  if (normalizedMimeType.startsWith("video/")) return "video";
  return "document";
}

function mediaKindIcon(kind: string): ComponentChildren {
  if (kind === "image") return <ImageIcon />;
  if (kind === "audio") return <MicIcon />;
  if (kind === "video") return <VideoIcon />;
  return <FileIcon />;
}

function mediaKindLabel(kind: string): string {
  if (kind === "image") return "Image";
  if (kind === "audio") return "Audio";
  if (kind === "video") return "Video";
  return "Attachment";
}

function mediaSourceFor(media: unknown, sources: Record<string, string>): string | null {
  const record = asRecord(media);
  const previewUrl = asString(record?.previewUrl);
  if (previewUrl) return safeMediaSourceUrl(previewUrl, ["blob:", "data:", "https:", "http:"]);
  const url = asString(record?.url);
  if (url) return safeMediaSourceUrl(url, ["https:", "http:"]);
  const data = asString(record?.data);
  if (data) {
    const dataUrl = data.startsWith("data:")
      ? data
      : `data:${asString(record?.mimeType) || "application/octet-stream"};base64,${data}`;
    return safeMediaSourceUrl(dataUrl, ["data:"]);
  }
  const key = mediaSourceKey(media);
  return key ? sources[key] ?? null : null;
}

function safeMediaSourceUrl(value: string, allowedProtocols: string[]): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const base = typeof window !== "undefined" ? window.location.href : "https://gsv.local/";
    const url = new URL(trimmed, base);
    return allowedProtocols.includes(url.protocol) ? trimmed : null;
  } catch {
    return null;
  }
}

function mediaSourceKey(media: unknown): string | null {
  const record = asRecord(media);
  return asString(record?.key);
}

function mediaSourceErrorFor(media: unknown, errors: Record<string, string>): string {
  const key = mediaSourceKey(media);
  return key ? errors[key] || "" : "";
}

function mediaTranscription(media: unknown): string {
  const record = asRecord(media);
  return asString(record?.transcription)?.trim() || "";
}

function mediaFilename(media: unknown): string | null {
  const record = asRecord(media);
  return asString(record?.filename);
}

function mediaMimeType(media: unknown): string | null {
  const record = asRecord(media);
  return asString(record?.mimeType);
}

function ToolCard({ row }: { row: ToolRow }) {
  if (row.collapsed && row.childRows?.length) {
    const childRows = row.childRows;
    const running = childRows.some((child) => child.kind === "toolCall");
    const errors = childRows.filter((child) => child.kind === "toolResult" && child.ok === false).length;
    const done = childRows.filter((child) => child.kind === "toolResult" && child.ok !== false).length;
    const approvals = childRows.filter((child) => child.kind === "toolCall").length;
    const statusClass = running ? "is-pending" : errors > 0 ? "is-error" : "is-ok";
    const defaultOpen = errors > 0;
    return (
      <article class={`tool-card ${statusClass} is-collapsed-group`}>
        <details class="tool-group-details" open={defaultOpen}>
          <summary class="tool-card-head">
            <div>
              <h3>Tool activity</h3>
              <p>{done + approvals} tools{approvals > 0 ? ` · ${approvals} running` : ""}{errors > 0 ? ` · ${errors} error` : running ? "" : " · done"}</p>
            </div>
            <span class={`tool-status ${statusClass}`}>
              {running ? "Running" : errors > 0 ? "Error" : "Done"}
              <span>{done + approvals} tools</span>
            </span>
          </summary>
          <div class="tool-group-list">
            {childRows.map((child, index) => (
              <ToolCard key={`${child.callId}:${index}`} row={child} />
            ))}
          </div>
        </details>
      </article>
    );
  }

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

function isHiddenInternalToolRow(row: ToolRow, pendingHil: HilRequest | null): boolean {
  const syscall = inferToolSyscall(row.toolName, row.syscall);
  return syscall === "sys.mcp.call" && row.callId !== pendingHil?.callId;
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

function HilCard(props: { request: HilRequest; busy: boolean; onDecision(requestId: string, decision: "approve" | "deny", remember?: boolean): void }) {
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
        <button class="secondary-button approval-remember" type="button" title="Allow this tool for this process" disabled={props.busy} onClick={() => props.onDecision(props.request.requestId, "approve", true)}>
          <CheckIcon />
          <span>Always allow</span>
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

function HilOverlay(props: { request: HilRequest; busy: boolean; onDecision(requestId: string, decision: "approve" | "deny", remember?: boolean): void }) {
  return (
    <div class="hil-overlay-backdrop">
      <section class="hil-overlay-panel" role="dialog" aria-modal="true" aria-labelledby="hil-overlay-title">
        <h2 id="hil-overlay-title">Permission needed</h2>
        <HilCard {...props} />
      </section>
    </div>
  );
}

export function Composer(props: {
  value: string;
  attachments: Attachment[];
  disabled: boolean;
  canSend: boolean;
  canStop: boolean;
  stopBusy: boolean;
  voice: VoiceRecordingState;
  canRecord: boolean;
  onValueChange(value: string): void;
  onSubmit(): void;
  onStop(): void;
  onFiles(files: FileList | null): void;
  onRemoveAttachment(index: number): void;
  onStartVoice(): void;
  onStopVoice(): void;
  onCancelVoice(): void;
  onClearVoiceError(): void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const actionLabel = props.canStop ? (props.stopBusy ? "Stopping..." : "Stop") : "Send";
  const voiceActive = props.voice.status !== "idle";
  const showVoicePanel = voiceActive || Boolean(props.voice.error);
  const voiceLabel = labelForVoiceState(props.voice);
  const voiceElapsed = formatAttachmentDuration(props.voice.elapsedMs / 1000) || "0:00";
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
            attachment.type === "audio" ? (
              <DraftVoiceAttachment
                key={`${attachment.filename ?? "voice"}:${index}`}
                attachment={attachment}
                onRemove={() => props.onRemoveAttachment(index)}
              />
            ) : (
              <div class="attachment-chip" key={`${attachment.filename ?? "file"}:${index}`}>
                <span class="attachment-name">{attachment.filename || "attachment"}</span>
                {attachment.duration ? <span class="attachment-duration">{formatAttachmentDuration(attachment.duration)}</span> : null}
                <button type="button" aria-label="Remove attachment" title="Remove attachment" onClick={() => props.onRemoveAttachment(index)}>x</button>
              </div>
            )
          ))}
        </div>
      ) : null}
      {showVoicePanel ? (
        <div class={"voice-panel is-" + props.voice.status}>
          <div class="voice-state">
            <span class="voice-dot" aria-hidden="true" />
            <span>{voiceLabel}</span>
            {props.voice.status === "idle" && props.voice.error ? null : <time>{voiceElapsed}</time>}
          </div>
          {props.voice.error ? <span class="voice-error">{props.voice.error}</span> : null}
          <div class="voice-actions">
            {props.voice.status === "recording" ? (
              <button type="button" class="icon-button small" title="Finish recording" aria-label="Finish recording" onClick={props.onStopVoice}>
                <StopIcon />
              </button>
            ) : null}
            {props.voice.status === "requesting" || props.voice.status === "recording" ? (
              <button type="button" class="icon-button small" title="Cancel recording" aria-label="Cancel recording" onClick={props.onCancelVoice}>
                <XIcon />
              </button>
            ) : null}
            {props.voice.status === "idle" && props.voice.error ? (
              <button type="button" class="icon-button small" title="Dismiss" aria-label="Dismiss voice error" onClick={props.onClearVoiceError}>
                <XIcon />
              </button>
            ) : null}
          </div>
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
        <button
          class={"icon-button voice" + (props.voice.status === "recording" ? " is-recording" : "")}
          type="button"
          title={props.voice.status === "recording" ? "Recording voice" : "Record voice"}
          aria-label={props.voice.status === "recording" ? "Recording voice" : "Record voice"}
          disabled={props.disabled || !props.canRecord || voiceActive}
          onClick={props.onStartVoice}
        >
          <MicIcon />
        </button>
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
              if (props.canSend) {
                props.onSubmit();
              }
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

function DraftVoiceAttachment(props: { attachment: Attachment; onRemove(): void }) {
  const source = props.attachment.previewUrl || props.attachment.data;
  return (
    <div class="attachment-chip is-audio" title={props.attachment.filename || "Voice recording"}>
      <span class="voice-message-icon" aria-hidden="true"><MicIcon /></span>
      <div class="attachment-voice-main">
        {source ? (
          <VoiceAudioPlayer source={source} duration={props.attachment.duration ?? null} />
        ) : (
          <div class="voice-message-loading">Loading audio...</div>
        )}
      </div>
      <button type="button" aria-label="Remove voice recording" title="Remove voice recording" onClick={props.onRemove}>
        <XIcon />
      </button>
    </div>
  );
}

function labelForVoiceState(state: VoiceRecordingState): string {
  if (state.status === "requesting") return "Microphone";
  if (state.status === "recording") return "Recording";
  if (state.status === "processing") return "Preparing voice";
  if (state.error) return "Voice input";
  return "Voice input";
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

function ArchiveRow({
  row,
  userLabel,
  mediaSources,
  mediaSourceErrors,
  onLoadMediaSource,
  onRetryMediaSource,
}: {
  row: LogRow;
  userLabel: string;
  mediaSources: Record<string, string>;
  mediaSourceErrors: Record<string, string>;
  onLoadMediaSource(media: unknown): void;
  onRetryMediaSource(media: unknown): void;
}) {
  if (row.kind === "toolCall" || row.kind === "toolResult") {
    if (isHiddenInternalToolRow(row, null)) {
      return null;
    }
    return <ToolCard row={row} />;
  }
  return (
    <MessageBubble
      row={row as MessageRow}
      userLabel={userLabel}
      branchBusy={false}
      branchable={false}
      mediaSources={mediaSources}
      mediaSourceErrors={mediaSourceErrors}
      onCopy={(text) => { void copyTextToClipboard(text).catch(() => {}); }}
      onBranch={() => {}}
      onLoadMediaSource={onLoadMediaSource}
      onRetryMediaSource={onRetryMediaSource}
    />
  );
}
