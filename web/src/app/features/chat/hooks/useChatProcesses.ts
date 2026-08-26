import { useMutation, useQuery, useQueryClient } from "@tanstack/preact-query";
import type {
  ProcAbortArgs,
  ProcAiConfigSetArgs,
  ProcForkArgs,
  ProcHistoryCompactArgs,
  ProcHistorySegmentReadArgs,
  ProcHistorySegmentsArgs,
  ProcHilArgs,
  ProcHistoryArgs,
  ProcListArgs,
  ProcSpawnArgs,
  ProcTraceArgs,
  FileResourceReference,
} from "@humansandmachines/gsv/protocol";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import {
  abortChatProcess,
  compactChatHistory,
  decideChatHil,
  forkChatProcess,
  getChatProcessAiConfig,
  getChatHistory,
  getProcessTrace,
  listChatHistorySegments,
  listChatProcesses,
  readChatProcessMedia,
  type ChatStoredMediaReadArgs,
  readChatResource,
  readChatHistorySegment,
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

export const chatProcessTraceQueryKey = (args: ProcTraceArgs) => [
  "process",
  "trace",
  args,
] as const;

export const chatProcessMediaQueryKey = (args: ChatStoredMediaReadArgs) => [
  "process",
  "chat",
  "media",
  args,
] as const;

export const chatResourceQueryKey = (ref: FileResourceReference) => [
  "resource",
  ref.target,
  ref.path,
  ref.revision,
  ref.contentType,
  ref.size,
] as const;

export const chatHistorySegmentsQueryKey = (args: ProcHistorySegmentsArgs = {}) => [
  "process",
  "chat",
  "history-segments",
  args,
] as const;

export const chatHistorySegmentQueryKey = (args: ProcHistorySegmentReadArgs) => [
  "process",
  "chat",
  "history-segment",
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

type UseChatProcessTraceOptions = ChatQueryOptions & {
  args: ProcTraceArgs;
};

type UseChatProcessMediaOptions = ChatQueryOptions & {
  args: ChatStoredMediaReadArgs;
};

type UseChatResourceOptions = ChatQueryOptions & {
  ref: FileResourceReference | null;
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

export function useChatProcessTrace(options: UseChatProcessTraceOptions) {
  const { client, connected } = useGateway();
  const pid = options.args.pid?.trim() ?? "";

  return useQuery({
    queryKey: chatProcessTraceQueryKey(options.args),
    enabled: connected && options.enabled !== false && pid.length > 0,
    queryFn: () => getProcessTrace(client, options.args),
    refetchInterval: (query) => query.state.data?.activeRunId ? 1_000 : false,
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

export function useChatResource(options: UseChatResourceOptions) {
  const { client, connected } = useGateway();
  const ref = options.ref;

  return useQuery({
    queryKey: ref ? chatResourceQueryKey(ref) : ["resource", "unavailable"],
    enabled: connected && options.enabled !== false && ref !== null,
    queryFn: () => {
      if (!ref) throw new Error("Resource reference is unavailable");
      return readChatResource(client, ref);
    },
    staleTime: Infinity,
  });
}

export function useChatHistorySegments(options: ChatQueryOptions & { args?: ProcHistorySegmentsArgs } = {}) {
  const { client, connected } = useGateway();
  const args = options.args ?? {};

  return useQuery({
    queryKey: chatHistorySegmentsQueryKey(args),
    enabled: connected && options.enabled !== false && hasHistoryTarget(args),
    queryFn: () => listChatHistorySegments(client, args),
  });
}

export function useChatHistorySegment(options: ChatQueryOptions & { args: ProcHistorySegmentReadArgs }) {
  const { client, connected } = useGateway();

  return useQuery({
    queryKey: chatHistorySegmentQueryKey(options.args),
    enabled: connected
      && options.enabled !== false
      && options.args.segmentId.trim().length > 0
      && hasHistoryTarget(options.args),
    queryFn: () => readChatHistorySegment(client, options.args),
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
  void queryClient.invalidateQueries({ queryKey: ["process", "chat", "history-segments"] });
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

export function useCompactChatHistory() {
  const { client } = useGateway();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (args: ProcHistoryCompactArgs) => compactChatHistory(client, args),
    onSuccess: () => invalidateChatRuntime(queryClient),
  });
}

export function useForkChatProcess() {
  const { client } = useGateway();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (args: ProcForkArgs) => forkChatProcess(client, args),
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
