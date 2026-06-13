import type { ComponentChildren } from "preact";
import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "preact/hooks";
import type { HilRequest, LogRow, MessageRow, PendingAssistantState } from "../../types";
import type { TranscriptItem, TranscriptRunGroup } from "../../domain/run-groups";
import { groupTranscriptRows } from "../../domain/run-groups";
import {
  useVirtualTranscript,
  type VirtualTranscriptItem,
  type VirtualTranscriptSource,
} from "../../hooks/useVirtualTranscript";
import { layoutAssistantMarkdown, prepareAssistantMarkdown } from "../../domain/assistant-markdown-frame";
import { ArrowDownIcon } from "../../icons";
import { HilCard } from "./HilCard";
import { MessageBubble } from "./MessageBubble";
import { RunGroupView, ThoughtsDrawer } from "./RunGroup";
import { isHiddenInternalToolRow, ToolCard } from "./ToolCard";

type TranscriptEntryBase = VirtualTranscriptSource & {
  kind: "history" | "item" | "pendingHil" | "pendingAssistant";
};

type TranscriptEntry =
  | (TranscriptEntryBase & { kind: "history" })
  | (TranscriptEntryBase & { item: TranscriptItem; kind: "item" })
  | (TranscriptEntryBase & { kind: "pendingHil"; request: HilRequest })
  | (TranscriptEntryBase & { kind: "pendingAssistant"; pendingAssistant: PendingAssistantState });

type TranscriptViewport = {
  contentWidth: number;
  height: number;
  scrollTop: number;
};

const EMPTY_VIEWPORT: TranscriptViewport = {
  contentWidth: 0,
  height: 0,
  scrollTop: 0,
};

