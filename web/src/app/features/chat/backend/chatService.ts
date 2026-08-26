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
  ProcSpawnArgs,
  ProcSpawnResult,
  ConversationForProcessResult,
  ConversationHistoryResult,
  ConversationMediaReadArgs,
  ConversationSendResult,
  FileResourceReference,
  ResourceBlock,
  FsTransferReceiveResult,
  FsTransferStatResult,
  FsTransferSendResult,
} from "@humansandmachines/gsv/protocol";
import { fileResourceReferenceSchema } from "@humansandmachines/gsv/protocol";
import { frameBodyFromBlob, frameBodyToBlob } from "../../../services/gateway/frameBody";
import { z } from "zod";

const mediaReadDataSchema = z.union([
  z.object({ ok: z.literal(true), key: z.string(), path: z.string().optional(), mimeType: z.string(), size: z.number(), conversationId: z.string().optional() }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
const resourceTransferDataSchema = z.union([
  z.object({
    ok: z.literal(true),
    path: z.string(),
    size: z.number().int().nonnegative(),
    contentType: z.string().optional(),
    revision: z.string().optional(),
  }),
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
export type ChatConversationGsvClient = {
  conversation: Pick<GSVClient["conversation"], "forProcess" | "history">;
};
type FailureResult = { ok: false; error: string };

export type ChatProcessMedia = (
  {
    ok: true;
    key: string;
    path?: string;
    mimeType: string;
    size: number;
    conversationId?: string;
  }
) & {
  blob: Blob;
};

export type ChatStoredMediaReadArgs =
  | { key: string; pid?: string }
  | ConversationMediaReadArgs;

export type ChatResource = {
  blob: Blob;
  ref: FileResourceReference;
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

  const stagedPaths: string[] = [];
  const settled = await Promise.allSettled(uploads.map(async (upload) => {
    const path = chatUploadPath(upload.filename);
    stagedPaths.push(path);
    return uploadChatResource(client, path, upload);
  }));
  const media = settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  const uploadError = settled.find((result) => result.status === "rejected");
  if (uploadError?.status === "rejected") {
    await deleteChatUploads(client, stagedPaths);
    throw uploadError.reason;
  }

  try {
    return await client.conversation.send({
      conversationId,
      text: draft.message,
      ...(media.length > 0 ? { media } : undefined),
      idempotencyKey: crypto.randomUUID(),
    });
  } finally {
    await deleteChatUploads(client, stagedPaths);
  }
}

export async function getChatConversation(
  client: ChatConversationGsvClient,
  pid: string,
): Promise<ConversationForProcessResult> {
  return client.conversation.forProcess({ pid });
}

export async function getChatConversationHistory(
  client: ChatConversationGsvClient,
  conversationId: string,
  options: { beforeSequence?: number; limit?: number } = {},
): Promise<ConversationHistoryResult> {
  return client.conversation.history({ conversationId, ...options });
}

async function uploadChatResource(
  client: ChatGsvClient,
  path: string,
  upload: NonNullable<ChatSendDraft["media"]>[number],
): Promise<ResourceBlock> {
  const received = await client.request("fs.transfer.receive", {
    path,
    contentType: upload.mimeType,
  }, { body: frameBodyFromBlob(upload.body) });
  await received.body?.stream.cancel("fs.transfer.receive does not return a body").catch(() => {});
  const receiveResult = throwIfFailed<Extract<FsTransferReceiveResult, { ok: true }>>(
    received.data,
  );
  if (receiveResult.bytesWritten !== upload.body.size) {
    throw new Error("GSV stored an unexpected attachment length");
  }
  const stat = await client.request("fs.transfer.stat", { path: receiveResult.path });
  await stat.body?.stream.cancel("fs.transfer.stat does not return a body").catch(() => {});
  const statResult = throwIfFailed<Extract<FsTransferStatResult, { ok: true }>>(stat.data);
  if (
    !statResult.isFile
    || statResult.size !== upload.body.size
    || statResult.contentType !== upload.mimeType
    || !statResult.revision
  ) {
    throw new Error("GSV could not identify the uploaded attachment revision");
  }
  return {
    type: "resource",
    ref: {
      type: "file",
      target: "gsv",
      path: statResult.path,
      revision: statResult.revision,
      contentType: upload.mimeType,
      size: statResult.size,
    },
    mediaType: upload.type,
    filename: upload.filename,
  };
}

function chatUploadPath(filename: string | undefined): string {
  const safe = filename?.trim().replaceAll(/[/\\\0]/g, "_") || "attachment";
  return `~/.gsv/uploads/${crypto.randomUUID()}/${safe}`;
}

async function deleteChatUploads(client: ChatGsvClient, paths: string[]): Promise<void> {
  await Promise.allSettled(paths.map(async (path) => {
    const response = await client.request("fs.delete", { path });
    await response.body?.stream.cancel("fs.delete does not return a body").catch(() => {});
  }));
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
  args: ChatStoredMediaReadArgs,
): Promise<ChatProcessMedia> {
  const conversation = "conversationId" in args && Boolean(args.conversationId.trim());
  if (!conversation) {
    const path = `/${args.key.replace(/^\/+/, "")}`;
    const statResponse = await client.request("fs.transfer.stat", { path });
    await statResponse.body?.stream.cancel("fs.transfer.stat does not return a body").catch(() => {});
    const stat = throwIfFailed<Extract<FsTransferStatResult, { ok: true }>>(statResponse.data);
    if (!stat.isFile || !stat.revision || !stat.contentType) {
      throw new Error("Process media no longer identifies an immutable file");
    }
    const resource = await readChatResource(client, {
      type: "file",
      target: "gsv",
      path: stat.path,
      revision: stat.revision,
      contentType: stat.contentType,
      size: stat.size,
    });
    return {
      ok: true,
      key: args.key,
      path: stat.path,
      mimeType: stat.contentType,
      size: stat.size,
      blob: resource.blob,
    };
  }
  const response = conversation
    ? await client.request("conversation.media.read", {
        conversationId: args.conversationId,
        key: args.key,
      })
    : undefined;
  if (!response) throw new Error("Conversation media request was not created");
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

export async function readChatResource(
  client: ChatMediaGsvClient,
  reference: FileResourceReference,
): Promise<ChatResource> {
  const ref = fileResourceReferenceSchema.parse(reference);
  if (ref.expiresAt !== undefined && ref.expiresAt <= Date.now()) {
    throw new Error("Resource reference has expired");
  }
  if (ref.size > MAX_CHAT_PROCESS_MEDIA_BYTES) {
    throw new Error("Resource exceeds the 25 MiB display limit");
  }
  const response = await client.request("fs.transfer.send", {
    target: ref.target,
    path: ref.path,
    revision: ref.revision,
  });
  const data = resourceTransferDataSchema.parse(response.data) satisfies FsTransferSendResult;
  if (!data.ok) {
    await response.body?.stream.cancel(data.error).catch(() => {});
    throw new Error(data.error || "GSV resource request failed");
  }
  if (
    data.path !== ref.path
    || data.size !== ref.size
    || data.revision !== ref.revision
    || data.contentType !== ref.contentType
  ) {
    const error = new Error("Resource response does not match its reference");
    await response.body?.stream.cancel(error).catch(() => {});
    throw error;
  }
  if (!response.body) {
    throw new Error("Resource response did not include a body");
  }
  return {
    ref,
    blob: await frameBodyToBlob(response.body, {
      mimeType: ref.contentType,
      expectedLength: ref.size,
      label: "Resource",
    }),
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
