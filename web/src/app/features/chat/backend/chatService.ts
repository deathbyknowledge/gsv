import type { GSVClient } from "@humansandmachines/gsv/client";
import type {
  ProcAbortArgs,
  ProcAbortResult,
  ProcAiConfigGetArgs,
  ProcAiConfigGetResult,
  ProcAiConfigSetArgs,
  ProcAiConfigSetResult,
  ProcConversationCompactArgs,
  ProcConversationCompactResult,
  ProcConversationForkArgs,
  ProcConversationForkResult,
  ProcConversationListArgs,
  ProcConversationListResult,
  ProcConversationSegmentReadArgs,
  ProcConversationSegmentReadResult,
  ProcConversationSegmentsArgs,
  ProcConversationSegmentsResult,
  ProcHilArgs,
  ProcHilResult,
  ProcHistoryArgs,
  ProcHistoryResult,
  ProcListArgs,
  ProcMediaReadArgs,
  ProcMediaReadResult,
  ProcSendResult,
  ProcSpawnArgs,
  ProcSpawnResult,
} from "@humansandmachines/gsv/protocol";
import {
  normalizeHistory,
  normalizeProcessSummaries,
  normalizeSendPayload,
  type ChatConversation,
  type ChatConversationCompactResult,
  type ChatConversationForkResult,
  type ChatConversationSegmentReadResult,
  type ChatConversationSegment,
  type ChatHilDecisionResult,
  type ChatHistory,
  type ChatProcessAiConfig,
  type ChatProcessAiConfigSetResult,
  type ChatProcessSummary,
  type ChatSendDraft,
} from "../domain/processes";

type ChatGsvClient = Pick<GSVClient, "proc">;
type ProcAiConfigGetArgsWithPid = ProcAiConfigGetArgs & { pid?: string };
type ProcAiConfigSetArgsWithPid = ProcAiConfigSetArgs & { pid?: string };

type FailureResult = { ok: false; error: string };

function throwIfFailed<T>(result: T | FailureResult): T {
  if (
    result &&
    typeof result === "object" &&
    "ok" in result &&
    result.ok === false
  ) {
    throw new Error(result.error || "GSV process request failed");
  }
  return result as T;
}

export async function listChatProcesses(
  client: ChatGsvClient,
  args: ProcListArgs = {},
): Promise<ChatProcessSummary[]> {
  const result = await client.proc.list(args);
  return normalizeProcessSummaries(result.processes);
}

export async function spawnChatProcess(
  client: ChatGsvClient,
  args: ProcSpawnArgs = {},
): Promise<Extract<ProcSpawnResult, { ok: true }>> {
  return throwIfFailed(await client.proc.spawn(args));
}

export async function sendChatMessage(
  client: ChatGsvClient,
  draft: ChatSendDraft,
): Promise<Extract<ProcSendResult, { ok: true }>> {
  return throwIfFailed(await client.proc.send(normalizeSendPayload(draft)));
}

export async function abortChatProcess(
  client: ChatGsvClient,
  args: ProcAbortArgs = {},
): Promise<Extract<ProcAbortResult, { ok: true }>> {
  return throwIfFailed(await client.proc.abort(args));
}

export async function decideChatHil(
  client: ChatGsvClient,
  args: ProcHilArgs,
): Promise<ChatHilDecisionResult> {
  return throwIfFailed<Extract<ProcHilResult, { ok: true }>>(
    await client.proc.hil(args),
  );
}

export async function getChatHistory(
  client: ChatGsvClient,
  args: ProcHistoryArgs = {},
): Promise<ChatHistory> {
  const result = throwIfFailed<Extract<ProcHistoryResult, { ok: true }>>(
    await client.proc.history(args),
  );
  return normalizeHistory(result);
}

export async function readChatProcessMedia(
  client: ChatGsvClient,
  args: ProcMediaReadArgs,
): Promise<Extract<ProcMediaReadResult, { ok: true }>> {
  return throwIfFailed(await client.proc.media.read(args));
}

export async function listChatConversations(
  client: ChatGsvClient,
  args: ProcConversationListArgs,
): Promise<ChatConversation[]> {
  const result = throwIfFailed<Extract<ProcConversationListResult, { ok: true }>>(
    await client.proc.conversation.list(args),
  );
  return [...result.conversations].sort((left, right) => {
    if (left.id === "default") return -1;
    if (right.id === "default") return 1;
    return right.updatedAt - left.updatedAt || left.id.localeCompare(right.id);
  });
}

export async function compactChatConversation(
  client: ChatGsvClient,
  args: ProcConversationCompactArgs,
): Promise<ChatConversationCompactResult> {
  return throwIfFailed<Extract<ProcConversationCompactResult, { ok: true }>>(
    await client.proc.conversation.compact(args),
  );
}

export async function forkChatConversation(
  client: ChatGsvClient,
  args: ProcConversationForkArgs,
): Promise<ChatConversationForkResult> {
  return throwIfFailed<Extract<ProcConversationForkResult, { ok: true }>>(
    await client.proc.conversation.fork(args),
  );
}

export async function listChatConversationSegments(
  client: ChatGsvClient,
  args: ProcConversationSegmentsArgs,
): Promise<ChatConversationSegment[]> {
  const result = throwIfFailed<Extract<ProcConversationSegmentsResult, { ok: true }>>(
    await client.proc.conversation.segments(args),
  );
  return [...result.segments].sort((left, right) => right.createdAt - left.createdAt);
}

export async function readChatConversationSegment(
  client: ChatGsvClient,
  args: ProcConversationSegmentReadArgs,
): Promise<ChatConversationSegmentReadResult> {
  return throwIfFailed<Extract<ProcConversationSegmentReadResult, { ok: true }>>(
    await client.proc.conversation.segment.read(args),
  );
}

export async function getChatProcessAiConfig(
  client: ChatGsvClient,
  args: ProcAiConfigGetArgsWithPid = {},
): Promise<ChatProcessAiConfig> {
  const result = throwIfFailed<Extract<ProcAiConfigGetResult, { ok: true }>>(
    await client.proc.ai.config.get(args as ProcAiConfigGetArgs),
  );
  return result.config;
}

export async function setChatProcessAiConfig(
  client: ChatGsvClient,
  args: ProcAiConfigSetArgsWithPid,
): Promise<ChatProcessAiConfigSetResult> {
  return throwIfFailed<Extract<ProcAiConfigSetResult, { ok: true }>>(
    await client.proc.ai.config.set(args as ProcAiConfigSetArgs),
  );
}
