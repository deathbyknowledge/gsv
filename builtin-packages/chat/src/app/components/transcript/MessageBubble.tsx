import type { MessageRow } from "../../types";
import { BranchIcon, CopyIcon, MoreIcon } from "../../icons";
import { closeChatMenus, closeContainingChatMenu, formatInteractionOriginLabel, formatTimestamp, labelForRole, renderMarkdownHtml } from "../../view-helpers";
import { isAudioMedia, mediaFilename, mediaKind, mediaSourceErrorFor, mediaSourceFor, mediaSourceKey, mediaTranscription } from "../../domain/media";
import { MediaAttachment } from "../media/MediaAttachment";
import { VoiceMessage } from "../media/VoiceMessage";

export function MessageBubble({
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
  const originLabel = formatInteractionOriginLabel(row.origin);
  const mediaTranscript = media.map(mediaTranscription).filter(Boolean).join("\n\n");
  const copyValue = row.text.trim()
    || mediaTranscript
    || row.text;
  return (
    <article class={`message message-${row.role}`}>
      <div class="message-head">
        <span class="message-role-label">{labelForRole(row.role, userLabel)}</span>
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
        <details class={`message-thinking${row.streaming ? " is-live" : ""}`} open={row.streaming}>
          <summary>{row.streaming ? "Reasoning..." : "Reasoning"}</summary>
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
