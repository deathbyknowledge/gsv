import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { isNearBottom } from "../view-helpers";

export function useTranscriptScroll() {
  const transcriptRef = useRef<HTMLDivElement>(null);
  const [transcriptContentNode, setTranscriptContentNode] = useState<HTMLDivElement | null>(null);
  const [hasNewMessages, setHasNewMessages] = useState(false);
  const hasNewMessagesRef = useRef(false);
  const stickToBottomRef = useRef(true);
  const resizeFrameRef = useRef<number | null>(null);

  const clearNewMessages = useCallback(() => {
    if (!hasNewMessagesRef.current) {
      return;
    }
    hasNewMessagesRef.current = false;
    setHasNewMessages(false);
  }, []);

  const prepareForLiveTranscriptActivity = useCallback(() => {
    const node = transcriptRef.current;
    const atBottom = !node || isNearBottom(node);
    if (stickToBottomRef.current || atBottom) {
      stickToBottomRef.current = true;
      clearNewMessages();
      return;
    }
    if (hasNewMessagesRef.current) {
      return;
    }
    hasNewMessagesRef.current = true;
    setHasNewMessages(true);
  }, [clearNewMessages]);

  const handleTranscriptScroll = useCallback((node: HTMLElement) => {
    const atBottom = isNearBottom(node);
    stickToBottomRef.current = atBottom;
    if (atBottom) {
      clearNewMessages();
    }
  }, [clearNewMessages]);

  const scrollTranscript = useCallback((mode: "bottom" | "near-bottom"): void => {
    const node = transcriptRef.current;
    if (!node) {
      return;
    }
    if (mode === "near-bottom" && !stickToBottomRef.current && !isNearBottom(node)) {
      return;
    }
    node.scrollTop = node.scrollHeight;
    stickToBottomRef.current = true;
    clearNewMessages();
  }, [clearNewMessages]);

  useEffect(() => {
    const content = transcriptContentNode;
    if (!content || typeof ResizeObserver === "undefined") {
      return undefined;
    }

    const scheduleAnchor = () => {
      if (resizeFrameRef.current !== null) {
        return;
      }
      resizeFrameRef.current = window.requestAnimationFrame(() => {
        resizeFrameRef.current = null;
        const node = transcriptRef.current;
        if (!node) {
          return;
        }
        if (!stickToBottomRef.current && !isNearBottom(node)) {
          return;
        }
        node.scrollTop = node.scrollHeight;
        stickToBottomRef.current = true;
        clearNewMessages();
      });
    };

    const observer = new ResizeObserver(scheduleAnchor);
    observer.observe(content);
    return () => {
      observer.disconnect();
      if (resizeFrameRef.current !== null) {
        window.cancelAnimationFrame(resizeFrameRef.current);
        resizeFrameRef.current = null;
      }
    };
  }, [clearNewMessages, transcriptContentNode]);

  const jumpToLatest = useCallback(() => {
    scrollTranscript("bottom");
  }, [scrollTranscript]);

  return {
    transcriptRef,
    setTranscriptContentNode,
    hasNewMessages,
    stickToBottomRef,
    clearNewMessages,
    prepareForLiveTranscriptActivity,
    handleTranscriptScroll,
    scrollTranscript,
    jumpToLatest,
  };
}
