import type {
  ConversationForProcessArgs,
  ConversationForProcessResult,
  ConversationHistoryArgs,
  ConversationHistoryResult,
  ConversationSearchArgs,
  ConversationSearchResult,
  ConversationShipResult,
  ConversationListResult,
  ConversationMediaReadArgs,
  ConversationMediaReadResult,
  ConversationMessageOrigin,
  ConversationSendArgs,
  ConversationSendResult,
  ConversationSummary,
  InteractionOrigin,
  ResourceBlock,
  BinaryBody,
} from "@humansandmachines/gsv/protocol";
import { processResult } from "../protocol/process-frames";
import { raceWithAbort } from "../shared/abort";
import { cancelProcessCall, getConversationById, retainProcessResources } from "../shared/utils";
import { conversationSendMessageId } from "@humansandmachines/gsv/protocol/stable-id";
import type { KernelContext } from "./context";
import { principalOf } from "./context";
import { emitTelemetry, shipPlatformFromPeer } from "@humansandmachines/gsv/telemetry";
import { resolveCallerOwnerUid } from "./context";
import { processConsumer, shipConsumer } from "./events/consumers";
import { checkContactWhenOpened } from "./federation/gone-ships";
import { committedContent, conversationMessage } from "./message-events";
import { ensurePersonalController } from "./personal-controller";
import { withInitialOnboarding } from "./onboarding-responsibility";
import { resolveSelectedMessageTarget } from "./targets";
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
    afterSequence: args.afterSequence,
    limit: args.limit,
  });
  const latest = history.messages.at(-1);
  if (conversation.kind === "contact" && latest?.sequence === history.latestSequence) {
    ctx.conversations.recordContactMessage(latest, true);
  }
  if (history.latestSequence > conversation.latestSequence) {
    ctx.conversations.recordSequence(conversation.id, history.latestSequence);
  }
  const contact = conversation.kind === "contact" ? ctx.federation.getByConversation(conversation.id) : null;
  if (contact) checkContactWhenOpened(contact, ctx);
  return {
    conversation: ctx.conversations.get(conversation.id)!,
    messages: history.messages,
    hasMore: history.hasMore,
  };
}

export async function handleConversationSearch(
  args: ConversationSearchArgs,
  ctx: KernelContext,
): Promise<ConversationSearchResult> {
  const ownerUid = requireConversationReader(ctx);
  const conversation = ownedConversation(args.conversationId ?? ctx.conversations.getShip(ownerUid)?.id, ctx);
  const result = await getConversationById(ctx.installationId, conversation.id).search({
    query: args.query, beforeSequence: args.beforeSequence, limit: args.limit,
  });
  return { conversation, ...result };
}

export async function handleConversationSend(
  args: ConversationSendArgs,
  ctx: KernelContext,
): Promise<ConversationSendResult> {
  requireConversationClient(ctx);
  const conversation = ownedConversation(args?.conversationId, ctx);
  if (conversation.kind === "contact") {
    throw new Error("Use contact.send to message a contact; conversation.send submits input to a local process");
  }
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
  if (conversation.kind === "ship" && ctx.connection && principalOf(ctx)?.account.uid === conversation.ownerUid) {
    ctx.shipReplies.recordClientInput(
      conversation.ownerUid, ctx.connection.id, conversation.id, idempotencyKey, ctx.runRoutes,
    );
  }
  const messageId = await conversationSendMessageId(conversation.id, idempotencyKey);
  const runId = `run:${messageId}`;
  const origin = conversationOrigin(ctx);
  const interactionOrigin = processInteractionOrigin(ctx);
  const selectedTarget = await resolveSelectedMessageTarget(ctx, args.selectedTarget);
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
    selectedTarget,
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
    if (conversation.kind === "ship" && origin.kind === "client" && principalOf(ctx)?.account.uid === conversation.ownerUid) {
      emitTelemetry(ctx.env, {
        installationId: ctx.installationId,
        component: "gateway",
        event: {
          stream: "product",
          name: "ship.message.received",
          properties: {
            source: "client",
            platform: shipPlatformFromPeer(origin.platform),
            hasText: text.trim().length > 0,
            hasMedia: Boolean(media?.length),
          },
        },
      });
    }
  }

  const ownerUid = conversation.ownerUid;
  const ship = conversation.kind === "ship";
  const sender = principalOf(ctx)?.account.uid;
  // The Conversation lives in its own Durable Object, so the event follows its append; a resend
  // after a lost answer appends nothing more and redelivers what is still waiting.
  const event = ctx.events.append(conversationMessage({
    ownerUid,
    ...(ship ? undefined : { pid: conversation.handlerPid }),
    conversationId: conversation.id,
    messageId: message.id,
    sequence: message.sequence,
    runId,
    ...(interactionOrigin === undefined ? undefined : { origin: interactionOrigin }),
    actor: { kind: "person", uid: sender ?? ownerUid },
  }));
  if (ctx.connection) {
    ctx.runRoutes.setConnectionRoute({
      runId,
      processId: conversation.handlerPid,
      uid: ownerUid,
      connectionId: ctx.connection.id,
      followsShip: ship && sender === ownerUid,
      clientPlatform: interactionOrigin?.kind === "client" ? interactionOrigin.platform : undefined,
    });
  }
  const sent = await withInitialOnboarding(
    ship && sender === ownerUid ? ownerUid : undefined,
    ctx,
    () => ctx.events.deliverNow(event, ship ? shipConsumer(ownerUid) : processConsumer(conversation.handlerPid), committedContent(message)),
  );
  // A message its handler can never take, or one that is gone, fails the send as before.
  if (sent.state === "withdrawn") throw new Error(sent.reason);
  return {
    message,
    handlerPid: conversation.handlerPid,
    runId,
    // One its handler can't take right now waits on the log, which retries it.
    queued: sent.state === "pending" || sent.queued,
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
  const cancelId = crypto.randomUUID();
  const pending = retainProcessResources(ctx.installationId, pid, cancelId, { batchId, resources });
  let cancellation: Promise<unknown> | undefined;
  let result: Awaited<typeof pending>;
  try {
    result = await raceWithAbort(pending, ctx.requestSignal, {
      abortReason: () => ctx.requestSignal?.reason ?? new Error("Request cancelled"),
      onAbort: () => {
        const reason = ctx.requestSignal?.reason instanceof Error
          ? ctx.requestSignal.reason.message
          : "Request cancelled";
        cancellation = cancelProcessCall(ctx.installationId, pid, cancelId, reason);
      },
    });
  } catch (error) {
    await cancellation?.catch(() => {});
    throw error;
  }
  ctx.requestSignal?.throwIfAborted();
  return processResult(result).resources;
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
