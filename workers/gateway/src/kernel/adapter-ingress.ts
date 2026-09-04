import type {
  AdapterInboundMessage,
  AdapterSurface,
} from "../adapter-interface";
import type {
  InternalRequestFrame,
  InternalResponseFrame,
} from "../protocol/process-frames";
import type {
  AdapterInboundArgs,
  AdapterInboundSyscallResult,
  InteractionOrigin,
  BinaryBody,
  ProcListResult,
  ResourceBlock,
  ConversationMessageOrigin,
  JsonValue,
} from "@humansandmachines/gsv/protocol";
import {
  cancelBinaryBody,
  consumeAdapterMediaBodyParts,
  adapterSurfaceSchema,
} from "@humansandmachines/gsv/protocol";
import {
  emitTelemetry,
} from "@humansandmachines/gsv/telemetry";
import * as z from "zod/mini";
import {
  type KernelContext,
} from "./context";
import type {
  RequestFrame,
} from "../protocol/frames";
import {
  getConversationById,
  sendFrameToProcess,
} from "../shared/utils";
import type {
  ConversationAppendRequest,
} from "../conversation/do";
import {
  stableOpaqueId,
} from "../shared/stable-id";
import {
  ensurePersonalController,
} from "./personal-controller";
import {
  identityLinkAllowsSurface,
  identityLinkRouteGeneration,
} from "./adapter-destinations";
import {
  MAX_MESSAGE_MEDIA_PART_BYTES,
  MAX_MESSAGE_MEDIA_TOTAL_BYTES,
} from "../shared/message-media-limits";
import {
  hasCapability,
} from "./capabilities";
import {
  delegatedAdapterPeerContext,
} from "./peer";
import {
  parseAdapterCommand,
  renderAdapterCommandHelp,
  renderAdapterProcessList,
} from "./adapter-commands";
import type {
  AdapterIngressWorkReturnRecovery,
} from "./adapter-service";
import {
  adapterInteractionOrigin,
  adapterPrivateActivityAt,
  deliverAdapterWorkReturnedEvent,
  describeProcessRoute,
  identityForUid,
  resolveActorId,
  resolveAdapterRoute,
  resolvePrivateDmSelection,
  shortProcessId,
} from "./adapter-routing";
import {
  validateAdapterMediaItems,
} from "./adapter-send";

/** Inbound adapter messages: replay claims, media retention, command handling, and Process delivery. */
type AdapterCommandResult = {
  handled: boolean;
  reply?: {
    text: string;
    replyToId?: string;
  };
};

type AdapterInboundDisposition = Omit<
  AdapterInboundSyscallResult,
  "reply" | "challenge" | "replayed"
> & {
  reply?: {
    text: string;
    replyToId?: string;
  };
  challenge?: {
    code: string;
    prompt: string;
    expiresAt: number;
  };
};

type AdapterIngressProcessRecovery = {
  kind: "process_delivery";
  uid: number;
  pid: string;
  runId: string;
  media: ResourceBlock[];
  origin: Extract<InteractionOrigin, { kind: "adapter" }>;
  routeGeneration?: string;
  conversationId?: string;
  inputMessageId?: string;
  messageCreatedAt?: number;
};

type AdapterIngressRecovery =
  | AdapterIngressProcessRecovery
  | AdapterIngressWorkReturnRecovery;

const resourceBlockRecoverySchema = z.object({
  type: z.literal("resource"),
  ref: z.object({
    type: z.literal("file"),
    target: z.string(),
    path: z.string(),
    revision: z.string(),
    contentType: z.string(),
    size: z.number().check(z.int(), z.nonnegative()),
    expiresAt: z.optional(z.number().check(z.int(), z.nonnegative())),
  }),
  mediaType: z.optional(z.enum(["image", "audio", "video", "document"])),
  filename: z.optional(z.string()),
  duration: z.optional(z.number()),
  transcription: z.optional(z.string()),
});

