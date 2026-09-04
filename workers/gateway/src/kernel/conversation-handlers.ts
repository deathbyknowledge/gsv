import type {
  ConversationForProcessArgs,
  ConversationForProcessResult,
  ConversationHistoryArgs,
  ConversationHistoryResult,
  ConversationShipResult,
  ConversationListResult,
  ConversationMediaReadArgs,
  ConversationMediaReadResult,
  ConversationMessageOrigin,
  ConversationSendArgs,
  ConversationSendResult,
  ConversationSummary,
  InteractionOrigin,
  ProcSendResult,
  ResourceBlock,
  BinaryBody,
} from "@humansandmachines/gsv/protocol";
import type { InternalRequestFrame } from "../protocol/process-frames";
import { REQUEST_CANCEL_SIGNAL } from "@humansandmachines/gsv/protocol";
import type { RequestFrame, ResponseFrame } from "../protocol/frames";
import { raceWithAbort } from "../shared/abort";
import { getConversationById, sendFrameToProcess } from "../shared/utils";
import { stableOpaqueId } from "../shared/stable-id";
import type { KernelContext } from "./context";
import { principalOf } from "./context";
import { resolveCallerOwnerUid } from "./context";
import { ensurePersonalController } from "./personal-controller";
import * as z from "zod/mini";

const conversationClientStateSchema = z.object({
  clientId: z.optional(z.string()),
  clientPlatform: z.optional(z.string()),
});

export async function handleConversationShip(
  ctx: KernelContext,
): Promise<ConversationShipResult> {
  const ownerUid = requireConversationClient(ctx);
  const pid = await ensurePersonalController(ownerUid, ctx);
  const conversation = ctx.conversations.ensureShip(ownerUid, pid);
  await initializeConversation(conversation, ctx);
  return { conversation };
}

export async function handleConversationForProcess(
  args: ConversationForProcessArgs,
  ctx: KernelContext,
): Promise<ConversationForProcessResult> {
  const ownerUid = requireConversationClient(ctx);
  const pid = normalizeId(args?.pid, "pid");
  const process = ctx.procs.get(pid);
  if (!process || process.ownerUid !== ownerUid) {
    throw new Error(`Process not found: ${pid}`);
  }
  if (!process.interactive) {
    throw new Error("Non-interactive work does not have a conversation");
  }
  const conversation = process.isPersonalController
    ? ctx.conversations.ensureShip(ownerUid, pid)
    : ctx.conversations.ensureWork(ownerUid, pid, process.label);
  await initializeConversation(conversation, ctx);
  return { conversation };
}

export async function handleConversationList(
  ctx: KernelContext,
): Promise<ConversationListResult> {
  requireConversationClient(ctx);
  await handleConversationShip(ctx);
  return { conversations: ctx.conversations.list(resolveCallerOwnerUid(ctx)) };
}

export async function handleConversationHistory(
  args: ConversationHistoryArgs,
  ctx: KernelContext,
): Promise<ConversationHistoryResult> {
  requireConversationReader(ctx);
  const conversation = ownedConversation(args?.conversationId, ctx);
  const history = await getConversationById(ctx.installationId, conversation.id).history({
    beforeSequence: args.beforeSequence,
    limit: args.limit,
  });
  if (history.latestSequence > conversation.latestSequence) {
    ctx.conversations.recordSequence(conversation.id, history.latestSequence);
  }
  return {
    conversation: ctx.conversations.get(conversation.id)!,
    messages: history.messages,
    hasMore: history.hasMore,
  };
}

