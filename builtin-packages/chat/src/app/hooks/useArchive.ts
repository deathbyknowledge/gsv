import { useCallback, useState } from "preact/hooks";
import type { ArchiveState, ChatBackend, ConversationSegment, ThreadContext } from "../types";
import {
  asNumber,
  asRecord,
  formatError,
  normalizeConversationSegment,
  safeText,
} from "../view-helpers";

export const EMPTY_ARCHIVE: ArchiveState = {
  loading: false,
  error: "",
  segments: [],
  selectedSegmentId: null,
  messages: [],
  messageCount: 0,
  truncated: false,
};

export function useArchive({
  backend,
  activeRef,
}: {
  backend: ChatBackend;
  activeRef: { current: ThreadContext | null };
}) {
  const [archive, setArchive] = useState<ArchiveState>(EMPTY_ARCHIVE);

  const resetArchive = useCallback(() => {
    setArchive(EMPTY_ARCHIVE);
  }, []);

  const readArchiveSegment = useCallback(async (segmentId: string) => {
    const target = activeRef.current;
    if (!target?.pid || !segmentId) {
      return;
    }
    setArchive((current) => ({
      ...current,
      loading: true,
      error: "",
      selectedSegmentId: segmentId,
      messages: [],
      messageCount: 0,
      truncated: false,
    }));
    try {
      const result = await backend.readConversationSegment({
        pid: target.pid,
        conversationId: target.conversationId || "default",
        segmentId,
        limit: 100,
      });
      const record = asRecord(result);
      if (!record?.ok) {
        setArchive((current) => ({ ...current, loading: false, error: safeText(record?.error || "segment read failed") }));
        return;
      }
      const messages = Array.isArray(record.messages) ? record.messages : [];
      setArchive((current) => ({
        ...current,
        loading: false,
        error: "",
        selectedSegmentId: segmentId,
        messages,
        messageCount: asNumber(record.messageCount) ?? messages.length,
        truncated: record.truncated === true,
      }));
    } catch (error) {
      setArchive((current) => ({ ...current, loading: false, error: formatError(error) }));
    }
  }, [activeRef, backend]);

  const loadArchiveSegments = useCallback(async (preserveSelection = true) => {
    const target = activeRef.current;
    if (!target?.pid) {
      resetArchive();
      return;
    }
    setArchive((current) => ({ ...current, loading: true, error: "" }));
    try {
      const result = await backend.listConversationSegments({
        pid: target.pid,
        conversationId: target.conversationId || "default",
      });
      const record = asRecord(result);
      if (!record?.ok) {
        setArchive((current) => ({ ...current, loading: false, error: safeText(record?.error || "archive load failed"), segments: [] }));
        return;
      }
      const segments = (Array.isArray(record.segments) ? record.segments : [])
        .map(normalizeConversationSegment)
        .filter(Boolean)
        .reverse() as ConversationSegment[];
      let selected = preserveSelection ? archive.selectedSegmentId : null;
      if (!selected || !segments.some((segment) => segment.id === selected)) {
        selected = segments[0]?.id ?? null;
      }
      setArchive((current) => {
        return {
          ...current,
          loading: false,
          error: "",
          segments,
          selectedSegmentId: selected,
          messages: selected ? current.messages : [],
          messageCount: selected ? current.messageCount : 0,
          truncated: selected ? current.truncated : false,
        };
      });
      if (selected) {
        await readArchiveSegment(selected);
      }
    } catch (error) {
      setArchive((current) => ({ ...current, loading: false, error: formatError(error), segments: [] }));
    }
  }, [activeRef, archive.selectedSegmentId, backend, readArchiveSegment, resetArchive]);

  return {
    archive,
    loadArchiveSegments,
    readArchiveSegment,
    resetArchive,
  };
}