const adapterInteractionOriginSchema = z.object({
  kind: z.literal("adapter"),
  adapter: z.string(),
  accountId: z.string(),
  surface: adapterSurfaceSchema,
  actorId: z.string(),
  actorLabel: z.optional(z.string()),
  messageId: z.optional(z.string()),
});

const adapterIngressRecoverySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("process_delivery"),
    uid: z.number().check(z.int(), z.nonnegative()),
    pid: z.string(),
    runId: z.string(),
    media: z.array(resourceBlockRecoverySchema),
    origin: adapterInteractionOriginSchema,
    routeGeneration: z.optional(z.string()),
    conversationId: z.optional(z.string()),
    inputMessageId: z.optional(z.string()),
    messageCreatedAt: z.optional(z.number().check(z.int(), z.positive())),
  }),
  z.object({
    kind: z.literal("work_return"),
    uid: z.number().check(z.int(), z.nonnegative()),
    workPid: z.string(),
    route: z.object({
      adapter: z.string(),
      accountId: z.string(),
      actorId: z.string(),
      surfaceKind: z.literal("dm"),
      surfaceId: z.string(),
      threadId: z.optional(z.string()),
      mode: z.enum(["legacy", "work", "surface"]),
    }),
  }),
]);

export async function handleAdapterInbound(
  args: AdapterInboundArgs,
  ctx: KernelContext,
  body?: BinaryBody,
): Promise<AdapterInboundSyscallResult> {
  const startedAt = Date.now();
  try {
    const result = await handleAdapterInboundOwned(args, ctx, body);
    emitTelemetry(ctx.env, {
      installationId: ctx.installationId,
      component: "gateway",
      event: {
        stream: "operational",
        name: "adapter.ingress.finished",
        properties: {
          adapter: args.adapter.trim().toLowerCase(),
          outcome: !result.ok
            ? "error"
            : result.replayed
              ? "replayed"
              : result.delivered
                ? "delivered"
                : result.challenge
                  ? "challenge"
                  : result.reply
                    ? "handled"
                    : "dropped",
          surface: args.message.surface.kind,
          hasMedia: Boolean(args.message.media?.length),
          durationMs: Math.max(0, Date.now() - startedAt),
        },
      },
    });
    return result;
  } catch (error) {
    emitTelemetry(ctx.env, {
      installationId: ctx.installationId,
      component: "gateway",
      event: {
        stream: "operational",
        name: "adapter.ingress.finished",
        properties: {
          adapter: args.adapter.trim().toLowerCase(),
          outcome: "error",
          surface: args.message.surface.kind,
          hasMedia: Boolean(args.message.media?.length),
          durationMs: Math.max(0, Date.now() - startedAt),
        },
      },
    });
    throw error;
  } finally {
    await cancelBinaryBody(body, "adapter.inbound completed");
  }
}

