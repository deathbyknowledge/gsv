import type { GSVClient } from "@humansandmachines/gsv/client";
import type {
  ProcAbortArgs,
  ProcAbortResult,
  ProcAiConfigGetArgs,
  ProcAiConfigGetResult,
  ProcAiConfigSetArgs,
  ProcAiConfigSetResult,
  ProcForkArgs,
  ProcForkResult,
  ProcHistoryCompactArgs,
  ProcHistoryCompactResult,
  ProcHistorySegmentReadArgs,
  ProcHistorySegmentReadResult,
  ProcHistorySegmentsArgs,
  ProcHistorySegmentsResult,
  ProcHilArgs,
  ProcHilResult,
  ProcHistoryArgs,
  ProcHistoryResult,
  ProcListArgs,
  ProcMediaInput,
  ProcMediaReadArgs,
  ProcMediaReadResult,
  ProcMediaWriteResult,

  ProcSpawnArgs,
  ProcSpawnResult,
  ConversationForProcessResult,
  ConversationHistoryResult,
  ConversationMediaReadArgs,
  ConversationMediaReadResult,
  ConversationSendResult,
} from "@humansandmachines/gsv/protocol";
import { frameBodyFromBlob, frameBodyToBlob } from "../../../services/gateway/frameBody";
import { z } from "zod";

const mediaReadDataSchema = z.union([
  z.object({ ok: z.literal(true), key: z.string(), path: z.string().optional(), mimeType: z.string(), size: z.number(), conversationId: z.string().optional() }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
import {
  normalizeHistory,
  normalizeProcessSummaries,

  type ChatForkResult,
  type ChatHistoryCompactResult,
  type ChatHistorySegmentReadResult,
  type ChatHistorySegment,
  type ChatHilDecisionResult,
  type ChatHistory,
  type ChatProcessAiConfig,
  type ChatProcessAiConfigSetResult,
  type ChatProcessSummary,
  type ChatSendDraft,
  MAX_CHAT_PROCESS_MEDIA_BYTES,
} from "../domain/processes";

type ChatGsvClient = Pick<GSVClient, "proc" | "conversation" | "request">;
type ChatMediaGsvClient = Pick<GSVClient, "request">;
type FailureResult = { ok: false; error: string };

export type ChatProcessMedia = (
  | Extract<ProcMediaReadResult, { ok: true }>
  | Extract<ConversationMediaReadResult, { ok: true }>
) & {
  blob: Blob;
};

function throwIfFailed<T extends { ok: true }>(result: T | FailureResult): T {
  if (!result.ok) {
    throw new Error(result.error || "GSV process request failed");
  }
  return result;
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
): Promise<ConversationSendResult> {
  const uploads = draft.media ?? [];
  if (uploads.some(({ body }) => body.size > MAX_CHAT_PROCESS_MEDIA_BYTES)) {
    throw new Error("Chat attachments cannot exceed 25 MiB");
  }
  const pid = draft.pid?.trim();
  if (!pid) throw new Error("Chat requires a process");
  const conversationId = draft.conversationId?.trim()
    || (await client.conversation.forProcess({ pid })).conversation.id;

  const settled = await Promise.allSettled(uploads.map(async ({ body, ...input }) => {
    const response = await client.request("proc.media.write", {
      ...input,
      ...(draft.pid ? { pid: draft.pid } : undefined),
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
    return await client.conversation.send({
      conversationId,
      text: draft.message,
      ...(media.length > 0 ? { media } : undefined),
      idempotencyKey: crypto.randomUUID(),
    });
  } catch (error) {
    await rollbackChatMedia(client, draft.pid, media);
    throw error;
  }
}

export async function getChatConversation(
  client: ChatGsvClient,
  pid: string,
): Promise<ConversationForProcessResult> {
  return client.conversation.forProcess({ pid });
}

export async function getChatConversationHistory(
  client: ChatGsvClient,
  conversationId: string,
  options: { beforeSequence?: number; limit?: number } = {},
): Promise<ConversationHistoryResult> {
  return client.conversation.history({ conversationId, ...options });
}

async function rollbackChatMedia(
  client: ChatGsvClient,
  pid: string | undefined,
  media: ProcMediaInput[],
): Promise<void> {
  await Promise.allSettled(media.flatMap(({ key }) => key
    ? [client.proc.media.delete({ key, ...(pid ? { pid } : undefined) })]
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
  args: ProcMediaReadArgs | ConversationMediaReadArgs,
): Promise<ChatProcessMedia> {
  const conversation = "conversationId" in args && Boolean(args.conversationId.trim());
  const response = conversation
    ? await client.request("conversation.media.read", {
        conversationId: args.conversationId,
        key: args.key,
      })
    : await client.request("proc.media.read", args);
  const data = mediaReadDataSchema.parse(response.data);
  if (!data.ok) {
    await response.body?.stream.cancel(data.error).catch(() => {});
    throw new Error(data.error || "GSV process media request failed");
  }
  if (data.size > MAX_CHAT_PROCESS_MEDIA_BYTES) {
    const error = new Error("Process media exceeds the 25 MiB display limit");
    await response.body?.stream.cancel(error).catch(() => {});
    throw error;
  }
  if (!response.body) {
    throw new Error("Process media response did not include a body");
  }
  const blob = await frameBodyToBlob(response.body, {
    mimeType: data.mimeType,
    expectedLength: data.size,
    label: "Process media",
  });
  return {
    ...data,
    path: data.path ?? args.key,
    blob,
  };
}

export async function compactChatHistory(
  client: ChatGsvClient,
  args: ProcHistoryCompactArgs,
): Promise<ChatHistoryCompactResult> {
  return throwIfFailed<Extract<ProcHistoryCompactResult, { ok: true }>>(
    await client.proc.history.compact(args),
  );
}

export async function forkChatProcess(
  client: ChatGsvClient,
  args: ProcForkArgs,
): Promise<ChatForkResult> {
  return throwIfFailed<Extract<ProcForkResult, { ok: true }>>(
    await client.proc.fork(args),
  );
}

export async function listChatHistorySegments(
  client: ChatGsvClient,
  args: ProcHistorySegmentsArgs,
): Promise<ChatHistorySegment[]> {
  const result = throwIfFailed<Extract<ProcHistorySegmentsResult, { ok: true }>>(
    await client.proc.history.segments(args),
  );
  return [...result.segments].sort((left, right) => right.createdAt - left.createdAt);
}

export async function readChatHistorySegment(
  client: ChatGsvClient,
  args: ProcHistorySegmentReadArgs,
): Promise<ChatHistorySegmentReadResult> {
  return throwIfFailed<Extract<ProcHistorySegmentReadResult, { ok: true }>>(
    await client.proc.history.segment.read(args),
  );
}

export async function getChatProcessAiConfig(
  client: ChatGsvClient,
  args: ProcAiConfigGetArgs = {},
): Promise<ChatProcessAiConfig> {
  const result = throwIfFailed<Extract<ProcAiConfigGetResult, { ok: true }>>(
    await client.proc.ai.config.get(args),
  );
  return result.config;
}

export async function setChatProcessAiConfig(
  client: ChatGsvClient,
  args: ProcAiConfigSetArgs,
): Promise<ChatProcessAiConfigSetResult> {
  return throwIfFailed<Extract<ProcAiConfigSetResult, { ok: true }>>(
    await client.proc.ai.config.set(args),
  );
}
