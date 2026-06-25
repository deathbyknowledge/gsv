import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import {
  addOptimisticUserMessage,
  applyChatSignal,
  chatRuntimeStateFromHistory,
  emptyChatRuntimeState,
  type ChatRuntimeState,
} from "../domain/transcript";
import { useChatProcessHistory } from "./useChatProcesses";

type UseChatRuntimeOptions = {
  conversationId?: string | null;
  enabled?: boolean;
  processId: string;
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

export function useChatRuntime({
  conversationId = null,
  enabled = true,
  processId,
}: UseChatRuntimeOptions) {
  const { client, connected } = useGateway();
  const hasProcess = processId.trim().length > 0;
  const history = useChatProcessHistory({
    enabled: enabled && hasProcess,
    args: hasProcess
      ? {
          pid: processId,
          ...(conversationId ? { conversationId } : {}),
        }
      : {},
  });
  const [runtime, setRuntime] = useState<ChatRuntimeState>(() =>
    emptyChatRuntimeState(processId, conversationId),
  );

  const historyRuntime = useMemo(
    () => chatRuntimeStateFromHistory(history.data ?? null),
    [history.data],
  );
  const historyKey = historyStateKey(historyRuntime);

  useEffect(() => {
    if (!hasProcess) {
      setRuntime(emptyChatRuntimeState(processId, conversationId));
      return;
    }
    if (history.data) {
      setRuntime(historyRuntime);
      return;
    }
    setRuntime(emptyChatRuntimeState(processId, conversationId));
  }, [conversationId, hasProcess, history.data, historyKey, historyRuntime, processId]);

  useEffect(() => {
    if (!enabled || !connected || !hasProcess) {
      return undefined;
    }

    return client.onSignal((signal, payload) => {
      setRuntime((current) => {
        const reduction = applyChatSignal(current, signal, payload, {
          conversationId: current.conversationId ?? conversationId,
          pid: processId,
        });
        return reduction.matched ? reduction.state : current;
      });
    });
  }, [client, connected, conversationId, enabled, hasProcess, processId]);

  const appendOptimisticUserMessage = useCallback((message: string, media: unknown[] = []) => {
    setRuntime((current) => addOptimisticUserMessage(
      current,
      message,
      current.conversationId ?? conversationId,
      media,
    ));
  }, [conversationId]);

  return {
    appendOptimisticUserMessage,
    history,
    runtime,
  };
}