async function handleAdapterInboundOwned(
  args: AdapterInboundArgs,
  ctx: KernelContext,
  body: BinaryBody | undefined,
): Promise<AdapterInboundSyscallResult> {
  const identity = ctx.identity;
  if (!identity || identity.role !== "service") {
    throw new Error("adapter.inbound requires a service identity");
  }

  const adapter = args.adapter.trim().toLowerCase();
  const accountId = args.accountId.trim();
  const providerDeliveryId = args.deliveryId.trim();
  const routeGeneration = args.routeGeneration?.trim() || undefined;
  const inbound = args.message;

  if (!adapter) return { ok: false, error: "adapter is required" };
  if (!accountId) return { ok: false, error: "accountId is required" };
  if (!providerDeliveryId) return { ok: false, error: "deliveryId is required" };
  if (args.routeGeneration !== undefined && routeGeneration === undefined) {
    return { ok: false, error: "routeGeneration is required when provided" };
  }
  if (!inbound.messageId.trim()) {
    return { ok: false, error: "message.messageId is required" };
  }
  if (!inbound.surface.id.trim()) {
    return { ok: false, error: "message.surface.id is required" };
  }
  const surface: AdapterSurface = {
    ...inbound.surface,
    id: inbound.surface.id.trim(),
  };
  const threadId = inbound.surface.threadId?.trim();
  if (threadId) surface.threadId = threadId;
  else delete surface.threadId;
  const message: AdapterInboundMessage = {
    ...inbound,
    messageId: inbound.messageId.trim(),
    surface,
    replyToId: inbound.replyToId?.trim() || undefined,
  };
  if (inbound.actor) message.actor = { ...inbound.actor, id: inbound.actor.id.trim() };

  const actorId = resolveActorId(message);
  if (!actorId) {
    return { ok: false, error: "message.actor.id is required" };
  }

  const candidateReceiptId = await stableOpaqueId("adapter-ingress", [
    adapter,
    accountId,
    providerDeliveryId,
  ]);
  const receipt = ctx.adapters.ingressReceipts.claim({
    receiptId: candidateReceiptId,
    adapter,
    accountId,
    actorId,
    surfaceKind: message.surface.kind,
    surfaceId: message.surface.id,
    threadId: message.surface.threadId,
    providerMessageId: message.messageId,
    providerDeliveryId,
  });
  if (receipt.state === "ambiguous") {
    return { ok: false, error: receipt.error };
  }
  if (receipt.state === "in_progress") {
    return {
      ok: true,
      droppedReason: "duplicate_in_progress",
      replayed: "in_progress",
    };
  }
  if (receipt.state === "completed") {
    return { ...receipt.result, replayed: "completed" };
  }
  const receiptId = receipt.receiptId;
  const replyDeliveryId = `${receiptId}:reply`;
  const challengeDeliveryId = `${receiptId}:challenge`;
  const claimToken = receipt.claimToken;
  try {
    if (receipt.state === "prepared") {
      ctx.adapters.ingressReceipts.complete(receiptId, claimToken);
      return { ...receipt.result, replayed: "completed" };
    }

    const disposition = await resolveClaimedAdapterInbound({
      receiptId,
      claimToken,
      recovery: receipt.recovery,
      adapter,
      accountId,
      actorId,
      routeGeneration,
      message,
      body,
      ctx,
    });
    const {
      reply: immediateReply,
      challenge: immediateChallenge,
      ...baseDisposition
    } = disposition;
    const result: AdapterInboundSyscallResult = { ...baseDisposition };
    if (immediateReply) {
      result.reply = { deliveryId: replyDeliveryId, ...immediateReply };
    }
    if (immediateChallenge) {
      result.challenge = { deliveryId: challengeDeliveryId, ...immediateChallenge };
    }
    ctx.adapters.ingressReceipts.prepare(receiptId, claimToken, result);
    ctx.adapters.ingressReceipts.complete(receiptId, claimToken);
    return result;
  } catch (error) {
    ctx.adapters.ingressReceipts.abandon(receiptId, claimToken);
    throw error;
  }
}

