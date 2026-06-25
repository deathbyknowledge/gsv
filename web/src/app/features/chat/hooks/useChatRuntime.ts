import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { useQueryClient } from "@tanstack/preact-query";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { getChatHistory } from "../backend/chatService";
import type { ChatHistory } from "../domain/processes";
import {
  addOptimisticUserMessage,
  applyChatSignal,
  chatRuntimeStateFromHistory,
  emptyChatRuntimeState,
  transcriptRowsFromHistory,
  type ChatTranscriptRow,
  type ChatRuntimeState,
} from "../domain/transcript";
import {
  chatProcessHistoryQueryKeyRoot,
  useChatProcessHistory,
} from "./useChatProcesses";

type UseChatRuntimeOptions = {
  conversationId?: string | null;
  enabled?: boolean;
  processId: string;
};

type ChatHistoryWindow = {
  error: string;
  hasMoreBefore: boolean;
  loadingOlder: boolean;
  oldestMessageId: number | null;
  targetKey: string;
};

const HISTORY_PAGE_SIZE = 50;
const DEFAULT_CONVERSATION_ID = "default";
const OPTIMISTIC_USER_MATCH_WINDOW_MS = 5 * 60 * 1000;

const EMPTY_HISTORY_WINDOW: ChatHistoryWindow = {
  error: "",
  hasMoreBefore: false,
  loadingOlder: false,
  oldestMessageId: null,
  targetKey: "",
};

function historyStateKey(state: ChatRuntimeState): string {
  return [
    state.conversationId ?? "",
    state.messageCount,
    state.activeRunId ?? "",
    state.pendingHil?.requestId ?? "",
    state.context?.updatedAt ?? "",
  ].join(":");
}

function historyTargetKey(pid: string, conversationId: string | null | undefined): string {
  return `${pid}\n${conversationId || DEFAULT_CONVERSATION_ID}`;
}

function firstHistoryMessageId(history: ChatHistory | null): number | null {
  return history?.messages.find((message) => typeof message.id === "number")?.id ?? null;
}

function rowMergeKey(row: ChatTranscriptRow): string {
  if ((row.role === "tool" || row.role === "toolResult") && row.toolCallId) {
    return `tool:${row.toolCallId}`;
  }
  if (typeof row.messageId === "number") {
    return `message:${row.messageId}:${row.role ?? "message"}`;
  }
  if (row.role === "assistant" && row.runId && !row.id.startsWith("message:")) {
    return `assistant:${row.runId}`;
  }
  return row.id;
}

function rowSortValue(row: ChatTranscriptRow): number {
  if (typeof row.messageId === "number") {
    return row.messageId * 1000;
  }
  if (typeof row.timestamp === "number" && Number.isFinite(row.timestamp)) {
    return row.timestamp;
  }
  return Number.MAX_SAFE_INTEGER;
}

function isOptimisticUserRow(row: ChatTranscriptRow): boolean {
  return row.role === "user" && row.id.startsWith("optimistic:user:");
}

function isPersistedUserRow(row: ChatTranscriptRow): boolean {
  return row.role === "user" && !row.id.startsWith("optimistic:user:");
}

function isTransientAssistantRow(row: ChatTranscriptRow): boolean {
  return row.role === "assistant"
    && Boolean(row.runId)
    && !row.id.startsWith("message:");
}

function isPersistedAssistantRow(row: ChatTranscriptRow): boolean {
  return row.role === "assistant"
    && Boolean(row.runId)
    && row.id.startsWith("message:");
}

function rowMediaCount(row: ChatTranscriptRow): number {
  return Array.isArray(row.media) ? row.media.length : 0;
}

function timestampCloseEnough(left: number | null | undefined, right: number | null | undefined): boolean {
  if (
    typeof left !== "number"
    || !Number.isFinite(left)
    || typeof right !== "number"
    || !Number.isFinite(right)
  ) {
    return true;
  }
  return Math.abs(left - right) <= OPTIMISTIC_USER_MATCH_WINDOW_MS;
}

function isMatchingPersistedUserRow(
  optimistic: ChatTranscriptRow,
  persisted: ChatTranscriptRow,
): boolean {
  return optimistic.text === persisted.text
    && rowMediaCount(optimistic) === rowMediaCount(persisted)
    && timestampCloseEnough(optimistic.timestamp, persisted.timestamp);
}

