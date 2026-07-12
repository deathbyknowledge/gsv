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
  ProcMediaInput,
  ProcMediaReadArgs,
  ProcMediaReadResult,
  ProcMediaWriteResult,
  ProcSendResult,
  ProcSpawnArgs,
  ProcSpawnResult,
} from "@humansandmachines/gsv/protocol";
import { frameBodyFromBlob, frameBodyToBlob } from "../../../services/gateway/frameBody";
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
  MAX_CHAT_PROCESS_MEDIA_BYTES,
} from "../domain/processes";

type ChatGsvClient = Pick<GSVClient, "proc" | "request">;
type ChatMediaGsvClient = Pick<GSVClient, "request">;
type ProcAiConfigGetArgsWithPid = ProcAiConfigGetArgs & { pid?: string };
type ProcAiConfigSetArgsWithPid = ProcAiConfigSetArgs & { pid?: string };

type FailureResult = { ok: false; error: string };

export type ChatProcessMedia = Extract<ProcMediaReadResult, { ok: true }> & {
  blob: Blob;
};

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
  const uploads = draft.media ?? [];
  if (uploads.some(({ body }) => body.size > MAX_CHAT_PROCESS_MEDIA_BYTES)) {
    throw new Error("Chat attachments cannot exceed 25 MiB");
  }

  const settled = await Promise.allSettled(uploads.map(async ({ body, ...input }) => {
    const response = await client.request("proc.media.write", {
      ...input,
      ...(draft.pid ? { pid: draft.pid } : {}),
    }, {
      body: frameBodyFromBlob(body),
    });
    await response.body?.stream.cancel("proc.media.write does not return a body").catch(() => {});
    return throwIfFailed<Extract<ProcMediaWriteResult, { ok: true }>>(response.data).media;
  }));
  const media = settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  const uploadError = settled.find((result) => result.status === "rejected");
  if (uploadError?.status === "rejected") {
    await rollbackChatMedia(client, draft.pid, media);
    throw uploadError.reason;
  }

  try {
    return throwIfFailed(await client.proc.send(normalizeSendPayload({
      ...draft,
      ...(media.length > 0 ? { media } : {}),
    })));
  } catch (error) {
    await rollbackChatMedia(client, draft.pid, media);
    throw error;
  }
}

async function rollbackChatMedia(
  client: ChatGsvClient,
  pid: string | undefined,
  media: ProcMediaInput[],
): Promise<void> {
  await Promise.allSettled(media.flatMap(({ key }) => key
    ? [client.proc.media.delete({ key, ...(pid ? { pid } : {}) })]
    : []));
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
  client: ChatMediaGsvClient,
  args: ProcMediaReadArgs,
): Promise<ChatProcessMedia> {
  const response = await client.request("proc.media.read", args);
  if (!response.data.ok) {
    await response.body?.stream.cancel(response.data.error).catch(() => {});
    throw new Error(response.data.error || "GSV process media request failed");
  }
  if (response.data.size > MAX_CHAT_PROCESS_MEDIA_BYTES) {
    const error = new Error("Process media exceeds the 25 MiB display limit");
    await response.body?.stream.cancel(error).catch(() => {});
    throw error;
  }
  if (!response.body) {
    throw new Error("Process media response did not include a body");
  }
  const blob = await frameBodyToBlob(response.body, {
    mimeType: response.data.mimeType,
    expectedLength: response.data.size,
    label: "Process media",
  });
  return {
    ...response.data,
    blob,
  };
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
