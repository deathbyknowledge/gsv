import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { useQuery, useQueryClient } from "@tanstack/preact-query";
import type {
  ConversationMessageOrigin,
} from "@humansandmachines/gsv/protocol";
import type { GSVClient } from "@humansandmachines/gsv/client";
import { z } from "zod";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import {
  getChatConversation,
  getChatConversationHistory,
  type ChatConversationGsvClient,
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

const mediaInputSchema = z.object({
  type: z.enum(["image", "audio", "video", "document"]),
  mimeType: z.string(),
  key: z.string().optional(),
  conversationId: z.string().optional(),
  path: z.string().optional(),
  url: z.string().optional(),
  filename: z.string().optional(),
  size: z.number().optional(),
  duration: z.number().optional(),
  transcription: z.string().optional(),
});
const originSchema: z.ZodType<ConversationMessageOrigin> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("client"), clientId: z.string().optional(), platform: z.string().optional() }),
  z.object({
    kind: z.literal("adapter"), adapter: z.string(), accountId: z.string(), actorId: z.string(),
    surface: z.object({ kind: z.enum(["dm", "group", "channel", "thread"]), id: z.string(), threadId: z.string().optional() }),
    providerMessageId: z.string().optional(),
  }),
  z.object({ kind: z.literal("process"), pid: z.string(), runId: z.string() }),
  z.object({ kind: z.literal("device"), deviceId: z.string() }),
  z.object({ kind: z.literal("scheduler"), scheduleId: z.string() }),
  z.object({ kind: z.literal("mail"), messageId: z.string() }),
]);
const messageSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  sequence: z.number(),
  author: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("user"), uid: z.number() }),
    z.object({ kind: z.literal("process"), pid: z.string(), uid: z.number() }),
  ]),
  text: z.string(),
  media: z.array(mediaInputSchema).optional(),
  origin: originSchema,
  processId: z.string().optional(),
  runId: z.string().optional(),
  createdAt: z.number(),
});
const changedSignalSchema = z.object({ conversationId: z.string() });
const committedSignalSchema = z.object({ message: messageSchema, directed: z.boolean() });
const startedSignalSchema = z.object({
  conversationId: z.string(), messageId: z.string(), processId: z.string(), runId: z.string(), timestamp: z.number(),
});
const deltaSignalSchema = startedSignalSchema.extend({ delta: z.string() });
const abortedSignalSchema = startedSignalSchema.extend({ reason: z.string() });

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
    z.number().safeParse(left.conversationSequence).success
    && z.number().safeParse(right.conversationSequence).success
      ? (left.conversationSequence ?? 0) - (right.conversationSequence ?? 0)
      : (left.timestamp ?? Number.MAX_SAFE_INTEGER) - (right.timestamp ?? Number.MAX_SAFE_INTEGER)
  ));
}

export type ChatConversationRuntimeGateway = {
  client: ChatConversationGsvClient & Pick<GSVClient, "onSignal">;
  connected: boolean;
};

export function useChatConversation(input: { enabled?: boolean; processId: string }) {
  return useChatConversationRuntime(input, useGateway());
}

export function useChatConversationRuntime(
  input: { enabled?: boolean; processId: string },
  gateway: ChatConversationRuntimeGateway,
) {
  const { client, connected } = gateway;
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
  runtimeRef.current = runtime;

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
        const changed = changedSignalSchema.safeParse(payload);
        if (changed.success && changed.data.conversationId === conversationId) {
          void queryClient.invalidateQueries({ queryKey: chatConversationHistoryKey(conversationId) });
        }
        return;
      }
      if (signal === "message.committed") {
        const committed = committedSignalSchema.safeParse(payload);
        if (!committed.success || committed.data.message.conversationId !== conversationId) return;
        setRuntime((current) => ({
          ...current,
          rows: upsertRow(current.rows, conversationMessageRow(committed.data.message, committed.data.directed)),
        }));
        return;
      }
      if (signal === "message.started") {
        const started = startedSignalSchema.safeParse(payload);
        if (!started.success || started.data.conversationId !== conversationId) return;
        setRuntime((current) => ({
          ...current,
          rows: upsertRow(current.rows, conversationDraftRow(started.data)),
        }));
        return;
      }
      if (signal === "message.delta") {
        const delta = deltaSignalSchema.safeParse(payload);
        if (!delta.success || delta.data.conversationId !== conversationId) return;
        setRuntime((current) => ({
          ...current,
          rows: current.rows.map((row) => row.id === `conversation-draft:${delta.data.messageId}`
            ? { ...row, text: `${row.text}${delta.data.delta}` }
            : row),
        }));
        return;
      }
      if (signal === "message.aborted") {
        const aborted = abortedSignalSchema.safeParse(payload);
        if (!aborted.success || aborted.data.conversationId !== conversationId) return;
        setRuntime((current) => ({
          ...current,
          rows: current.rows.filter((row) => row.id !== `conversation-draft:${aborted.data.messageId}`),
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
      const parsed = z.number().safeParse(sequence);
      return parsed.success ? Math.min(oldest ?? parsed.data, parsed.data) : oldest;
    }, null);
    if (
      !conversationId
      || current.conversation?.id !== conversationId
      || !current.hasMore
      || current.loadingOlder
      || oldestSequence === null
    ) return;
    setRuntime({ ...current, loadingOlder: true, error: "" });
    try {
      const history = await getChatConversationHistory(client, conversationId, {
        beforeSequence: oldestSequence,
        limit: PAGE_SIZE,
      });
      setRuntime((latest) => latest.conversation?.id === conversationId
        ? {
            ...latest,
            rows: history.messages.reduce(
              (rows, message) => upsertRow(rows, conversationMessageRow(message)),
              latest.rows,
            ),
            hasMore: history.hasMore,
            loadingOlder: false,
          }
        : latest);
    } catch (error) {
      setRuntime((latest) => latest.conversation?.id === conversationId
        ? {
            ...latest,
            loadingOlder: false,
            error: error instanceof Error ? error.message : String(error),
          }
        : latest);
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