function removeMatchedOptimisticUserRows(
  currentRows: readonly ChatTranscriptRow[],
  nextRows: readonly ChatTranscriptRow[],
): ChatTranscriptRow[] {
  const persistedUserRows = nextRows.filter(isPersistedUserRow);
  if (persistedUserRows.length === 0) {
    return [...currentRows];
  }
  return currentRows.filter((row) => {
    if (!isOptimisticUserRow(row)) {
      return true;
    }
    const persistedIndex = persistedUserRows.findIndex((persisted) =>
      isMatchingPersistedUserRow(row, persisted),
    );
    if (persistedIndex === -1) {
      return true;
    }
    persistedUserRows.splice(persistedIndex, 1);
    return false;
  });
}

function removeMatchedTransientAssistantRows(
  currentRows: readonly ChatTranscriptRow[],
  nextRows: readonly ChatTranscriptRow[],
): ChatTranscriptRow[] {
  const persistedRunIds = new Set(
    nextRows
      .filter(isPersistedAssistantRow)
      .map((row) => row.runId)
      .filter((runId): runId is string => Boolean(runId)),
  );
  if (persistedRunIds.size === 0) {
    return [...currentRows];
  }
  return currentRows.filter((row) => (
    !isTransientAssistantRow(row) || !row.runId || !persistedRunIds.has(row.runId)
  ));
}

function reconcileTransientRows(
  currentRows: readonly ChatTranscriptRow[],
  nextRows: readonly ChatTranscriptRow[],
): ChatTranscriptRow[] {
  return removeMatchedTransientAssistantRows(
    removeMatchedOptimisticUserRows(currentRows, nextRows),
    nextRows,
  );
}

function mergeTranscriptRows(
  currentRows: readonly ChatTranscriptRow[],
  nextRows: readonly ChatTranscriptRow[],
): ChatTranscriptRow[] {
  const reconciledCurrentRows = reconcileTransientRows(currentRows, nextRows);
  const order = new Map<string, number>();
  const merged = new Map<string, ChatTranscriptRow>();
  let index = 0;

  for (const row of reconciledCurrentRows) {
    const key = rowMergeKey(row);
    if (!order.has(key)) {
      order.set(key, index);
      index += 1;
    }
    merged.set(key, row);
  }
  for (const row of nextRows) {
    const key = rowMergeKey(row);
    if (!order.has(key)) {
      order.set(key, index);
      index += 1;
    }
    merged.set(key, row);
  }

  return Array.from(merged.entries())
    .sort(([leftKey, left], [rightKey, right]) => {
      const bySortValue = rowSortValue(left) - rowSortValue(right);
      return bySortValue || (order.get(leftKey) ?? 0) - (order.get(rightKey) ?? 0);
    })
    .map(([, row]) => row);
}

function mergeHistoryRuntime(
  current: ChatRuntimeState,
  next: ChatRuntimeState,
  targetKey: string,
  currentTargetKey: string,
): ChatRuntimeState {
  if (
    currentTargetKey !== targetKey
    || (current.conversationId || DEFAULT_CONVERSATION_ID) !== (next.conversationId || DEFAULT_CONVERSATION_ID)
  ) {
    return next;
  }
  return {
    ...next,
    rows: mergeTranscriptRows(current.rows, next.rows),
  };
}

function historyWindowFromHistory(
  history: ChatHistory,
  targetKey: string,
): ChatHistoryWindow {
  return {
    error: "",
    hasMoreBefore: history.hasMoreBefore,
    loadingOlder: false,
    oldestMessageId: firstHistoryMessageId(history),
    targetKey,
  };
}

function refreshChatRuntimeQueries(queryClient: ReturnType<typeof useQueryClient>): void {
  void queryClient.invalidateQueries({ queryKey: ["processes"] });
  void queryClient.invalidateQueries({ queryKey: chatProcessHistoryQueryKeyRoot });
  void queryClient.invalidateQueries({ queryKey: ["process", "chat", "conversations"] });
  void queryClient.invalidateQueries({ queryKey: ["process", "chat", "conversation-segments"] });
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  if (typeof error === "string" && error.trim()) {
    return error;
  }
  return "History could not be loaded.";
}

