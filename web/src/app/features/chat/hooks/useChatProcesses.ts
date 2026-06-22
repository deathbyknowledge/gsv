import { useMutation, useQuery, useQueryClient } from "@tanstack/preact-query";
import type {
  ProcAbortArgs,
  ProcHilArgs,
  ProcHistoryArgs,
  ProcListArgs,
  ProcMediaReadArgs,
  ProcSpawnArgs,
} from "@humansandmachines/gsv/protocol";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import {
  abortChatProcess,
  decideChatHil,
  getChatHistory,
  listChatProcesses,
  readChatProcessMedia,
  sendChatMessage,
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

export function useSendChatMessage() {
  const { client } = useGateway();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (draft: ChatSendDraft) => sendChatMessage(client, draft),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["processes"] });
      void queryClient.invalidateQueries({ queryKey: chatProcessHistoryQueryKeyRoot });
    },
  });
}

export function useAbortChatProcess() {
  const { client } = useGateway();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (args: ProcAbortArgs = {}) => abortChatProcess(client, args),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["processes"] });
      void queryClient.invalidateQueries({ queryKey: chatProcessHistoryQueryKeyRoot });
    },
  });
}

export function useDecideChatHil() {
  const { client } = useGateway();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (args: ProcHilArgs) => decideChatHil(client, args),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["processes"] });
      void queryClient.invalidateQueries({ queryKey: chatProcessHistoryQueryKeyRoot });
    },
  });
}