async function resolveClaimedAdapterInbound(input: {
  receiptId: string;
  claimToken: string;
  recovery?: JsonValue;
  adapter: string;
  accountId: string;
  actorId: string;
  routeGeneration?: string;
  message: AdapterInboundMessage;
  body?: BinaryBody;
  ctx: KernelContext;
}): Promise<AdapterInboundDisposition> {
  const {
    receiptId,
    claimToken,
    adapter,
    accountId,
    actorId,
    routeGeneration,
    message,
    body,
    ctx,
  } = input;
  const recovery = normalizeAdapterIngressRecovery(input.recovery);
  const link = ctx.adapters.identityLinks.get(adapter, accountId, actorId);
  const uid = ctx.adapters.identityLinks.resolveUid(adapter, accountId, actorId);
  const linkedRouteGeneration = link
    ? identityLinkRouteGeneration(link, message.surface)
    : undefined;
  if (
    (link?.metadata?.managed === true
      && (!linkedRouteGeneration || routeGeneration !== linkedRouteGeneration))
    || (link?.metadata?.managed !== true && routeGeneration !== undefined)
  ) {
    return { ok: true, droppedReason: "stale_route_generation" };
  }
  if (uid === null) {
    if (message.surface.kind !== "dm") {
      return { ok: true, droppedReason: "unlinked_actor" };
    }

    const challenge = ctx.adapters.linkChallenges.issue({
      adapter,
      accountId,
      actorId,
      surfaceKind: message.surface.kind,
      surfaceId: message.surface.id,
    });

    return {
      ok: true,
      challenge: {
        code: challenge.code,
        prompt: `UNKNOWN USER. Who are you? 🧐.\n\nIdentify yourself in your GSV by using this access code: ${challenge.code}`,
        expiresAt: challenge.expiresAt,
      },
    };
  }

  if (message.surface.kind !== "dm" && message.wasMentioned !== true) {
    return { ok: true, droppedReason: "not_addressed" };
  }

  const userIdentity = identityForUid(uid, ctx);
  if (!userIdentity) {
    return { ok: false, error: `Unknown local user uid=${uid}` };
  }

  if (recovery === null && message.surface.kind === "dm") {
    const existingLink = ctx.adapters.identityLinks.get(adapter, accountId, actorId);
    const link = existingLink?.uid === uid
      ? ctx.adapters.identityLinks.bindSurfaceIfMissing(
          adapter,
          accountId,
          actorId,
          message.surface,
        ) ?? existingLink
      : existingLink;
    if (link?.uid === uid && identityLinkAllowsSurface(link, message.surface)) {
      ctx.adapters.privateDestinations.recordActivity(uid, {
        kind: "adapter",
        adapter,
        accountId,
        actorId,
        surface: message.surface,
      }, message.messageId, adapterPrivateActivityAt(message.timestamp));
    }
  }

  if (recovery?.kind === "process_delivery") {
    if (recovery.uid !== uid) {
      return { ok: false, error: "Adapter ingress owner changed during recovery" };
    }
    if (recovery.routeGeneration !== routeGeneration) {
      return { ok: true, droppedReason: "stale_route_generation" };
    }
    return deliverAdapterInboundToProcess({
      adapter,
      accountId,
      actorId,
      message,
      routeGeneration,
      ctx,
      recovery,
      checkpoint: { receiptId, claimToken },
    });
  }
  if (recovery?.kind === "work_return") {
    if (recovery.uid !== uid) {
      return { ok: false, error: "Adapter ingress owner changed during recovery" };
    }
    const personalPid = await deliverAdapterWorkReturnedEvent(
      recovery,
      receiptId,
      message.messageId,
      ctx,
    );
    if (!personalPid) {
      return { ok: true, droppedReason: "superseded_work_return" };
    }
    const personal = ctx.procs.get(personalPid);
    return {
      ok: true,
      reply: {
        text: `[SHIP] Returned to ${personal ? describeProcessRoute(personal) : shortProcessId(personalPid)}.`,
        replyToId: message.messageId,
      },
    };
  }

  const command = await handleAdapterCommand({
    adapter,
    accountId,
    message,
    uid,
    receiptId,
    claimToken,
    ctx,
  });
  if (command.handled) {
    const disposition: AdapterInboundDisposition = { ok: true };
    if (command.reply) disposition.reply = command.reply;
    return disposition;
  }

  const pid = await resolveAdapterRoute(
    adapter,
    accountId,
    actorId,
    message.surface,
    uid,
    receiptId,
    userIdentity,
    ctx,
  );
  return deliverAdapterInboundToProcess({
    adapter,
    accountId,
    actorId,
    message,
    body,
    routeGeneration,
    uid,
    pid,
    ctx,
    checkpoint: { receiptId, claimToken },
  });
}