export function useChatRuntime({
  conversationId = null,
  enabled = true,
  processId,
}: UseChatRuntimeOptions) {
  const { client, connected } = useGateway();
  const queryClient = useQueryClient();
  const hasProcess = processId.trim().length > 0;
  const selectedConversationId = conversationId || DEFAULT_CONVERSATION_ID;
  const targetKey = historyTargetKey(processId, selectedConversationId);
  const history = useChatProcessHistory({
    enabled: enabled && hasProcess,
    args: hasProcess
      ? {
          pid: processId,
          conversationId: selectedConversationId,
          limit: HISTORY_PAGE_SIZE,
          tail: true,
        }
      : {},
  });
  const [runtime, setRuntime] = useState<ChatRuntimeState>(() =>
    emptyChatRuntimeState(processId, conversationId),
  );
  const [historyWindow, setHistoryWindow] = useState<ChatHistoryWindow>(EMPTY_HISTORY_WINDOW);
  const historyWindowRef = useRef(historyWindow);
  const runtimeRef = useRef(runtime);
  const runtimeTargetKeyRef = useRef(targetKey);
  const refetchHistory = history.refetch;

  const historyRuntime = useMemo(
    () => chatRuntimeStateFromHistory(history.data ?? null),
    [history.data],
  );
  const historyKey = historyStateKey(historyRuntime);

  useEffect(() => {
    historyWindowRef.current = historyWindow;
  }, [historyWindow]);

  useEffect(() => {
    runtimeRef.current = runtime;
  }, [runtime]);

  useEffect(() => {
    if (!hasProcess) {
      runtimeTargetKeyRef.current = targetKey;
      setRuntime(emptyChatRuntimeState(processId, conversationId));
      setHistoryWindow(EMPTY_HISTORY_WINDOW);
      return;
    }
    if (history.data) {
      const currentTargetKey = runtimeTargetKeyRef.current;
      runtimeTargetKeyRef.current = targetKey;
      setRuntime((current) => mergeHistoryRuntime(current, historyRuntime, targetKey, currentTargetKey));
      setHistoryWindow(historyWindowFromHistory(history.data, targetKey));
      return;
    }
    runtimeTargetKeyRef.current = targetKey;
    setRuntime(emptyChatRuntimeState(processId, conversationId));
    setHistoryWindow({ ...EMPTY_HISTORY_WINDOW, targetKey });
  }, [conversationId, hasProcess, history.data, historyKey, historyRuntime, processId, targetKey]);

  useEffect(() => {
    if (!enabled || !connected || !hasProcess) {
      return undefined;
    }

    return client.onSignal((signal, payload) => {
      const current = runtimeRef.current;
      const reduction = applyChatSignal(current, signal, payload, {
        conversationId: current.conversationId ?? conversationId,
        pid: processId,
      });
      if (!reduction.matched) {
        return;
      }
      runtimeRef.current = reduction.state;
      setRuntime(reduction.state);
      if (reduction.refreshHistory) {
        refreshChatRuntimeQueries(queryClient);
        void refetchHistory();
      }
    });
  }, [client, connected, conversationId, enabled, hasProcess, processId, queryClient, refetchHistory]);

  const appendOptimisticUserMessage = useCallback((message: string, media: unknown[] = []) => {
    setRuntime((current) => addOptimisticUserMessage(
      current,
      message,
      current.conversationId ?? conversationId,
      media,
    ));
  }, [conversationId]);

  const loadOlderHistory = useCallback(async () => {
    const currentWindow = historyWindowRef.current;
    if (
      !enabled ||
      !connected ||
      !hasProcess ||
      currentWindow.loadingOlder ||
      !currentWindow.hasMoreBefore ||
      currentWindow.oldestMessageId === null ||
      currentWindow.targetKey !== targetKey
    ) {
      return;
    }

    setHistoryWindow({ ...currentWindow, error: "", loadingOlder: true });
    try {
      const olderHistory = await getChatHistory(client, {
        pid: processId,
        conversationId: selectedConversationId,
        limit: HISTORY_PAGE_SIZE,
        beforeMessageId: currentWindow.oldestMessageId,
      });
      if (historyWindowRef.current.targetKey !== targetKey) {
        return;
      }
      setRuntime((current) => ({
        ...current,
        context: olderHistory.context ?? current.context,
        messageCount: olderHistory.messageCount,
        rows: mergeTranscriptRows(transcriptRowsFromHistory(olderHistory), current.rows),
      }));
      setHistoryWindow({
        error: "",
        hasMoreBefore: olderHistory.hasMoreBefore,
        loadingOlder: false,
        oldestMessageId: firstHistoryMessageId(olderHistory) ?? currentWindow.oldestMessageId,
        targetKey,
      });
    } catch (error) {
      if (historyWindowRef.current.targetKey !== targetKey) {
        return;
      }
      setHistoryWindow({
        ...currentWindow,
        error: errorMessage(error),
        loadingOlder: false,
      });
    }
  }, [client, connected, enabled, hasProcess, processId, selectedConversationId, targetKey]);

  return {
    appendOptimisticUserMessage,
    hasOlderHistory: historyWindow.hasMoreBefore,
    history,
    historyError: historyWindow.error,
    loadOlderHistory,
    loadingOlderHistory: historyWindow.loadingOlder,
    runtime,
  };
}
