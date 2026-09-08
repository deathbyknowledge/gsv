import { useEffect, useRef } from "preact/hooks";
import { transcriptRowsFromRecords } from "../domain/typedHistory";
import {
  useChatHistorySegment,
  useChatHistorySegments,
} from "../hooks";
import { ChatTranscript } from "./ChatTranscript";
import { shortId } from "./chatUiFormat";

type ChatArchivePanelProps = {
  onClose: () => void;
  processId: string;
  selectedSegmentId: string;
  onSelectSegment: (segmentId: string) => void;
};

export function ChatArchivePanel({
  onClose,
  onSelectSegment,
  processId,
  selectedSegmentId,
}: ChatArchivePanelProps) {
  const segments = useChatHistorySegments({
    args: { pid: processId },
  });
  const selected = selectedSegmentId
    || segments.data?.[0]?.id
    || "";
  const segment = useChatHistorySegment({
    args: {
      pid: processId,
      segmentId: selected,
      limit: 100,
    },
    enabled: selected.length > 0,
  });
  const rows = segment.data
    ? transcriptRowsFromRecords(segment.data.records)
    : [];
  const segmentCount = segments.data?.length ?? 0;
  const backRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    backRef.current?.focus();
  }, []);

  return (
    <section class="gsv-chat-archive" aria-label="Process history archive">
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
            <div class="gsv-chat-archive-empty">{segment.error instanceof Error ? segment.error.message : "SEGMENT UNAVAILABLE"}</div>
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