async function deliverAdapterInboundToProcess(input: {
  adapter: string;
  accountId: string;
  actorId: string;
  message: AdapterInboundMessage;
  ctx: KernelContext;
  body?: BinaryBody;
  routeGeneration?: string;
  uid?: number;
  pid?: string;
  recovery?: AdapterIngressProcessRecovery;
  checkpoint?: { receiptId: string; claimToken: string };
}): Promise<AdapterInboundDisposition> {
  const { adapter, accountId, actorId, message, ctx } = input;
  let recovery = input.recovery;
  if (!recovery) {
    if (input.uid === undefined || !input.pid || !input.checkpoint) {
      throw new Error("Adapter ingress process delivery is missing claim state");
    }
    const runId = await stableOpaqueId(
      "adapter-run",
      [input.checkpoint.receiptId],
    );
    const media = await storeAdapterInboundMedia(
      ctx.installationId,
      input.pid,
      runId,
      message.media,
      input.body,
      ctx.requestSignal,
    );
    const conversation = conversationForAdapterInbound(
      input.uid,
      input.pid,
      adapter,
      accountId,
      message,
      ctx,
    );
    await getConversationById(ctx.installationId, conversation.id).initialize({
      ownerUid: conversation.ownerUid,
      kind: conversation.kind,
    });
    const inputMessageId = await stableOpaqueId("msg", [
      conversation.id,
      input.checkpoint.receiptId,
      "input",
    ]);
    recovery = {
      kind: "process_delivery",
      uid: input.uid,
      pid: input.pid,
      runId,
      media: media ?? [],
      origin: adapterInteractionOrigin(adapter, accountId, message, actorId),
      ...(input.routeGeneration === undefined
        ? undefined
        : { routeGeneration: input.routeGeneration }),
      conversationId: conversation.id,
      inputMessageId,
      messageCreatedAt: normalizeAdapterMessageCreatedAt(message.timestamp),
    };
    ctx.adapters.ingressReceipts.checkpoint(
      input.checkpoint.receiptId,
      input.checkpoint.claimToken,
      recovery,
    );
  }
  if (!recovery) {
    throw new Error("Adapter ingress process delivery is missing recovery state");
  }

  if (!hasConversationRecovery(recovery)) {
    if (!input.checkpoint) {
      throw new Error("Legacy adapter ingress recovery is missing claim state");
    }
    const conversation = conversationForAdapterInbound(
      recovery.uid,
      recovery.pid,
      adapter,
      accountId,
      message,
      ctx,
    );
    await getConversationById(ctx.installationId, conversation.id).initialize({
      ownerUid: conversation.ownerUid,
      kind: conversation.kind,
    });
    recovery = {
      ...recovery,
      conversationId: conversation.id,
      inputMessageId: await stableOpaqueId("msg", [
        conversation.id,
        input.checkpoint.receiptId,
        "input",
      ]),
      messageCreatedAt: normalizeAdapterMessageCreatedAt(message.timestamp),
    };
    ctx.adapters.ingressReceipts.checkpoint(
      input.checkpoint.receiptId,
      input.checkpoint.claimToken,
      recovery,
    );
  }
  if (!hasConversationRecovery(recovery)) {
    throw new Error("Adapter ingress recovery is missing conversation state");
  }

  const { uid, pid, runId, origin } = recovery;
  const media = recovery.media.length > 0 ? recovery.media : undefined;
  const conversation = ctx.conversations.get(recovery.conversationId);
  if (!conversation || conversation.ownerUid !== uid) {
    throw new Error("Adapter ingress conversation is unavailable");
  }
  const appendRequest: ConversationAppendRequest = {
    messageId: recovery.inputMessageId,
    idempotencyKey: `adapter-input:${runId}`,
    author: { kind: "user", uid },
    text: message.text?.trim() || "",
    mediaOwner: (() => {
      const process = ctx.procs.get(pid);
      if (!process) throw new Error("Adapter ingress process is unavailable");
      return {
        pid,
        uid: process.uid,
        gid: process.gid,
        home: process.home,
      };
    })(),
    origin: adapterConversationOrigin(adapter, accountId, actorId, message),
    processId: pid,
    runId,
    createdAt: recovery.messageCreatedAt,
  };
  if (media) appendRequest.media = media;
  const appended = await getConversationById(ctx.installationId, conversation.id).append(
    appendRequest,
  );
  ctx.conversations.recordSequence(conversation.id, appended.message.sequence);
  if (appended.created) {
    ctx.broadcastToUserUid(uid, "message.committed", {
      message: appended.message,
      directed: false,
    });
    ctx.broadcastToUserUid(uid, "conversation.changed", {
      conversationId: conversation.id,
      latestSequence: appended.message.sequence,
    });
  }
  if (message.surface.kind !== "dm") {
    ctx.adapters.surfaceRoutes.setRoute({
      adapter,
      accountId,
      actorId,
      surfaceKind: message.surface.kind,
      surfaceId: message.surface.id,
      threadId: message.surface.threadId,
      uid,
      pid,
      mode: "surface",
      updatedByUid: uid,
    });
  }
  ctx.runRoutes.setAdapterRoute({
    runId,
    processId: pid,
    uid,
    destination: {
      kind: "adapter",
      adapter,
      accountId,
      actorId,
      surface: message.surface,
    },
    replyToId: message.messageId,
    ...(recovery.routeGeneration === undefined
      ? undefined
      : { routeGeneration: recovery.routeGeneration }),
  });
  // Adapter ingress is itself an RPC from the adapter. Calling activity back
  // into a stateful adapter here would re-enter its Durable Object before this
  // request can return. Process lifecycle signals own typing activity.
  const request: InternalRequestFrame<"proc.adapter.deliver"> = {
    type: "req",
    id: crypto.randomUUID(),
    call: "proc.adapter.deliver",
    args: {
      runId,
      pid,
      message: message.text?.trim() || "",
      media,
      origin,
      interaction: {
        conversationId: conversation.id,
        messageId: appended.message.id,
      },
    },
  };
  const response: InternalResponseFrame<"proc.adapter.deliver"> | null = await sendFrameToProcess(
    ctx.installationId,
    pid,
    request,
  );

  if (!response || response.type !== "res") {
    throw new Error("No response from process");
  }
  if (!response.ok) {
    throw new Error(response.error.message);
  }

  const data = response.data;
  if (!data.ok) {
    ctx.runRoutes.delete(runId);
    return { ok: false, error: data.error };
  }
  const queued = data.queued === true;
  if (data.runId !== runId) {
    ctx.runRoutes.delete(runId);
    return { ok: false, error: "proc.adapter.deliver admitted an unexpected run" };
  }
  if (data.replayed === "recorded") {
    ctx.runRoutes.delete(runId);
  }

  return {
    ok: true,
    delivered: { uid, pid, runId, queued },
  };
}

