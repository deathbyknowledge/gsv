import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { useQuery, useQueryClient } from "@tanstack/preact-query";
import type {
  ConversationMessageAbortedSignal,
  ConversationMessageCommittedSignal,
  ConversationMessageDeltaSignal,
  ConversationMessageStartedSignal,
} from "@humansandmachines/gsv/protocol";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import {
  getChatConversation,
  getChatConversationHistory,
} from "../backend/chatService";
import {
  conversationDraftRow,
  conversationMessageRow,
  preserveDirectedConversationDelivery,
  type ChatConversation,
} from "../domain/conversations";
import {
  addOptimisticUserMessage,
  dropOneMatchingOptimisticUserRow,
  type ChatTranscriptRow,
} from "../domain/transcript";

const PAGE_SIZE = 50;

export const chatConversationQueryKey = (pid: string) => ["conversation", "process", pid] as const;
export const chatConversationHistoryKey = (conversationId: string) => [
  "conversation",
  "history",
  conversationId,
] as const;

type ConversationRuntime = {
  conversation: ChatConversation | null;
  rows: ChatTranscriptRow[];
  hasMore: boolean;
  loadingOlder: boolean;
  error: string;
};

const EMPTY_RUNTIME: ConversationRuntime = {
  conversation: null,
  rows: [],
  hasMore: false,
  loadingOlder: false,
  error: "",
};

function upsertRow(rows: readonly ChatTranscriptRow[], next: ChatTranscriptRow): ChatTranscriptRow[] {
  const stableNext = preserveDirectedConversationDelivery(
    rows.find((row) => row.id === next.id),
    next,
  );
  const reconciled = stableNext.role === "user"
    ? dropOneMatchingOptimisticUserRow(rows, stableNext)
    : [...rows];
  const withoutDraft = reconciled.filter((row) => (
    row.id !== stableNext.id
    && !(stableNext.runId
      && row.runId === stableNext.runId
      && row.id.startsWith("conversation-draft:"))
  ));
  return [...withoutDraft, stableNext].sort((left, right) => (
    typeof left.conversationSequence === "number"
    && typeof right.conversationSequence === "number"
      ? left.conversationSequence - right.conversationSequence
      : (left.timestamp ?? Number.MAX_SAFE_INTEGER) - (right.timestamp ?? Number.MAX_SAFE_INTEGER)
  ));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function useChatConversation(input: { enabled?: boolean; processId: string }) {
  const { client, connected } = useGateway();
  const queryClient = useQueryClient();
  const enabled = input.enabled !== false && connected && Boolean(input.processId.trim());
  const processId = input.processId.trim();
  const conversationQuery = useQuery({
    queryKey: chatConversationQueryKey(processId),
    enabled,
    queryFn: () => getChatConversation(client, processId),
  });
  const conversationId = conversationQuery.data?.conversation.id ?? "";
  const historyQuery = useQuery({
    queryKey: chatConversationHistoryKey(conversationId),
    enabled: enabled && Boolean(conversationId),
    queryFn: () => getChatConversationHistory(client, conversationId, { limit: PAGE_SIZE }),
  });
  const [runtime, setRuntime] = useState<ConversationRuntime>(EMPTY_RUNTIME);
  const runtimeRef = useRef(runtime);

  useEffect(() => {
    runtimeRef.current = runtime;
  }, [runtime]);

  useEffect(() => {
    if (!enabled) {
      setRuntime(EMPTY_RUNTIME);
      return;
    }
    const history = historyQuery.data;
    if (!history) return;
    setRuntime((current) => ({
      conversation: history.conversation,
      rows: history.messages.reduce(
        (rows, message) => upsertRow(rows, conversationMessageRow(message)),
        current.conversation?.id === history.conversation.id ? current.rows : [],
      ),
      hasMore: history.hasMore,
      loadingOlder: false,
      error: "",
    }));
  }, [enabled, historyQuery.data]);

  useEffect(() => {
    if (!enabled || !conversationId) return undefined;
    return client.onSignal((signal, payload) => {
      if (signal === "conversation.changed") {
        const record = asRecord(payload);
        if (record?.conversationId === conversationId) {
          void queryClient.invalidateQueries({ queryKey: chatConversationHistoryKey(conversationId) });
        }
        return;
      }
      if (signal === "message.committed") {
        const committed = payload as ConversationMessageCommittedSignal;
        if (committed?.message?.conversationId !== conversationId) return;
        setRuntime((current) => ({
          ...current,
          rows: upsertRow(current.rows, conversationMessageRow(committed.message, committed.directed)),
        }));
        return;
      }
      if (signal === "message.started") {
        const started = payload as ConversationMessageStartedSignal;
        if (started?.conversationId !== conversationId) return;
        setRuntime((current) => ({
          ...current,
          rows: upsertRow(current.rows, conversationDraftRow(started)),
        }));
        return;
      }
      if (signal === "message.delta") {
        const delta = payload as ConversationMessageDeltaSignal;
        if (delta?.conversationId !== conversationId) return;
        setRuntime((current) => ({
          ...current,
          rows: current.rows.map((row) => row.id === `conversation-draft:${delta.messageId}`
            ? { ...row, text: `${row.text}${delta.delta}` }
            : row),
        }));
        return;
      }
      if (signal === "message.aborted") {
        const aborted = payload as ConversationMessageAbortedSignal;
        if (aborted?.conversationId !== conversationId) return;
        setRuntime((current) => ({
          ...current,
          rows: current.rows.filter((row) => row.id !== `conversation-draft:${aborted.messageId}`),
        }));
      }
    });
  }, [client, conversationId, enabled, queryClient]);

  const appendOptimistic = useCallback((text: string, media: unknown[] = []) => {
    setRuntime((current) => ({
      ...current,
      rows: addOptimisticUserMessage({
        activeRunId: null,
        context: null,
        messageCount: current.rows.length,
        pendingHil: null,
        rows: current.rows,
        runState: "idle",
      }, text, media).rows,
    }));
  }, []);

  const loadOlder = useCallback(async () => {
    const current = runtimeRef.current;
    const oldestSequence = current.rows.reduce<number | null>((oldest, row) => {
      const sequence = row.conversationSequence;
      return typeof sequence === "number" ? Math.min(oldest ?? sequence, sequence) : oldest;
    }, null);
    if (!conversationId || !current.hasMore || current.loadingOlder || oldestSequence === null) return;
    setRuntime({ ...current, loadingOlder: true, error: "" });
    try {
      const history = await getChatConversationHistory(client, conversationId, {
        beforeSequence: oldestSequence,
        limit: PAGE_SIZE,
      });
      setRuntime((latest) => ({
        ...latest,
        rows: history.messages.reduce(
          (rows, message) => upsertRow(rows, conversationMessageRow(message)),
          latest.rows,
        ),
        hasMore: history.hasMore,
        loadingOlder: false,
      }));
    } catch (error) {
      setRuntime((latest) => ({
        ...latest,
        loadingOlder: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }, [client, conversationId]);

  const visibleRuntime = runtime.conversation?.id === conversationId
    ? runtime
    : EMPTY_RUNTIME;

  return useMemo(() => ({
    ...visibleRuntime,
    appendOptimistic,
    historyLoading: conversationQuery.isLoading || historyQuery.isLoading,
    historyError: conversationQuery.error ?? historyQuery.error,
    loadOlder,
  }), [
    appendOptimistic,
    conversationQuery.error,
    conversationQuery.isLoading,
    historyQuery.error,
    historyQuery.isLoading,
    loadOlder,
    visibleRuntime,
  ]);
}
