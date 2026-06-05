import type { MessageRow } from "../../types";
import { BranchIcon, CopyIcon, MessageIcon, MoreIcon } from "../../icons";
import { closeChatMenus, closeContainingChatMenu, formatInteractionOriginLabel, formatTimestamp, labelForRole, renderMarkdownHtml } from "../../view-helpers";
import { isAudioMedia, mediaFilename, mediaKind, mediaSourceErrorFor, mediaSourceFor, mediaSourceKey, mediaTranscription } from "../../domain/media";
import { usePretextBubbleWidth } from "../../hooks/usePretextBubbleWidth";
import { MediaAttachment } from "../media/MediaAttachment";
import { VoiceMessage } from "../media/VoiceMessage";

export function MessageBubble({
  row,
  userLabel,
  assistantLabel,
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
  assistantLabel: string;
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
  const roleLabel = labelForRole(row.role, userLabel, assistantLabel);
  const timestampLabel = formatTimestamp(row.timestamp);
  const useTightBubble = row.role === "user" && hasText && media.length === 0 && !originLabel;
  const { bubbleRef, bubbleStyle } = usePretextBubbleWidth(row.text, useTightBubble, [roleLabel, timestampLabel]);
  const mediaTranscript = media.map(mediaTranscription).filter(Boolean).join("\n\n");
  const copyValue = row.text.trim()
    || mediaTranscript
    || row.text;

  if (row.role === "system") {
    return (
      <article class={`system-message${systemMessageTone(row.text)}`}>
        <span class="system-message-icon" aria-hidden="true">
          <MessageIcon />
        </span>
        <pre class="system-message-body">{row.text}</pre>
      </article>
    );
  }

  const messageBody = (
    <>
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
    </>
  );

  if (row.role === "user") {
    return (
      <article
        ref={bubbleRef}
        class={`message message-${row.role}${useTightBubble ? " is-pretext-sized" : ""}`}
        style={bubbleStyle}
      >
        <div class="message-content">{messageBody}</div>
        <footer class="message-foot">
          <span class="message-role-label">{roleLabel}</span>
          {originLabel ? <span class="message-origin-label" title={originLabel}>{originLabel}</span> : null}
          <span class="message-spacer" />
          <button type="button" class="message-action" title="Copy" aria-label="Copy" onClick={() => onCopy(copyValue)}>
            <CopyIcon />
          </button>
          <span>{timestampLabel}</span>
        </footer>
      </article>
    );
  }

  return (
    <article
      ref={bubbleRef}
      class={`message message-${row.role}${useTightBubble ? " is-pretext-sized" : ""}`}
      style={bubbleStyle}
    >
      <div class="message-head">
        <span class="message-role-label">{roleLabel}</span>
        {originLabel ? <span class="message-origin-label" title={originLabel}>{originLabel}</span> : null}
        <span class="message-spacer" />
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
        <span>{timestampLabel}</span>
      </div>
      {messageBody}
    </article>
  );
}

function systemMessageTone(text: string): string {
  return /\b(error|failed|denied|aborted|invalid)\b/i.test(text) ? " is-warning" : "";
}