export async function handleConversationSend(
  args: ConversationSendArgs,
  ctx: KernelContext,
): Promise<ConversationSendResult> {
  requireConversationClient(ctx);
  const conversation = ownedConversation(args?.conversationId, ctx);
  const text = args.text;
  if (!text.trim() && !(Array.isArray(args.media) && args.media.length > 0)) {
    throw new Error("conversation.send requires text or media");
  }
  const handler = ctx.procs.get(conversation.handlerPid);
  if (!handler || handler.ownerUid !== conversation.ownerUid || !handler.interactive) {
    throw new Error("Conversation handler is unavailable");
  }
  if (conversation.kind === "ship" && !handler.isPersonalController) {
    throw new Error("Ship conversation handler is not the personal intelligence");
  }
  const idempotencyKey = normalizeOptionalId(args.idempotencyKey) ?? crypto.randomUUID();
  const messageId = await stableOpaqueId("msg", [conversation.id, idempotencyKey]);
  const runId = `run:${messageId}`;
  const origin = conversationOrigin(ctx);
  const interactionOrigin = processInteractionOrigin(ctx);
  const media = await retainConversationResources(
    args.media,
    conversation.handlerPid,
    ctx,
    messageId,
  );
  ctx.requestSignal?.throwIfAborted();
  const appended = await getConversationById(ctx.installationId, conversation.id).append({
    messageId,
    idempotencyKey,
    author: { kind: "user", uid: conversation.ownerUid },
    text,
    media,
    mediaOwner: processMediaOwner(conversation.handlerPid, handler),
    origin,
    processId: conversation.handlerPid,
    runId,
    createdAt: Date.now(),
  });
  const { message } = appended;
  ctx.conversations.recordSequence(conversation.id, message.sequence);
  if (appended.created) {
    ctx.broadcastToUserUid(conversation.ownerUid, "message.committed", {
      message,
      directed: false,
    });
    ctx.broadcastToUserUid(conversation.ownerUid, "conversation.changed", {
      conversationId: conversation.id,
      latestSequence: message.sequence,
    });
  }

  const request: RequestFrame<"proc.send"> = {
    type: "req",
    id: crypto.randomUUID(),
    call: "proc.send",
    args: {
      pid: conversation.handlerPid,
      message: text,
      media,
      origin: interactionOrigin,
      interaction: {
        conversationId: conversation.id,
        messageId: message.id,
      },
    },
  };
  const hasConnectionRoute = Boolean(ctx.connection);
  if (ctx.connection) {
    ctx.runRoutes.setConnectionRoute({
      runId,
      processId: conversation.handlerPid,
      uid: conversation.ownerUid,
      connectionId: ctx.connection.id,
    });
  }
  let result: Extract<ProcSendResult, { ok: true }>;
  try {
    // SAFETY: The process RPC boundary returns a response frame for this request.
    const response = await sendFrameToProcess(
      ctx.installationId,
      conversation.handlerPid,
      request,
    ) as ResponseFrame<"proc.send"> | null;
    if (!response || response.type !== "res" || response.id !== request.id) {
      throw new Error("Conversation handler returned no valid response");
    }
    if (!response.ok) throw new Error(response.error.message);
    // SAFETY: The proc.send response is validated by the process RPC boundary.
    const responseResult = response.data as ProcSendResult | undefined;
    if (!responseResult?.ok) {
      throw new Error(responseResult?.error ?? "Conversation handler rejected the message");
    }
    if (responseResult.runId !== runId) {
      throw new Error("Conversation handler returned an unexpected run id");
    }
    result = responseResult;
  } catch (error) {
    if (hasConnectionRoute) ctx.runRoutes.delete(runId);
    throw error;
  }
  return {
    message,
    handlerPid: conversation.handlerPid,
    runId: result.runId,
    queued: result.queued,
  };
}

export async function retainConversationResources(
  resources: ResourceBlock[] | undefined,
  pid: string,
  ctx: KernelContext,
  batchId: string = crypto.randomUUID(),
): Promise<ResourceBlock[] | undefined> {
  if (!resources?.length) return undefined;
  ctx.requestSignal?.throwIfAborted();
  const request: InternalRequestFrame<"proc.resources.retain"> = {
    type: "req",
    id: crypto.randomUUID(),
    call: "proc.resources.retain",
    args: { batchId, resources },
  };
  const pending = sendFrameToProcess(ctx.installationId, pid, request);
  let cancellation: Promise<unknown> | undefined;
  let response: Awaited<typeof pending>;
  try {
    response = await raceWithAbort(pending, ctx.requestSignal, {
      abortReason: () => ctx.requestSignal?.reason ?? new Error("Request cancelled"),
      onAbort: () => {
        const reason = ctx.requestSignal?.reason instanceof Error
          ? ctx.requestSignal.reason.message
          : "Request cancelled";
        cancellation = sendFrameToProcess(ctx.installationId, pid, {
          type: "sig",
          signal: REQUEST_CANCEL_SIGNAL,
          payload: { id: request.id, reason },
        });
      },
    });
  } catch (error) {
    await cancellation?.catch(() => {});
    throw error;
  }
  ctx.requestSignal?.throwIfAborted();
  if (!response || response.type !== "res" || response.id !== request.id) {
    throw new Error("Conversation handler returned no resource response");
  }
  if (!response.ok) throw new Error(response.error.message);
  if (!("resources" in response.data)) {
    throw new Error("Conversation handler returned an invalid resource batch");
  }
  return response.data.resources;
}

