import type { ArchiveState, LogRow, MessageRow } from "../../types";
import { ArchiveIcon, RefreshIcon } from "../../icons";
import { copyTextToClipboard, flattenHistory, formatRelativeTime, formatTimestamp, shortId } from "../../view-helpers";
import { MessageBubble } from "../transcript/MessageBubble";
import { isHiddenInternalToolRow, ToolCard } from "../transcript/ToolCard";

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