function normalizeAdapterIngressRecovery(value: JsonValue | undefined): AdapterIngressRecovery | null {
  if (value === undefined) return null;
  const parsed = adapterIngressRecoverySchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("Invalid adapter ingress recovery checkpoint");
  }
  const recovery: AdapterIngressRecovery = parsed.data;
  if (recovery.kind === "process_delivery") {
    const present = [
      recovery.conversationId,
      recovery.inputMessageId,
      recovery.messageCreatedAt,
    ].filter((field) => field !== undefined).length;
    if (present !== 0 && present !== 3) {
      throw new Error("Invalid adapter ingress recovery checkpoint");
    }
  }
  return recovery;
}

function hasConversationRecovery(
  recovery: AdapterIngressProcessRecovery,
): recovery is AdapterIngressProcessRecovery & {
  conversationId: string;
  inputMessageId: string;
  messageCreatedAt: number;
} {
  return recovery.conversationId !== undefined
    && recovery.inputMessageId !== undefined
    && recovery.messageCreatedAt !== undefined;
}

function conversationForAdapterInbound(
  uid: number,
  pid: string,
  adapter: string,
  accountId: string,
  message: AdapterInboundMessage,
  ctx: KernelContext,
) {
  const process = ctx.procs.get(pid);
  if (!process || process.ownerUid !== uid || !process.interactive) {
    throw new Error("Adapter conversation handler is unavailable");
  }
  if (message.surface.kind === "dm") {
    return process.isPersonalController
      ? ctx.conversations.ensureShip(uid, pid)
      : ctx.conversations.ensureWork(uid, pid, process.label);
  }
  return ctx.conversations.ensureGroup(
    uid,
    pid,
    message.surface.name?.trim()
      || message.surface.handle?.trim()
      || `${adapter} ${message.surface.kind}`,
    adapterConversationSurfaceKey(adapter, accountId, message),
  );
}

