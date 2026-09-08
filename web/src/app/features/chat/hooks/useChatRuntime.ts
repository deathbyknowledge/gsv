import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { useQueryClient } from "@tanstack/preact-query";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import { getProcessHistorySync } from "../backend/historySync";
import { emptyChatRuntimeState } from "../domain/transcript";
import { useChatProcessHistory } from "./useChatProcesses";

export { mergeTranscriptRows } from "../domain/transcriptMerge";

type UseChatRuntimeOptions = {
  enabled?: boolean;
  historyLimit?: number;
  observe?: boolean;
  processId: string;
};

const HISTORY_PAGE_SIZE = 50;

export function useChatRuntime({
  enabled = true,
  historyLimit = HISTORY_PAGE_SIZE,
  observe = false,
  processId,
}: UseChatRuntimeOptions) {
  const { client, connected } = useGateway();
  const queries = useQueryClient();
  const sync = getProcessHistorySync(client, queries);
  const history = useChatProcessHistory({
    enabled,
    args: { pid: processId, limit: historyLimit },
    observe,
  });
  const empty = useMemo(() => emptyChatRuntimeState(processId), [processId]);
  const currentProcess = useRef(processId);
  currentProcess.current = processId;
  const [loadingOlderHistory, setLoadingOlderHistory] = useState(false);
  const [historyError, setHistoryError] = useState("");
  useEffect(() => {
    setLoadingOlderHistory(false);
    setHistoryError("");
  }, [processId]);

  const appendOptimisticUserMessage = useCallback((message: string, media: unknown[] = []) => {
    sync.appendOptimistic(processId, message, media);
  }, [processId, sync]);
  const oldest = history.data?.records[0]?.messageId;
  const hasOlderHistory = history.data?.hasMoreBefore === true;
  const loadOlderHistory = useCallback(async () => {
    if (!enabled || !connected || !hasOlderHistory || oldest === undefined || loadingOlderHistory) return;
    setLoadingOlderHistory(true);
    setHistoryError("");
    try {
      await sync.loadOlder(processId, oldest, HISTORY_PAGE_SIZE);
    } catch (error) {
      if (currentProcess.current !== processId) return;
      setHistoryError(error instanceof Error ? error.message : "History could not be loaded.");
    } finally {
      if (currentProcess.current === processId) setLoadingOlderHistory(false);
    }
  }, [connected, enabled, hasOlderHistory, loadingOlderHistory, oldest, processId, sync]);

  return {
    appendOptimisticUserMessage,
    hasOlderHistory,
    history,
    historyError,
    loadOlderHistory,
    loadingOlderHistory,
    runtime: history.data?.runtime ?? empty,
  };
}
