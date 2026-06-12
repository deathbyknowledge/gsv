import { useEffect } from "preact/hooks";
import { onAppEvent } from "@gsv/package/browser";
import type {
  ContextState,
  HilRequest,
  LogRow,
  PendingAssistantState,
  ThreadContext,
  StageView,
} from "../types";
import {
  applyAssistantSignal,
  applyAssistantStreamSignal,
  applyProcessMessageSignal,
  applyToolCallSignal,
  applyToolResultSignal,
  asRecord,
  asString,
  clearTransientAssistantRowsForRun,
  normalizeContextSignal,
  normalizeHilRequest,
  signalMatchesActiveThread,
} from "../view-helpers";

type Setter<T> = (value: T | ((current: T) => T)) => void;

export function useProcessSignals({
  activeRef,
  appendSystem,
  loadArchiveSegments,
  loadConversations,
  loadHistory,
  onContextMessageId,
  prepareForLiveTranscriptActivity,
  setContextState,
  setContextStatesByConversation,
  setMessageCount,
  setActiveRunId,
  setPendingAssistant,
  setPendingHil,
  setRows,
  setSuppressNextAbortedComplete,
  suppressNextAbortedComplete,
  stageView,
}: {
  activeRef: { current: ThreadContext | null };
  appendSystem(text: string): void;
  loadArchiveSegments(preserveSelection?: boolean): Promise<void>;
  loadConversations(pid: string): Promise<void>;
  loadHistory(target?: ThreadContext | null): Promise<void>;
  onContextMessageId(target: ThreadContext, messageId: number): void;
  prepareForLiveTranscriptActivity(): void;
  setContextState: Setter<ContextState | null>;
  setContextStatesByConversation: Setter<Record<string, ContextState>>;
  setMessageCount: Setter<number>;
  setActiveRunId: Setter<string | null>;
  setPendingAssistant: Setter<PendingAssistantState>;
  setPendingHil: Setter<HilRequest | null>;
  setRows: Setter<LogRow[]>;
  setSuppressNextAbortedComplete: Setter<boolean>;
  suppressNextAbortedComplete: boolean;
  stageView: StageView;
}) {
  useEffect(() => {
    return onAppEvent((signal, payload) => {
      const target = activeRef.current;
      if (!target) {
        return;
      }
      if (signal === "proc.changed") {
        const record = asRecord(payload);
        const pid = asString(record?.pid);
        if (pid && pid !== target.pid) {
          return;
        }
        const changes = Array.isArray(record?.changes) ? record.changes.map((entry) => asString(entry)).filter(Boolean) : [];
        if (changes.includes("messages") && asString(record?.content) && signalMatchesActiveThread(payload, target)) {
          prepareForLiveTranscriptActivity();
          applyProcessMessageSignal(payload, target, setRows, setPendingAssistant);
        }
        if (changes.includes("context")) {
          const next = normalizeContextSignal(payload, target);
          if (next) {
            setContextStatesByConversation((current) => ({ ...current, [next.conversationId]: next }));
            setContextState(next);
            setMessageCount((current) => next.messageCount ?? current);
            if (typeof next.lastMessageId === "number") {
              onContextMessageId(target, next.lastMessageId);
            }
            if (next.runId && typeof next.lastMessageId === "number") {
              setRows((current) => {
                for (let index = current.length - 1; index >= 0; index -= 1) {
                  const row = current[index];
                  if (row.kind === "message" && row.role === "assistant" && row.runId === next.runId && !row.messageId) {
                    const updated = current.slice();
                    updated[index] = { ...row, messageId: next.lastMessageId };
                    return updated;
                  }
                }
                return current;
              });
            }
          }
        }
        const event = asString(record?.event);
        if (event === "conversation.compacted" || event === "conversation.forked" || event === "conversation.auto_compacted") {
          void loadConversations(target.pid);
          void loadHistory(target);
          if (event === "conversation.compacted" || event === "conversation.auto_compacted" || stageView === "archive") {
            void loadArchiveSegments(true);
          }
        }
      } else if (signal === "proc.run.started") {
        if (!signalMatchesActiveThread(payload, target)) {
          return;
        }
        const runId = asString(asRecord(payload)?.runId);
        if (runId) {
          setActiveRunId(runId);
        }
        setPendingHil(null);
        setPendingAssistant("thinking");
      } else if (signal === "proc.run.tool.started") {
        if (!signalMatchesActiveThread(payload, target)) {
          return;
        }
        const runId = asString(asRecord(payload)?.runId);
        if (runId) {
          setActiveRunId(runId);
        }
        prepareForLiveTranscriptActivity();
        setPendingHil(null);
        setPendingAssistant("tool");
        applyToolCallSignal(payload, target, setRows);
      } else if (signal === "proc.run.tool.finished") {
        if (!signalMatchesActiveThread(payload, target)) {
          return;
        }
        const runId = asString(asRecord(payload)?.runId);
        if (runId) {
          setActiveRunId(runId);
        }
        prepareForLiveTranscriptActivity();
        applyToolResultSignal(payload, target, setRows);
        setPendingAssistant("thinking");
      } else if (signal === "proc.run.output") {
        if (!signalMatchesActiveThread(payload, target)) {
          return;
        }
        const runId = asString(asRecord(payload)?.runId);
        if (runId) {
          setActiveRunId(runId);
        }
        prepareForLiveTranscriptActivity();
        applyAssistantSignal(payload, target, setRows);
        setPendingAssistant(null);
      } else if (signal === "proc.run.stream") {
        if (!signalMatchesActiveThread(payload, target)) {
          return;
        }
        const runId = asString(asRecord(payload)?.runId);
        if (runId) {
          setActiveRunId(runId);
        }
        const effect = applyAssistantStreamSignal(payload, target, setRows);
        if (effect) {
          prepareForLiveTranscriptActivity();
          setPendingAssistant(
            effect === "tool" ? "tool" : effect === "thinking" ? "thinking" : null,
          );
        }
      } else if (signal === "proc.run.retrying") {
        if (!signalMatchesActiveThread(payload, target)) {
          return;
        }
        const runId = asString(asRecord(payload)?.runId);
        if (runId) {
          setActiveRunId(runId);
          setRows((current) => clearTransientAssistantRowsForRun(current, runId));
        }
        prepareForLiveTranscriptActivity();
        setPendingHil(null);
        setPendingAssistant("thinking");
      } else if (signal === "proc.run.finished") {
        if (!signalMatchesActiveThread(payload, target)) {
          return;
        }
        const record = asRecord(payload);
        const runId = asString(record?.runId);
        if (runId) {
          setActiveRunId((current) => current === runId ? null : current);
        }
        setPendingHil(null);
        setPendingAssistant((current) => {
          if (record?.aborted === true && suppressNextAbortedComplete) {
            return current;
          }
          return null;
        });
        setSuppressNextAbortedComplete(false);
      } else if (signal === "proc.run.hil.requested") {
        if (!signalMatchesActiveThread(payload, target)) {
          return;
        }
        const runId = asString(asRecord(payload)?.runId);
        if (runId) {
          setActiveRunId(runId);
        }
        prepareForLiveTranscriptActivity();
        setPendingAssistant(null);
        setPendingHil(normalizeHilRequest(payload));
      } else if (signal === "process.exit") {
        setActiveRunId(null);
        setPendingAssistant(null);
        setPendingHil(null);
        setSuppressNextAbortedComplete(false);
      }
    });
  }, [
    activeRef,
    appendSystem,
    loadArchiveSegments,
    loadConversations,
    loadHistory,
    onContextMessageId,
    prepareForLiveTranscriptActivity,
    setContextState,
    setContextStatesByConversation,
    setMessageCount,
    setActiveRunId,
    setPendingAssistant,
    setPendingHil,
    setRows,
    setSuppressNextAbortedComplete,
    suppressNextAbortedComplete,
    stageView,
  ]);
}
