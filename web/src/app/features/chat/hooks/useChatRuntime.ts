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
  enabled?: boolean;
  historyLimit?: number;
  observe?: boolean;
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
    state.messageCount,
    state.activeRunId ?? "",
    state.pendingHil?.requestId ?? "",
    state.context?.updatedAt ?? "",
  ].join(":");
}

function historyTargetKey(pid: string, includeActivity: boolean): string {
  return `${pid}:${includeActivity ? "activity" : "status"}`;
}

function firstHistoryMessageId(history: ChatHistory | null): number | null {
  return history?.messages[0]?.id ?? null;
}

function rowMergeKey(row: ChatTranscriptRow): string {
  if ((row.role === "tool" || row.role === "toolResult") && row.toolCallId) {
    return row.runId ? `tool:${row.runId}:${row.toolCallId}` : `tool:${row.toolCallId}`;
  }
  if (row.messageId !== null && row.messageId !== undefined) {
    return `message:${row.messageId}:${row.role ?? "message"}`;
  }
  if (row.role === "assistant" && row.runId && !row.id.startsWith("message:")) {
    return `assistant:${row.runId}`;
  }
  return row.id;
}

function rowSortValue(row: ChatTranscriptRow): number {
  if (row.timestamp !== null && row.timestamp !== undefined && Number.isFinite(row.timestamp)) {
    return row.timestamp;
  }
  if (row.messageId !== null && row.messageId !== undefined) {
    return Number(row.messageId);
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

function isToolActivityRow(row: ChatTranscriptRow): boolean {
  return row.role === "tool" || row.role === "toolResult";
}

function isStreamFallbackToolRow(row: ChatTranscriptRow): boolean {
  const runId = row.runId;
  const toolCallId = row.toolCallId;
  if (!runId || !toolCallId) {
    return false;
  }
  return row.role === "tool"
    && row.status === "planning"
    && toolCallId.startsWith(`${runId}:tool:`);
}

function isConcreteToolRow(row: ChatTranscriptRow): boolean {
  return isToolActivityRow(row)
    && Boolean(row.runId)
    && Boolean(row.toolCallId)
    && !isStreamFallbackToolRow(row);
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
    left === null
    || left === undefined
    || !Number.isFinite(left)
    || right === null
    || right === undefined
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

function removeSupersededStreamToolRows(
  currentRows: readonly ChatTranscriptRow[],
  nextRows: readonly ChatTranscriptRow[],
): ChatTranscriptRow[] {
  const runsWithConcreteTools = new Set(
    nextRows
      .filter(isConcreteToolRow)
      .map((row) => row.runId)
      .filter((runId): runId is string => Boolean(runId)),
  );
  if (runsWithConcreteTools.size === 0) {
    return [...currentRows];
  }
  return currentRows.filter((row) => (
    !isStreamFallbackToolRow(row) || !row.runId || !runsWithConcreteTools.has(row.runId)
  ));
}

function reconcileTransientRows(
  currentRows: readonly ChatTranscriptRow[],
  nextRows: readonly ChatTranscriptRow[],
): ChatTranscriptRow[] {
  return removeSupersededStreamToolRows(
    removeMatchedTransientAssistantRows(
      removeMatchedOptimisticUserRows(currentRows, nextRows),
      nextRows,
    ),
    nextRows,
  );
}

function shouldKeepCurrentToolRow(current: ChatTranscriptRow, next: ChatTranscriptRow): boolean {
  const sameRun = current.runId || next.runId
    ? current.runId === next.runId
    : true;
  return isConcreteToolRow(current)
    && sameRun
    && current.status !== "planning"
    && next.role === "tool"
    && next.status === "planning"
    && current.toolCallId === next.toolCallId;
}

export function mergeTranscriptRows(
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
    const current = merged.get(key);
    if (current && shouldKeepCurrentToolRow(current, row)) {
      continue;
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
  if (currentTargetKey !== targetKey) {
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
  void queryClient.invalidateQueries({ queryKey: ["process", "chat", "history-segments"] });
}

function errorMessage(error: Error | string | null): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  if (error !== null && !(error instanceof Error) && error.trim()) {
    return error;
  }
  return "History could not be loaded.";
}

export function useChatRuntime({
  enabled = true,
  historyLimit = HISTORY_PAGE_SIZE,
  observe = false,
  processId,
}: UseChatRuntimeOptions) {
  const { client, connected } = useGateway();
  const queryClient = useQueryClient();
  const hasProcess = processId.trim().length > 0;
  const targetKey = historyTargetKey(processId, observe);
  const history = useChatProcessHistory({
    enabled: enabled && hasProcess,
    args: hasProcess
        ? {
          pid: processId,
          includeMessages: observe,
          limit: historyLimit,
          tail: true,
        }
      : {},
  });
  const [runtime, setRuntime] = useState<ChatRuntimeState>(() =>
    emptyChatRuntimeState(processId),
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
      setRuntime(emptyChatRuntimeState(processId));
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
    setRuntime(emptyChatRuntimeState(processId));
    setHistoryWindow({ ...EMPTY_HISTORY_WINDOW, targetKey });
  }, [hasProcess, history.data, historyKey, historyRuntime, processId, targetKey]);

  useEffect(() => {
    if (!enabled || !connected || !hasProcess) {
      return undefined;
    }

    let active = true;
    let observing = false;
    const observation = observe
      ? client.proc.observe({ pid: processId })
        .then(() => {
          if (!active) {
            return client.proc.unobserve({ pid: processId }).then(() => undefined);
          }
          observing = true;
          return undefined;
        })
        .catch(() => undefined)
      : Promise.resolve();

    const unsubscribe = client.onSignal((signal, payload) => {
      const current = runtimeRef.current;
      const reduction = applyChatSignal(current, signal, payload, {
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
    return () => {
      active = false;
      unsubscribe();
      if (observing) {
        void client.proc.unobserve({ pid: processId }).catch(() => undefined);
      } else {
        void observation;
      }
    };
  }, [client, connected, enabled, hasProcess, observe, processId, queryClient, refetchHistory]);

  const appendOptimisticUserMessage = useCallback((message: string, media: unknown[] = []) => {
    setRuntime((current) => addOptimisticUserMessage(
      current,
      message,
      media,
    ));
  }, []);

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
        error: errorMessage(error instanceof Error ? error : error ? String(error) : null),
        loadingOlder: false,
      });
    }
  }, [client, connected, enabled, hasProcess, processId, targetKey]);

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