const ASSISTANT_DOCUMENT_MAX_WIDTH = 900;
const ASSISTANT_DOCUMENT_MAX_RATIO = 0.88;
const ASSISTANT_DOCUMENT_CHROME_HEIGHT = 44;
const MOBILE_CONTENT_WIDTH_BREAKPOINT = 740;
const assistantMarkdownHeightCache = new Map<string, number>();

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
  const [transcriptNode, setTranscriptNode] = useState<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState<TranscriptViewport>(EMPTY_VIEWPORT);
  const items = useMemo(
    () => groupTranscriptRows(props.rows, props.pendingAssistant, props.pendingHil, props.activeRunId),
    [props.rows, props.pendingAssistant, props.pendingHil, props.activeRunId],
  );
  const hasLiveTranscriptActivity = props.pendingAssistant !== null ||
    props.pendingHil !== null ||
    items.some((item) => item.kind === "run" && item.status !== "completed");
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
  const entries = useMemo(() => buildTranscriptEntries({
    hasHistoryLoader: props.hasOlderHistory || props.loadingOlderHistory,
    hilRendered,
    items,
    pendingAssistant: props.pendingAssistant,
    pendingHil: props.pendingHil,
    pendingRendered,
    viewportWidth: viewport.contentWidth,
  }), [
    hilRendered,
    items,
    pendingRendered,
    props.hasOlderHistory,
    props.loadingOlderHistory,
    props.pendingAssistant,
    props.pendingHil,
    viewport.contentWidth,
  ]);
  const virtual = useVirtualTranscript({
    entries,
    scrollTop: viewport.scrollTop,
    viewportHeight: viewport.height,
  });

  const updateViewportForNode = useCallback((node: HTMLDivElement) => {
    setViewport((current) => {
      const next = readTranscriptViewport(node);
      return sameViewport(current, next) ? current : next;
    });
  }, []);

  const setTranscriptRef = useCallback((node: HTMLDivElement | null) => {
    props.refNode.current = node;
    setTranscriptNode(node);
    if (node) {
      updateViewportForNode(node);
    }
  }, [props.refNode, updateViewportForNode]);

  useEffect(() => {
    if (selectedRunId && !selectedRun) {
      setSelectedRunId(null);
    }
  }, [selectedRun, selectedRunId]);

  useEffect(() => {
    if (!hasLiveTranscriptActivity) {
      return undefined;
    }
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [hasLiveTranscriptActivity]);

  useLayoutEffect(() => {
    if (!transcriptNode) {
      return undefined;
    }
    const updateViewport = () => updateViewportForNode(transcriptNode);
    updateViewport();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateViewport);
      return () => window.removeEventListener("resize", updateViewport);
    }
    const observer = new ResizeObserver(updateViewport);
    observer.observe(transcriptNode);
    return () => observer.disconnect();
  }, [transcriptNode, updateViewportForNode]);

  return (
    <div class="transcript-shell">
      <div
        class="transcript"
        ref={setTranscriptRef}
        onScroll={(event) => {
          const node = event.currentTarget;
          setViewport((current) => current.scrollTop === node.scrollTop
            ? current
            : { ...current, scrollTop: node.scrollTop });
          if (props.hasOlderHistory && !props.loadingOlderHistory && node.scrollTop <= 96) {
            props.onLoadOlderHistory();
          }
          props.onViewedLatest(node);
        }}
      >
        <div
          class="transcript-content is-virtualized"
          ref={props.onContentNode}
          style={{ height: `${virtual.totalHeight}px` }}
        >
          {virtual.items.map((item) => (
            <VirtualTranscriptRow
              key={item.entry.key}
              item={item}
              setItemNode={virtual.setItemNode}
            >
              <TranscriptEntryView
                entry={item.entry}
                now={now}
                selectedRunId={selectedRunId}
                userLabel={props.userLabel}
                assistantLabel={props.assistantLabel}
                branchBusy={props.branchBusy}
                hilBusy={props.hilBusy}
                loadingOlderHistory={props.loadingOlderHistory}
                pendingHil={props.pendingHil}
                mediaSources={props.mediaSources}
                mediaSourceErrors={props.mediaSourceErrors}
                onCopy={props.onCopy}
                onBranch={props.onBranch}
                onHilDecision={props.onHilDecision}
                onLoadOlderHistory={props.onLoadOlderHistory}
                onLoadMediaSource={props.onLoadMediaSource}
                onRetryMediaSource={props.onRetryMediaSource}
                onOpenThoughts={setSelectedRunId}
              />
            </VirtualTranscriptRow>
          ))}
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

function VirtualTranscriptRow({
  children,
  item,
  setItemNode,
}: {
  children: ComponentChildren;
  item: VirtualTranscriptItem<TranscriptEntry>;
  setItemNode(key: string, estimateKey: string, node: HTMLElement | null): void;
}) {
  const setNode = useCallback((node: HTMLElement | null) => {
    setItemNode(item.entry.key, estimateKeyForTranscriptEntry(item.entry), node);
  }, [item.entry, setItemNode]);
  return (
    <div
      class="transcript-virtual-item"
      ref={setNode}
      style={{ transform: `translateY(${item.top}px)` }}
    >
      {children}
    </div>
  );
}

function TranscriptEntryView({
  entry,
  now,
  selectedRunId,
  userLabel,
  assistantLabel,
  branchBusy,
  hilBusy,
  loadingOlderHistory,
  pendingHil,
  mediaSources,
  mediaSourceErrors,
  onCopy,
  onBranch,
  onHilDecision,
  onLoadOlderHistory,
  onLoadMediaSource,
  onRetryMediaSource,
  onOpenThoughts,
}: {
  entry: TranscriptEntry;
  now: number;
  selectedRunId: string | null;
  userLabel: string;
  assistantLabel: string;
  branchBusy: boolean;
  hilBusy: boolean;
  loadingOlderHistory: boolean;
  pendingHil: HilRequest | null;
  mediaSources: Record<string, string>;
  mediaSourceErrors: Record<string, string>;
  onCopy(text: string): void;
  onBranch(messageId: number): void;
  onHilDecision(requestId: string, decision: "approve" | "deny", remember?: boolean): void;
  onLoadOlderHistory(): void;
  onLoadMediaSource(media: unknown): void;
  onRetryMediaSource(media: unknown): void;
  onOpenThoughts(runId: string): void;
}) {
  if (entry.kind === "history") {
    return (
      <button
        type="button"
        class="history-loader"
        disabled={loadingOlderHistory}
        onClick={onLoadOlderHistory}
      >
        {loadingOlderHistory ? <span class="spinner" aria-hidden="true" /> : null}
        <span>{loadingOlderHistory ? "Loading older messages" : "Load older messages"}</span>
      </button>
    );
  }

  if (entry.kind === "pendingHil") {
    return <HilCard request={entry.request} busy={hilBusy} onDecision={onHilDecision} />;
  }

  if (entry.kind === "pendingAssistant") {
    return (
      <article class="message-pending">
        <span class="spinner" aria-hidden="true" />
        <span>{entry.pendingAssistant === "tool" ? "Working..." : "Thinking..."}</span>
      </article>
    );
  }

  const item = entry.item;
  if (item.kind === "run") {
    return (
      <RunGroupView
        group={item}
        now={now}
        selected={selectedRunId === item.runId}
        userLabel={userLabel}
        assistantLabel={assistantLabel}
        branchBusy={branchBusy}
        hilBusy={hilBusy}
        mediaSources={mediaSources}
        mediaSourceErrors={mediaSourceErrors}
        onCopy={onCopy}
        onBranch={onBranch}
        onHilDecision={onHilDecision}
        onLoadMediaSource={onLoadMediaSource}
        onRetryMediaSource={onRetryMediaSource}
        onOpenThoughts={onOpenThoughts}
      />
    );
  }

  const row = item.row;
  if (row.kind === "toolCall" || row.kind === "toolResult") {
    if (pendingHil && row.kind === "toolCall" && row.callId === pendingHil.callId) {
      return (
        <HilCard
          request={{ ...pendingHil, toolName: row.toolName || pendingHil.toolName, syscall: row.syscall || pendingHil.syscall, args: row.args ?? pendingHil.args }}
          busy={hilBusy}
          onDecision={onHilDecision}
        />
      );
    }
    if (isHiddenInternalToolRow(row, pendingHil)) {
      return null;
    }
    return <ToolCard row={row} />;
  }

  const messageRow = row as MessageRow;
  return (
    <MessageBubble
      row={messageRow}
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
}

function buildTranscriptEntries({
  hasHistoryLoader,
  hilRendered,
  items,
  pendingAssistant,
  pendingHil,
  pendingRendered,
  viewportWidth,
}: {
  hasHistoryLoader: boolean;
  hilRendered: boolean;
  items: TranscriptItem[];
  pendingAssistant: PendingAssistantState;
  pendingHil: HilRequest | null;
  pendingRendered: boolean;
  viewportWidth: number;
}): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  if (hasHistoryLoader) {
    entries.push({
      estimateHeight: 36,
      estimateKey: "history-loader",
      key: "history-loader",
      kind: "history",
    });
  }
  items.forEach((item, index) => {
    const estimateHeight = estimateTranscriptItemHeight(item, viewportWidth);
    entries.push({
      alwaysRender: item.kind === "run" && item.status !== "completed",
      estimateHeight,
      estimateKey: `${Math.round(viewportWidth)}:${Math.round(estimateHeight)}`,
      item,
      key: keyForTranscriptItem(item, index),
      kind: "item",
    });
  });
  if (pendingHil && !hilRendered) {
    entries.push({
      alwaysRender: true,
      estimateHeight: 132,
      estimateKey: "pending-hil",
      key: `pending-hil:${pendingHil.requestId}`,
      kind: "pendingHil",
      request: pendingHil,
    });
  }
  if (pendingAssistant && !pendingRendered) {
    entries.push({
      alwaysRender: true,
      estimateHeight: 34,
      estimateKey: `pending-assistant:${pendingAssistant}`,
      key: `pending-assistant:${pendingAssistant}`,
      kind: "pendingAssistant",
      pendingAssistant,
    });
  }
  return entries;
}

function estimateKeyForTranscriptEntry(entry: TranscriptEntry): string {
  return entry.estimateKey ?? String(Math.round(entry.estimateHeight));
}

function keyForTranscriptItem(item: TranscriptItem, index: number): string {
  if (item.kind === "run") {
    return `run:${item.runId}:${index}`;
  }
  const row = item.row;
  if (row.kind === "toolCall" || row.kind === "toolResult") {
    return `tool:${row.kind}:${row.callId}:${row.timestamp}`;
  }
  if (row.kind === "message") {
    return `message:${row.messageId ?? `${row.role}:${row.timestamp}:${index}`}`;
  }
  return `row:${index}`;
}

function estimateTranscriptItemHeight(item: TranscriptItem, viewportWidth: number): number {
  if (item.kind === "run") {
    const userHeight = item.userRows.reduce((sum, row) => sum + estimateMessageHeight(row, viewportWidth), 0);
    const detailHeight = item.pendingAssistant || item.pendingHil || item.detailEntries.length > 0 ? 40 : 0;
    const hilHeight = item.pendingHil ? 132 : 0;
    const responseRows = item.finalAssistantRows.concat(item.systemRows);
    const responseHeight = responseRows.reduce((sum, row) => sum + estimateMessageHeight(row, viewportWidth), 0);
    const rowCount = item.userRows.length + responseRows.length + (detailHeight > 0 ? 1 : 0) + (hilHeight > 0 ? 1 : 0);
    return Math.max(42, userHeight + detailHeight + hilHeight + responseHeight + Math.max(0, rowCount - 1) * 10);
  }
  const row = item.row;
  if (row.kind === "toolCall" || row.kind === "toolResult") {
    return row.kind === "toolCall" ? 86 : 112;
  }
  if (row.kind === "message") {
    return estimateMessageHeight(row, viewportWidth);
  }
  return 72;
}

function estimateMessageHeight(row: MessageRow, viewportWidth: number): number {
  if (row.role === "system") {
    return estimateSystemMessageHeight(row, viewportWidth);
  }
  if (row.role === "assistant" && !row.streaming) {
    return estimateAssistantDocumentHeight(row, viewportWidth);
  }
  const base = row.role === "assistant" ? 46 : 58;
  const charsPerLine = row.role === "assistant" ? 84 : 54;
  const lineHeight = row.role === "assistant" ? 24 : 19;
  const textLines = Math.max(1, Math.ceil(row.text.length / charsPerLine));
  const mediaCount = row.media?.length ?? 0;
  return base + textLines * lineHeight + mediaCount * 72;
}

function estimateAssistantDocumentHeight(row: MessageRow, viewportWidth: number): number {
  const text = row.text.trim();
  if (!text) {
    return 0;
  }
  const width = assistantDocumentBodyWidth(viewportWidth);
  if (width <= 0) {
    return estimateFallbackMessageHeight(row);
  }
  const cacheKey = `${width}\0${text}`;
  const cached = assistantMarkdownHeightCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  try {
    const height = ASSISTANT_DOCUMENT_CHROME_HEIGHT + layoutAssistantMarkdown(prepareAssistantMarkdown(text), width).height;
    if (assistantMarkdownHeightCache.size > 300) {
      assistantMarkdownHeightCache.clear();
    }
    assistantMarkdownHeightCache.set(cacheKey, height);
    return height;
  } catch {
    return estimateFallbackMessageHeight(row);
  }
}

function estimateFallbackMessageHeight(row: MessageRow): number {
  const base = row.role === "assistant" ? 46 : 58;
  const charsPerLine = row.role === "assistant" ? 84 : 54;
  const lineHeight = row.role === "assistant" ? 24 : 19;
  const textLines = Math.max(1, Math.ceil(row.text.length / charsPerLine));
  const mediaCount = row.media?.length ?? 0;
  return base + textLines * lineHeight + mediaCount * 72;
}

function estimateSystemMessageHeight(row: MessageRow, viewportWidth: number): number {
  const width = assistantDocumentBodyWidth(viewportWidth);
  const charsPerLine = width > 0 ? Math.max(36, Math.floor(width / 7.2)) : 90;
  const textLines = Math.max(1, Math.ceil(row.text.length / charsPerLine));
  return 14 + textLines * 18;
}

function assistantDocumentBodyWidth(viewportWidth: number): number {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) {
    return 0;
  }
  return Math.max(
    1,
    Math.floor(
      viewportWidth <= MOBILE_CONTENT_WIDTH_BREAKPOINT
        ? viewportWidth
        : Math.min(ASSISTANT_DOCUMENT_MAX_WIDTH, viewportWidth * ASSISTANT_DOCUMENT_MAX_RATIO),
    ),
  );
}

function readTranscriptViewport(node: HTMLDivElement): TranscriptViewport {
  const style = window.getComputedStyle(node);
  const paddingLeft = Number.parseFloat(style.paddingLeft) || 0;
  const paddingRight = Number.parseFloat(style.paddingRight) || 0;
  return {
    contentWidth: Math.max(0, node.clientWidth - paddingLeft - paddingRight),
    height: node.clientHeight,
    scrollTop: node.scrollTop,
  };
}

function sameViewport(a: TranscriptViewport, b: TranscriptViewport): boolean {
  return a.contentWidth === b.contentWidth
    && a.height === b.height
    && a.scrollTop === b.scrollTop;
}
