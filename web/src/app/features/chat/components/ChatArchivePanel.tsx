import { useEffect, useRef } from "preact/hooks";
import {
  normalizeHistoryMessage,
  type ChatHistory,
} from "../domain/processes";
import { transcriptRowsFromHistory } from "../domain/transcript";
import {
  useChatConversationSegment,
  useChatConversationSegments,
} from "../hooks";
import { ChatTranscript } from "./ChatTranscript";
import { shortId } from "./chatUiFormat";

type ChatArchivePanelProps = {
  conversationId: string;
  onClose: () => void;
  processId: string;
  selectedSegmentId: string;
  onSelectSegment: (segmentId: string) => void;
};

function archiveHistoryFromSegment(
  processId: string,
  segment: NonNullable<ReturnType<typeof useChatConversationSegment>["data"]>,
): ChatHistory {
  return {
    pid: processId,
    conversationId: segment.conversationId,
    messages: segment.messages.map(normalizeHistoryMessage),
    messageCount: segment.messageCount,
    truncated: segment.truncated === true,
    hasMoreBefore: false,
    hasMoreAfter: false,
    activeRunId: null,
    activeConversationId: null,
    runState: "idle",
    pendingHil: null,
    context: null,
  };
}

export function ChatArchivePanel({
  conversationId,
  onClose,
  onSelectSegment,
  processId,
  selectedSegmentId,
}: ChatArchivePanelProps) {
  const segments = useChatConversationSegments({
    args: { pid: processId, conversationId },
  });
  const selected = selectedSegmentId
    || segments.data?.[0]?.id
    || "";
  const segment = useChatConversationSegment({
    args: {
      pid: processId,
      conversationId,
      segmentId: selected,
      limit: 100,
    },
    enabled: selected.length > 0,
  });
  const rows = segment.data
    ? transcriptRowsFromHistory(archiveHistoryFromSegment(processId, segment.data))
    : [];
  const segmentCount = segments.data?.length ?? 0;
  const backRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    backRef.current?.focus();
  }, []);

  return (
    <section class="gsv-chat-archive" aria-label="Conversation archive">
      <div class="gsv-chat-rp-head">
        <button
          ref={backRef}
          type="button"
          class="gsv-chat-rp-back"
          onClick={onClose}
        >
          <i aria-hidden="true">‹</i>
          BACK TO CHAT
        </button>
        <span class="gsv-chat-rp-meta gsv-sublabel">
          ARCHIVE{selected ? ` ${shortId(selected)}` : ""}
          {segmentCount > 0 ? ` · ${segmentCount} ${segmentCount === 1 ? "SEGMENT" : "SEGMENTS"}` : ""}
        </span>
      </div>
      <div class="gsv-chat-archive-layout">
        <div class="gsv-chat-archive-segments">
          {segments.isLoading ? (
            <div class="gsv-chat-archive-empty">LOADING</div>
          ) : segments.data?.length ? segments.data.map((item) => (
            <button
              key={item.id}
              type="button"
              class={item.id === selected ? "is-active" : ""}
              onClick={() => onSelectSegment(item.id)}
            >
              <span>{item.fromMessageId}-{item.toMessageId}</span>
              <small>{shortId(item.id)}</small>
            </button>
          )) : (
            <div class="gsv-chat-archive-empty">NO ARCHIVE</div>
          )}
        </div>
        <div class="gsv-chat-archive-transcript">
          {segment.isError ? (
            <div class="gsv-chat-archive-empty">SEGMENT UNAVAILABLE</div>
          ) : rows.length > 0 ? (
            <ChatTranscript messages={rows} processId={processId} />
          ) : (
            <div class="gsv-chat-archive-empty">{segment.isLoading ? "LOADING SEGMENT" : "SELECT SEGMENT"}</div>
          )}
        </div>
      </div>
    </section>
  );
}