export async function handleConversationMediaRead(
  args: ConversationMediaReadArgs,
  ctx: KernelContext,
): Promise<{ data: ConversationMediaReadResult; body: BinaryBody }> {
  requireConversationClient(ctx);
  const conversation = ownedConversation(args?.conversationId, ctx);
  const media = await getConversationById(ctx.installationId, conversation.id).readMedia({
    key: normalizeId(args?.key, "key"),
  });
  return {
    data: {
      ok: true,
      conversationId: conversation.id,
      key: media.key,
      mimeType: media.mimeType,
      size: media.size,
    },
    body: { stream: media.stream, length: media.size },
  };
}

async function initializeConversation(
  conversation: ConversationSummary,
  ctx: KernelContext,
): Promise<void> {
  await getConversationById(ctx.installationId, conversation.id).initialize({
    ownerUid: conversation.ownerUid,
    kind: conversation.kind,
  });
}

type ConversationMediaOwner = { pid: string; uid: number; gid: number; home: string };

export function processMediaOwner(pid: string, process: {
  uid: number;
  gid: number;
  home: string;
}): ConversationMediaOwner {
  return {
    pid,
    uid: process.uid,
    gid: process.gid,
    home: process.home,
  };
}

function ownedConversation(id: string | undefined, ctx: KernelContext): ConversationSummary {
  const conversationId = normalizeId(id, "conversationId");
  const conversation = ctx.conversations.get(conversationId);
  const ownerUid = resolveCallerOwnerUid(ctx);
  if (!conversation || (conversation.ownerUid !== ownerUid && principalOf(ctx)?.account.uid !== 0)) {
    throw new Error(`Conversation not found: ${conversationId}`);
  }
  return conversation;
}

function requireConversationClient(ctx: KernelContext): number {
  if (principalOf(ctx)?.kind !== "human" || ctx.processId) {
    throw new Error("Conversation operations require a direct user client");
  }
  return resolveCallerOwnerUid(ctx);
}

function requireConversationReader(ctx: KernelContext): number {
  if (principalOf(ctx)?.kind !== "human") {
    throw new Error("Conversation history requires a signed-in human or their Ship");
  }
  const ownerUid = resolveCallerOwnerUid(ctx);
  if (!ctx.processId) return ownerUid;
  const process = ctx.procs.get(ctx.processId);
  if (process?.isPersonalController === true && process.ownerUid === ownerUid) {
    return ownerUid;
  }
  throw new Error("Conversation history requires a signed-in human or their Ship");
}

function conversationOrigin(ctx: KernelContext): ConversationMessageOrigin {
  const identity = principalOf(ctx)!;
  if (identity.kind === "machine") {
    return { kind: "device", deviceId: identity.peerId };
  }
  const state = conversationClientStateSchema.parse(ctx.connection?.state ?? {});
  return {
    kind: "client",
    clientId: state.clientId?.trim() || undefined,
    platform: state.clientPlatform?.trim() || undefined,
  };
}

function processInteractionOrigin(ctx: KernelContext): InteractionOrigin | undefined {
  const identity = principalOf(ctx);
  if (!identity) return undefined;
  if (identity.kind === "machine") {
    return { kind: "device", deviceId: identity.peerId };
  }
  if (identity.kind !== "human" || !ctx.connection) return undefined;
  const state = conversationClientStateSchema.parse(ctx.connection.state ?? {});
  return {
    kind: "client",
    connectionId: ctx.connection.id,
    clientId: state.clientId?.trim() || undefined,
    platform: state.clientPlatform?.trim() || undefined,
  };
}

function normalizeId(value: string | undefined, label: string): string {
  const parsed = z.string().safeParse(value);
  if (!parsed.success || !parsed.data.trim()) throw new Error(`${label} is required`);
  return parsed.data.trim();
}

function normalizeOptionalId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!value.trim() || value.length > 256) {
    throw new Error("idempotencyKey is invalid");
  }
  return value.trim();
}
