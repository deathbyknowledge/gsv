import { useMutation, useQuery, useQueryClient } from "@tanstack/preact-query";
import type {
  ProcAbortArgs,
  ProcAiConfigSetArgs,
  ProcConversationCompactArgs,
  ProcConversationForkArgs,
  ProcConversationListArgs,
  ProcConversationSegmentReadArgs,
  ProcConversationSegmentsArgs,
  ProcHilArgs,
  ProcHistoryArgs,
  ProcListArgs,
  ProcMediaReadArgs,
  ProcSpawnArgs,
} from "@humansandmachines/gsv/protocol";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import {
  abortChatProcess,
  compactChatConversation,
  decideChatHil,
  forkChatConversation,
  getChatProcessAiConfig,
  getChatHistory,
  listChatConversationSegments,
  listChatConversations,
  listChatProcesses,
  readChatProcessMedia,
  readChatConversationSegment,
  sendChatMessage,
  setChatProcessAiConfig,
  spawnChatProcess,
} from "../backend/chatService";
import type { ChatSendDraft } from "../domain/processes";

export const chatProcessListQueryKey = (args: ProcListArgs = {}) => [
  "processes",
  "chat",
  args,
] as const;

export const chatProcessHistoryQueryKey = (args: ProcHistoryArgs = {}) => [
  "process",
  "chat",
  "history",
  args,
] as const;

export const chatProcessHistoryQueryKeyRoot = ["process", "chat", "history"] as const;

export const chatProcessMediaQueryKey = (args: ProcMediaReadArgs) => [
  "process",
  "chat",
  "media",
  args,
] as const;

export const chatConversationListQueryKey = (args: ProcConversationListArgs = {}) => [
  "process",
  "chat",
  "conversations",
  args,
] as const;

export const chatConversationSegmentsQueryKey = (args: ProcConversationSegmentsArgs = {}) => [
  "process",
  "chat",
  "conversation-segments",
  args,
] as const;

export const chatConversationSegmentQueryKey = (args: ProcConversationSegmentReadArgs) => [
  "process",
  "chat",
  "conversation-segment",
  args,
] as const;

export const chatProcessAiConfigQueryKey = (pid: string) => [
  "process",
  "chat",
  "ai-config",
  pid,
] as const;

type ChatQueryOptions = {
  enabled?: boolean;
};

type UseChatProcessListOptions = ChatQueryOptions & {
  args?: ProcListArgs;
};

type UseChatProcessHistoryOptions = ChatQueryOptions & {
  args?: ProcHistoryArgs;
};

type UseChatProcessMediaOptions = ChatQueryOptions & {
  args: ProcMediaReadArgs;
};

function hasHistoryTarget(args: ProcHistoryArgs): boolean {
  return !args.pid || args.pid.trim().length > 0;
}

export function useChatProcessList(options: UseChatProcessListOptions = {}) {
  const { client, connected } = useGateway();
  const args = options.args ?? {};

  return useQuery({
    queryKey: chatProcessListQueryKey(args),
    enabled: connected && options.enabled !== false,
    queryFn: () => listChatProcesses(client, args),
  });
}

export function useChatProcessHistory(options: UseChatProcessHistoryOptions = {}) {
  const { client, connected } = useGateway();
  const args = options.args ?? {};

  return useQuery({
    queryKey: chatProcessHistoryQueryKey(args),
    enabled: connected && options.enabled !== false && hasHistoryTarget(args),
    queryFn: () => getChatHistory(client, args),
  });
}

export function useChatProcessMedia(options: UseChatProcessMediaOptions) {
  const { client, connected } = useGateway();

  return useQuery({
    queryKey: chatProcessMediaQueryKey(options.args),
    enabled: connected && options.enabled !== false && options.args.key.trim().length > 0,
    queryFn: () => readChatProcessMedia(client, options.args),
    staleTime: Infinity,
  });
}