function adapterConversationSurfaceKey(
  adapter: string,
  accountId: string,
  message: AdapterInboundMessage,
): string {
  return JSON.stringify([
    adapter,
    accountId,
    message.surface.kind,
    message.surface.id,
    message.surface.threadId ?? "",
  ]);
}

function adapterConversationOrigin(
  adapter: string,
  accountId: string,
  actorId: string,
  message: AdapterInboundMessage,
): ConversationMessageOrigin {
  const surface: Extract<ConversationMessageOrigin, { kind: "adapter" }>["surface"] = {
    kind: message.surface.kind,
    id: message.surface.id,
  };
  if (message.surface.threadId) surface.threadId = message.surface.threadId;
  return {
    kind: "adapter",
    adapter,
    accountId,
    actorId,
    surface,
    providerMessageId: message.messageId,
  };
}

function normalizeAdapterMessageCreatedAt(timestamp: number | undefined): number {
  if (timestamp === undefined || !Number.isFinite(timestamp) || timestamp <= 0) {
    return Date.now();
  }
  const milliseconds = timestamp < 10_000_000_000 ? timestamp * 1_000 : timestamp;
  return Math.max(1, Math.min(Date.now() + 5 * 60 * 1_000, Math.floor(milliseconds)));
}

async function storeAdapterInboundMedia(
  installationId: KernelContext["installationId"],
  pid: string,
  runId: string,
  media: AdapterInboundMessage["media"],
  body: BinaryBody | undefined,
  signal?: AbortSignal,
): Promise<ResourceBlock[] | undefined> {
  validateAdapterMediaItems(media, "inbound");
  const stored: ResourceBlock[] = [];
  await consumeAdapterMediaBodyParts(media, body, async ({
      mediaIndex,
      media: item,
      body: partBody,
    }) => {
      const request: InternalRequestFrame<"proc.resource.write"> = {
        type: "req",
        id: crypto.randomUUID(),
        call: "proc.resource.write",
        args: {
          resourceId: `${runId}:${mediaIndex}`,
          mediaType: item.type,
          contentType: item.mimeType,
          filename: item.filename,
          duration: item.duration,
          transcription: item.transcription,
        },
        body: partBody,
      };
      const response = await sendFrameToProcess(installationId, pid, request);
      if (!response || response.type !== "res" || !response.ok) {
        throw new Error(response && response.type === "res" && !response.ok
          ? response.error.message
          : "No response while storing adapter media");
      }
      stored.push(response.data.resource);
    }, {
      maxBytes: MAX_MESSAGE_MEDIA_TOTAL_BYTES,
      maxPartBytes: MAX_MESSAGE_MEDIA_PART_BYTES,
      signal,
    });
  return stored.length > 0 ? stored : undefined;
}