export function useChatConversations(options: ChatQueryOptions & { args?: ProcConversationListArgs } = {}) {
  const { client, connected } = useGateway();
  const args = options.args ?? {};

  return useQuery({
    queryKey: chatConversationListQueryKey(args),
    enabled: connected && options.enabled !== false && hasHistoryTarget(args),
    queryFn: () => listChatConversations(client, args),
  });
}

export function useChatConversationSegments(options: ChatQueryOptions & { args?: ProcConversationSegmentsArgs } = {}) {
  const { client, connected } = useGateway();
  const args = options.args ?? {};

  return useQuery({
    queryKey: chatConversationSegmentsQueryKey(args),
    enabled: connected && options.enabled !== false && hasHistoryTarget(args),
    queryFn: () => listChatConversationSegments(client, args),
  });
}

export function useChatConversationSegment(options: ChatQueryOptions & { args: ProcConversationSegmentReadArgs }) {
  const { client, connected } = useGateway();

  return useQuery({
    queryKey: chatConversationSegmentQueryKey(options.args),
    enabled: connected
      && options.enabled !== false
      && options.args.segmentId.trim().length > 0
      && hasHistoryTarget(options.args),
    queryFn: () => readChatConversationSegment(client, options.args),
  });
}

export function useChatProcessAiConfig(options: ChatQueryOptions & { pid: string }) {
  const { client, connected } = useGateway();
  const pid = options.pid.trim();

  return useQuery({
    queryKey: chatProcessAiConfigQueryKey(pid),
    enabled: connected && options.enabled !== false && pid.length > 0,
    queryFn: () => getChatProcessAiConfig(client, { pid }),
  });
}

export function useSpawnChatProcess() {
  const { client } = useGateway();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (args: ProcSpawnArgs = {}) => spawnChatProcess(client, args),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["processes"] });
    },
  });
}

function invalidateChatRuntime(queryClient: ReturnType<typeof useQueryClient>): void {
  void queryClient.invalidateQueries({ queryKey: ["processes"] });
  void queryClient.invalidateQueries({ queryKey: chatProcessHistoryQueryKeyRoot });
  void queryClient.invalidateQueries({ queryKey: ["process", "chat", "conversations"] });
  void queryClient.invalidateQueries({ queryKey: ["process", "chat", "conversation-segments"] });
}

export function useSendChatMessage() {
  const { client } = useGateway();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (draft: ChatSendDraft) => sendChatMessage(client, draft),
    onSuccess: () => {
      invalidateChatRuntime(queryClient);
    },
  });
}

export function useAbortChatProcess() {
  const { client } = useGateway();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (args: ProcAbortArgs = {}) => abortChatProcess(client, args),
    onSuccess: () => {
      invalidateChatRuntime(queryClient);
    },
  });
}

export function useDecideChatHil() {
  const { client } = useGateway();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (args: ProcHilArgs) => decideChatHil(client, args),
    onSuccess: () => {
      invalidateChatRuntime(queryClient);
    },
  });
}

export function useCompactChatConversation() {
  const { client } = useGateway();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (args: ProcConversationCompactArgs) => compactChatConversation(client, args),
    onSuccess: () => invalidateChatRuntime(queryClient),
  });
}

export function useForkChatConversation() {
  const { client } = useGateway();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (args: ProcConversationForkArgs) => forkChatConversation(client, args),
    onSuccess: () => invalidateChatRuntime(queryClient),
  });
}

export function useSetChatProcessAiConfig() {
  const { client } = useGateway();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (args: ProcAiConfigSetArgs & { pid?: string }) => setChatProcessAiConfig(client, args),
    onSuccess: (_result, args) => {
      void queryClient.invalidateQueries({ queryKey: chatProcessAiConfigQueryKey(args.pid?.trim() ?? "") });
      void queryClient.invalidateQueries({ queryKey: ["processes"] });
    },
  });
}