async function handleAdapterCommand(args: {
  adapter: string;
  accountId: string;
  message: AdapterInboundMessage;
  uid: number;
  receiptId: string;
  claimToken: string;
  ctx: KernelContext;
}): Promise<AdapterCommandResult> {
  const { adapter, accountId, message, uid, receiptId, claimToken, ctx } = args;
  if (message.surface.kind !== "dm") {
    return { handled: false };
  }

  const parsed = parseAdapterCommand(message.text);
  if (!parsed) {
    return { handled: false };
  }
  const actorId = resolveActorId(message);
  if (!actorId) {
    return replyToAdapterCommand(message, "This adapter message has no linked actor identity.");
  }
  const routeKey = {
    adapter,
    accountId,
    actorId,
    surfaceKind: message.surface.kind,
    surfaceId: message.surface.id,
    threadId: message.surface.threadId,
    uid,
  };

  if (parsed.name === "help") {
    return replyToAdapterCommand(message, renderAdapterCommandHelp());
  }

  if (parsed.name && parsed.args.length > 0) {
    return replyToAdapterCommand(
      message,
      `/${parsed.name ?? parsed.rawName.slice(1)} does not accept arguments.\n\n${renderAdapterCommandHelp()}`,
    );
  }

  if (parsed.name === "list") {
    const userIdentity = identityForUid(uid, ctx);
    if (!userIdentity) {
      return replyToAdapterCommand(message, "Your linked GSV user no longer exists.");
    }
    const allowedCalls = ["proc.list"].filter((call) =>
      hasCapability(ctx.caps.resolve(userIdentity.gids), call)
    );
    const peer = delegatedAdapterPeerContext({
      installationId: ctx.installationId,
      serviceId: adapter,
      accountId,
      actorId,
      surface: message.surface,
      sessionId: `adapter:${receiptId}`,
      identity: userIdentity,
      calls: allowedCalls,
    });
    const request: RequestFrame<"proc.list"> = {
      type: "req",
      id: crypto.randomUUID(),
      call: "proc.list",
      args: {},
    };
    const response = await ctx.request?.(
      request,
      {
        ...ctx,
        peer,
        identity: peer.identity,
        callerOwnerUid: uid,
      },
      ctx.requestSignal,
    );
    if (!response) {
      throw new Error("Adapter command dispatch is unavailable");
    }
    if (!response.ok) {
      return replyToAdapterCommand(message, `Unable to list work: ${response.error.message}`);
    }
    // SAFETY: The shared dispatcher correlates this response with the typed proc.list request above.
    return replyToAdapterCommand(
      message,
      renderAdapterProcessList((response.data as ProcListResult).processes),
    );
  }

  if (parsed.name === "where") {
    const selection = await resolvePrivateDmSelection(routeKey, uid, ctx);
    return replyToAdapterCommand(
      message,
      selection.route
        ? `[INTERNAL WORK / WORK SESSION] ${describeProcessRoute(selection.process)} [${selection.process.state}]. Use /ship to return.`
        : `[SHIP] ${describeProcessRoute(selection.process)} [${selection.process.state}].`,
    );
  }

  if (parsed.name === "ship") {
    const selectedRoute = ctx.adapters.surfaceRoutes.resolveRoute(routeKey);
    if (!selectedRoute) {
      const personalPid = await ensurePersonalController(uid, ctx);
      const personal = ctx.procs.get(personalPid);
      return replyToAdapterCommand(
        message,
        `[SHIP] Already using ${personal ? describeProcessRoute(personal) : shortProcessId(personalPid)}.`,
      );
    }

    const recovery: AdapterIngressWorkReturnRecovery = {
      kind: "work_return",
      uid,
      workPid: selectedRoute.pid,
      route: {
        adapter: selectedRoute.adapter,
        accountId: selectedRoute.accountId,
        actorId: selectedRoute.actorId,
        surfaceKind: "dm",
        surfaceId: selectedRoute.surfaceId,
        mode: selectedRoute.mode,
      },
    };
    if (selectedRoute.threadId) recovery.route.threadId = selectedRoute.threadId;
    ctx.adapters.ingressReceipts.checkpoint(receiptId, claimToken, recovery);
    const personalPid = await deliverAdapterWorkReturnedEvent(
      recovery,
      receiptId,
      message.messageId,
      ctx,
    );
    if (!personalPid) {
      return { handled: true };
    }
    const personal = ctx.procs.get(personalPid);
    return replyToAdapterCommand(
      message,
      `[SHIP] Returned to ${personal ? describeProcessRoute(personal) : shortProcessId(personalPid)}.`,
    );
  }

  return replyToAdapterCommand(
    message,
    `Unknown command: ${parsed.rawName}\n\n${renderAdapterCommandHelp()}`,
  );
}

function replyToAdapterCommand(message: AdapterInboundMessage, text: string): AdapterCommandResult {
  return {
    handled: true,
    reply: {
      text,
      replyToId: message.messageId,
    },
  };
}

