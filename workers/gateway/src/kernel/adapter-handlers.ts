import type {
  AdapterActivity,
  AdapterInboundMessage,
  AdapterAccountStatus,
  AdapterInstallationContext,
  AdapterMedia,
  AdapterDeliveryContext,
  AdapterPairingCandidate,
  AdapterPairingPreparation,
  AdapterPairingWorkerInterface,
  AdapterService,
  AdapterServiceDescriptor,
  AdapterSurface,
} from "../adapter-interface";
import type { InternalRequestFrame, InternalResponseFrame } from "../protocol/process-frames";
import type {
  AdapterConnectArgs,
  AdapterConnectConfig,
  AdapterConnectResult as AdapterConnectSyscallResult,
  AdapterDisconnectArgs,
  AdapterDisconnectResult as AdapterDisconnectSyscallResult,
  AdapterInboundArgs,
  AdapterInboundSyscallResult,
  AdapterMessageDestination,
  InteractionOrigin,
  AdapterListArgs,
  AdapterListEntry,
  AdapterListResult,
  AdapterPairConfirmArgs,
  AdapterPairConfirmResult,
  AdapterPairDisconnectArgs,
  AdapterPairDisconnectResult,
  AdapterPairInfoArgs,
  AdapterPairInfoResult,
  AdapterPairInspectArgs,
  AdapterPairInspectResult,
  AdapterStateUpdateArgs,
  AdapterStateUpdateResult,
  AdapterSendArgs,
  AdapterSendResult,
  AdapterStatusArgs,
  AdapterStatusResult,
  AdapterWorkerConnectResult,
  AdapterWorkerDisconnectResult,
  BinaryBody,
  ProcListResult,
  ResourceBlock,
  ProcessIdentity,
  ConversationMessageOrigin,
  JsonValue,
} from "@humansandmachines/gsv/protocol";
import {
  binaryBodySchema,
  cancelBinaryBody,
  consumeAdapterMediaBodyParts,
  adapterAccountStatusSchema,
  adapterWorkerActivityResultSchema,
  adapterWorkerConnectResultSchema,
  adapterWorkerDisconnectResultSchema,
  adapterSendResultSchema,
  adapterSurfaceSchema,
  validateAdapterMediaBody,
} from "@humansandmachines/gsv/protocol";
import { adapterServiceDescriptorSchema } from "@humansandmachines/gsv/services/adapters";
import { emitTelemetry } from "@humansandmachines/gsv/telemetry";
import type {
  AdapterTargetCancelResult,
  AdapterTargetDescriptor,
  AdapterTargetResponseFrame,
} from "@humansandmachines/gsv/services/adapters";
import * as z from "zod/mini";
import { resolveCallerOwnerUid, type KernelContext } from "./context";
import type { GatewayEnv } from "../runtime-env";
import type { RequestFrame } from "../protocol/frames";
import { getConversationById, sendFrameToProcess } from "../shared/utils";
import type { ConversationAppendRequest } from "../conversation/do";
import { stableOpaqueId } from "../shared/stable-id";
import { ensurePersonalAgent } from "./agents";
import { ensurePersonalController } from "./personal-controller";
import type { ProcessRecord } from "./processes";
import type { SurfaceRouteRecord } from "./surface-routes";
import type { AdapterStatusRecord } from "./adapter-status";
import { recordAdapterStatusTransition } from "./lifecycle-responsibilities";
import type { IdentityLinkRecord } from "./identity-links";
import {
  assertAdapterMessageDestinationAccess,
  identityLinkAllowsSurface,
  identityLinkRouteGeneration,
  normalizeAdapterMessageDestination,
  normalizeAdapterSurface,
} from "./adapter-destinations";
import {
  MAX_MESSAGE_MEDIA_ITEMS,
  MAX_MESSAGE_MEDIA_PART_BYTES,
  MAX_MESSAGE_MEDIA_TOTAL_BYTES,
} from "../shared/message-media-limits";
import { SINGLETON_INSTALLATION_ID } from "../installation/identity";
import { isLocked } from "../auth/shadow";
import { hasCapability } from "./capabilities";
import { delegatedAdapterPeerContext } from "./peer";
import {
  parseAdapterCommand,
  renderAdapterCommandHelp,
  renderAdapterProcessList,
} from "./adapter-commands";

type AdapterTargetServiceBinding = {
  adapterTargetList(
    ...args: Parameters<NonNullable<AdapterService["adapterTargetList"]>>
  ): Promise<AdapterTargetDescriptor[] & Disposable>;
  adapterTargetExecute(
    ...args: Parameters<NonNullable<AdapterService["adapterTargetExecute"]>>
  ): Promise<AdapterTargetResponseFrame & Disposable>;
  adapterTargetCancel(
    ...args: Parameters<NonNullable<AdapterService["adapterTargetCancel"]>>
  ): Promise<AdapterTargetCancelResult & Disposable>;
};
export type AdapterServiceBinding = Fetcher
  & Partial<Omit<
    AdapterService,
    "adapterTargetList" | "adapterTargetExecute" | "adapterTargetCancel"
  >>
  & Partial<AdapterTargetServiceBinding>
  & Partial<AdapterPairingWorkerInterface>;
type AdapterBindingEnv = GatewayEnv & Record<
  `CHANNEL_${string}`,
  AdapterServiceBinding | undefined
>;
const adapterStatusListSchema = z.array(adapterAccountStatusSchema);
const adapterFrameBodySchema = z.object({ body: binaryBodySchema });
type AdapterCommandResult = {
  handled: boolean;
  reply?: {
    text: string;
    replyToId?: string;
  };
};
export type AdapterDeliveryPresentation = {
  processId: string;
  runId: string;
  processMode?: AdapterDeliveryContext["processMode"];
  shipDisplaced?: boolean;
  hil?: AdapterDeliveryContext["hil"];
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
type AdapterIngressWorkReturnRecovery = {
  kind: "work_return";
  uid: number;
  workPid: string;
  route: {
    adapter: string;
    accountId: string;
    actorId: string;
    surfaceKind: "dm";
    surfaceId: string;
    threadId?: string;
    mode: SurfaceRouteRecord["mode"];
  };
};
type AdapterIngressRecovery =
  | AdapterIngressProcessRecovery
  | AdapterIngressWorkReturnRecovery;

const pairingInfoSchema = z.object({
  accountId: z.string().check(z.minLength(1)),
  configured: z.boolean(),
  botUsername: z.optional(z.string()),
  installUrl: z.optional(z.string().check(z.minLength(1))),
});
const pairingCandidateSchema = z.object({
  accountId: z.string().check(z.minLength(1), z.maxLength(200)),
  actorId: z.string().check(z.minLength(1), z.maxLength(200)),
  surfaceId: z.string().check(z.minLength(1), z.maxLength(200)),
  routeScope: z.optional(z.enum(["surface", "actor"])),
  actorName: z.optional(z.string()),
  actorHandle: z.optional(z.string()),
  expiresAt: z.number(),
  linked: z.boolean(),
});
const pairingRouteSchema = z.object({
  installationId: z.string(),
  localUid: z.number().check(z.int(), z.nonnegative()),
  generation: z.string().check(
    z.regex(/^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,190}[A-Za-z0-9])?$/),
  ),
});
const pairingPreparationSchema = z.object({
  candidate: pairingCandidateSchema,
  route: pairingRouteSchema,
  previousRoute: z.optional(pairingRouteSchema),
});
const managedIdentityLinkMetadataSchema = z.looseObject({
  managed: z.literal(true),
  surfaceId: z.string().check(z.minLength(1)),
  routeScope: z.optional(z.enum(["surface", "actor"])),
  routeGeneration: z.string().check(z.minLength(1)),
});
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
const adapterSurfaceKindSchema = z.enum(["dm", "group", "channel", "thread"]);
const optionalStringSchema = z.optional(z.string());
const optionalBooleanSchema = z.optional(z.boolean());

function adapterSendBoundaryError(args: AdapterSendArgs): string | null {
  if (!adapterSurfaceKindSchema.safeParse(args.surface?.kind).success) {
    return "surface.kind is invalid";
  }
  if (!z.string().check(z.minLength(1)).safeParse(args.surface?.id).success) {
    return "surface.id is required";
  }
  if (!z.string().safeParse(args.text).success) {
    return "text must be a string";
  }
  if (!optionalStringSchema.safeParse(args.replyToId).success) {
    return "replyToId must be a string";
  }
  if (!optionalBooleanSchema.safeParse(args.also).success) {
    return "also must be a boolean";
  }
  if (!optionalStringSchema.safeParse(args.deliveryId).success) {
    return "Adapter deliveryId is invalid";
  }
  return null;
}

export function resolveAdapterService(
  env: GatewayEnv,
  adapter: string,
): AdapterServiceBinding | null {
  const key: `CHANNEL_${string}` = `CHANNEL_${adapter.trim().toUpperCase()}`;
  // SAFETY: CHANNEL_* is the Wrangler service-binding namespace for adapters.
  return (env as AdapterBindingEnv)[key] ?? null;
}

export async function handleAdapterConnect(
  args: AdapterConnectArgs,
  ctx: KernelContext,
): Promise<AdapterConnectSyscallResult> {
  const adapter = normalizeAdapterName(args.adapter);
  const accountId = args.accountId.trim();

  if (!adapter) return { ok: false, error: "adapter is required" };
  if (!accountId) return { ok: false, error: "accountId is required" };
  const ownerUid = requireAdapterControlOwnerUid(ctx, "adapter.connect");

  const service = resolveAdapterService(ctx.env, adapter);
  if (!service) {
    return { ok: false, error: `Adapter service unavailable: ${adapter}` };
  }
  if (!service.adapterConnect) {
    return { ok: false, error: `Adapter service does not implement connect: ${adapter}` };
  }

  const previousStatus = ctx.adapters.status.get(adapter, accountId);
  const needsOwnerClaim = adapterAccountNeedsOwnerClaim(ctx, adapter, accountId, ownerUid);
  ctx.adapters.status.beginLifecycle(adapter, accountId);
  try {
    if (needsOwnerClaim) {
      ctx.adapters.status.setOwner(adapter, accountId, ownerUid);
    }
    let connectResult: AdapterWorkerConnectResult;
    try {
      const decoded = adapterWorkerConnectResultSchema.safeParse(
        await callAdapterConnect(service, ctx, accountId, args.config),
      );
      if (!decoded.success) {
        logAdapterBoundaryFailure("error", "connect_invalid_response");
        return { ok: false, error: `Adapter returned an invalid connect response: ${adapter}` };
      }
      connectResult = decoded.data;
    } catch {
      logAdapterBoundaryFailure("error", "connect_worker_failed");
      return { ok: false, error: `Adapter connect failed: ${adapter}` };
    }
    if (!connectResult.ok) {
      return {
        ok: false,
        error: connectResult.error,
        challenge: connectResult.challenge,
      };
    }

    const previous = ctx.adapters.status.get(adapter, accountId);
    ctx.adapters.status.upsert(adapter, accountId, {
      accountId,
      connected: connectResult.connected,
      authenticated: connectResult.authenticated,
      mode: previous?.mode,
      lastActivity: previous?.lastActivity,
      error: undefined,
      extra: previous?.extra,
    });
    const status = await refreshAdapterStatus(service, ctx, adapter, accountId);
    const connected = status?.connected ?? connectResult.connected;
    const authenticated = status?.authenticated ?? connectResult.authenticated;
    const currentStatus = ctx.adapters.status.get(adapter, accountId);
    if (currentStatus) {
      recordAdapterStatusTransition(previousStatus, currentStatus, ctx, {
        suppressAuthenticationRequired: true,
      });
    }

    return {
      ok: true,
      adapter,
      accountId,
      connected,
      authenticated,
      message: connectResult.message,
      challenge: connectResult.challenge,
    };
  } finally {
    ctx.adapters.status.endLifecycle(adapter, accountId);
  }
}

export async function handleAdapterDisconnect(
  args: AdapterDisconnectArgs,
  ctx: KernelContext,
): Promise<AdapterDisconnectSyscallResult> {
  const adapter = normalizeAdapterName(args.adapter);
  const accountId = args.accountId.trim();

  if (!adapter) return { ok: false, error: "adapter is required" };
  if (!accountId) return { ok: false, error: "accountId is required" };

  const ownerUid = requireAdapterControlOwnerUid(ctx, "adapter.disconnect");
  const previousStatus = ctx.adapters.status.get(adapter, accountId);
  if (ownerUid !== 0 && previousStatus?.ownerUid !== ownerUid) {
    throw new Error(`Permission denied: adapter account ${adapter}/${accountId}`);
  }

  const service = resolveAdapterService(ctx.env, adapter);
  if (!service) {
    return { ok: false, error: `Adapter service unavailable: ${adapter}` };
  }
  if (!service.adapterDisconnect) {
    return { ok: false, error: `Adapter service does not implement disconnect: ${adapter}` };
  }

  ctx.adapters.status.beginLifecycle(adapter, accountId);
  try {
    let result: AdapterWorkerDisconnectResult;
    try {
      const decoded = adapterWorkerDisconnectResultSchema.safeParse(
        await callAdapterDisconnect(service, ctx, accountId),
      );
      if (!decoded.success) {
        logAdapterBoundaryFailure("error", "disconnect_invalid_response");
        return { ok: false, error: `Adapter returned an invalid disconnect response: ${adapter}` };
      }
      result = decoded.data;
    } catch {
      logAdapterBoundaryFailure("error", "disconnect_worker_failed");
      return { ok: false, error: `Adapter disconnect failed: ${adapter}` };
    }
    if (!result.ok) {
      return { ok: false, error: result.error };
    }

    // Keep local status store conservative even if adapter status polling fails.
    ctx.adapters.status.upsert(adapter, accountId, {
      accountId,
      connected: false,
      authenticated: false,
      mode: "disconnected",
      lastActivity: Date.now(),
    });
    await refreshAdapterStatus(service, ctx, adapter, accountId);
    const currentStatus = ctx.adapters.status.get(adapter, accountId);
    if (currentStatus) {
      recordAdapterStatusTransition(previousStatus, currentStatus, ctx, {
        suppressAuthenticationRequired: true,
        intentionalDisconnect: true,
      });
    }

    return {
      ok: true,
      adapter,
      accountId,
      message: result.message,
    };
  } finally {
    ctx.adapters.status.endLifecycle(adapter, accountId);
  }
}

function adapterAccountNeedsOwnerClaim(
  ctx: KernelContext,
  adapter: string,
  accountId: string,
  ownerUid: number,
): boolean {
  const account = ctx.adapters.status.get(adapter, accountId);
  if (account?.ownerUid != null) {
    if (ownerUid !== 0 && account.ownerUid !== ownerUid) {
      throw new Error(`Permission denied: adapter account ${adapter}/${accountId}`);
    }
    return false;
  }
  if (ownerUid === 0) {
    return true;
  }
  const linkedUids = new Set(
    ctx.adapters.identityLinks.listByAccount(adapter, accountId).map((link) => link.uid),
  );
  if (!account && linkedUids.size === 0) {
    return true;
  }
  if (linkedUids.size !== 1 || !linkedUids.has(ownerUid)) {
    throw new Error(`Permission denied: adapter account ${adapter}/${accountId}`);
  }
  return true;
}

function requireAdapterControlOwnerUid(ctx: KernelContext, syscall: string): number {
  const identity = ctx.identity;
  if (!identity || identity.role !== "user") {
    throw new Error(`${syscall} requires a user identity`);
  }
  return resolveCallerOwnerUid(ctx);
}

function requireInteractivePairingOwner(ctx: KernelContext, syscall: string): number {
  const identity = ctx.identity;
  if (
    !identity
    || identity.role !== "user"
    || !ctx.connection
    || ctx.processId
  ) {
    throw new Error(`${syscall} requires a direct signed-in user`);
  }
  const uid = identity.process.uid;
  const user = ctx.auth.getPasswdByUid(uid);
  const shadow = user ? ctx.auth.getShadowByUsername(user.username) : null;
  if (
    !user
    || uid < 1000
    || ctx.auth.isPersonalAgentUid(uid)
    || !shadow
    || isLocked(shadow)
  ) {
    throw new Error(`${syscall} requires an active human account`);
  }
  return uid;
}

export async function handleAdapterPairInfo(
  args: AdapterPairInfoArgs,
  ctx: KernelContext,
): Promise<AdapterPairInfoResult> {
  requireInteractivePairingOwner(ctx, "adapter.pair.info");
  const adapter = normalizeAdapterName(args.adapter);
  const service = requirePairingService(ctx, adapter);
  const info = pairingInfoSchema.safeParse(
    await service.adapterPairingInfo(adapterInstallationContext(ctx)),
  );
  if (!info.success) {
    throw new Error("Adapter returned invalid pairing information");
  }
  const result: AdapterPairInfoResult = {
    adapter,
    accountId: info.data.accountId,
    configured: info.data.configured,
  };
  if (info.data.botUsername) result.botUsername = info.data.botUsername;
  if (info.data.installUrl) result.installUrl = info.data.installUrl;
  return result;
}

export async function handleAdapterPairInspect(
  args: AdapterPairInspectArgs,
  ctx: KernelContext,
): Promise<AdapterPairInspectResult> {
  requireInteractivePairingOwner(ctx, "adapter.pair.inspect");
  const adapter = normalizeAdapterName(args.adapter);
  const code = normalizePairingCode(args.code);
  const service = requirePairingService(ctx, adapter);
  const candidate = requirePairingCandidate(await service.adapterPairingInspect!(
    adapterInstallationContext(ctx),
    code,
  ));
  return { adapter, ...candidate };
}

export async function handleAdapterPairConfirm(
  args: AdapterPairConfirmArgs,
  ctx: KernelContext,
): Promise<AdapterPairConfirmResult> {
  const uid = requireInteractivePairingOwner(ctx, "adapter.pair.confirm");
  const adapter = normalizeAdapterName(args.adapter);
  const code = normalizePairingCode(args.code);
  const service = requirePairingService(ctx, adapter);
  const canonicalOrigin = ctx.installationIdentity?.canonicalOrigin;
  if (!canonicalOrigin || ctx.installationId === SINGLETON_INSTALLATION_ID) {
    throw new Error("Managed adapter pairing is not available in this installation");
  }
  const operationId = await stableOpaqueId("adapter-pair", [
    adapter,
    ctx.installationId,
    uid,
    code,
  ]);
  const existingCandidate = requirePairingCandidate(await service.adapterPairingInspect!(
    adapterInstallationContext(ctx),
    code,
  ).catch(async () => {
    const prepared = await service.adapterPairingPrepare!(adapterInstallationContext(ctx), {
      code,
      installationId: ctx.installationId,
      localUid: uid,
      operationId,
      canonicalOrigin,
    });
    return requirePairingPreparation(prepared, ctx.installationId, uid).candidate;
  }));
  const existingLink = ctx.adapters.identityLinks.get(
    adapter,
    existingCandidate.accountId,
    existingCandidate.actorId,
  );
  if (existingLink && existingLink.uid !== uid) {
    throw new Error("This external identity is linked to another user in this GSV");
  }

  const prepared = requirePairingPreparation(await service.adapterPairingPrepare!(
    adapterInstallationContext(ctx),
    {
      code,
      installationId: ctx.installationId,
      localUid: uid,
      operationId,
      canonicalOrigin,
    },
  ), ctx.installationId, uid);
  if (
    prepared.candidate.actorId !== existingCandidate.actorId
    || prepared.candidate.surfaceId !== existingCandidate.surfaceId
    || prepared.candidate.accountId !== existingCandidate.accountId
    || pairingRouteScope(prepared.candidate) !== pairingRouteScope(existingCandidate)
  ) {
    throw new Error("Adapter pairing changed during preparation");
  }

  ctx.adapters.identityLinks.link(
    adapter,
    prepared.candidate.accountId,
    prepared.candidate.actorId,
    uid,
    uid,
    {
      managed: true,
      surfaceKind: "dm",
      surfaceId: prepared.candidate.surfaceId,
      routeScope: pairingRouteScope(prepared.candidate),
      routeGeneration: prepared.route.generation,
      operationId,
    },
  );
  const activated = requirePairingPreparation(await service.adapterPairingActivate!(
    adapterInstallationContext(ctx),
    {
      code,
      operationId,
      route: prepared.route,
      canonicalOrigin,
    },
  ), ctx.installationId, uid);
  if (
    activated.candidate.actorId !== prepared.candidate.actorId
    || activated.candidate.surfaceId !== prepared.candidate.surfaceId
    || activated.candidate.accountId !== prepared.candidate.accountId
    || pairingRouteScope(activated.candidate) !== pairingRouteScope(prepared.candidate)
    || activated.route.generation !== prepared.route.generation
  ) {
    throw new Error("Adapter pairing changed during confirmation");
  }
  await service.adapterPairingFinalize!(adapterInstallationContext(ctx), {
    code,
    operationId,
    route: activated.route,
    canonicalOrigin,
  });
  const previousStatus = ctx.adapters.status.get(
    adapter,
    activated.candidate.accountId,
  );
  ctx.adapters.status.setOwner(adapter, activated.candidate.accountId, uid);
  ctx.adapters.status.upsert(adapter, activated.candidate.accountId, {
    accountId: activated.candidate.accountId,
    connected: true,
    authenticated: true,
    mode: "managed-shared",
    lastActivity: Date.now(),
  });
  const currentStatus = ctx.adapters.status.get(
    adapter,
    activated.candidate.accountId,
  );
  if (currentStatus) {
    recordAdapterStatusTransition(previousStatus, currentStatus, ctx, {
      suppressAuthenticationRequired: true,
    });
  }
  ctx.broadcastToUserUid(uid, "adapter.status", {
    adapter,
    accountId: activated.candidate.accountId,
  });
  return {
    paired: true,
    adapter,
    accountId: activated.candidate.accountId,
    actorId: activated.candidate.actorId,
    surfaceId: activated.candidate.surfaceId,
    uid,
  };
}

export async function handleAdapterPairDisconnect(
  args: AdapterPairDisconnectArgs,
  ctx: KernelContext,
): Promise<AdapterPairDisconnectResult> {
  const uid = requireInteractivePairingOwner(ctx, "adapter.pair.disconnect");
  const adapter = normalizeAdapterName(args.adapter);
  const accountId = args.accountId.trim();
  const actorId = args.actorId.trim();
  if (!accountId || !actorId) throw new Error("Adapter pairing identity is required");
  const link = ctx.adapters.identityLinks.get(adapter, accountId, actorId);
  if (!link) return { disconnected: false, adapter, accountId, actorId };
  if (link.uid !== uid) throw new Error("Permission denied");
  const metadata = managedIdentityLinkMetadataSchema.safeParse(link.metadata);
  if (!metadata.success) {
    throw new Error("This identity is not managed by adapter pairing");
  }
  const { surfaceId, routeGeneration: generation } = metadata.data;
  const service = requirePairingService(ctx, adapter);
  const operationId = await stableOpaqueId("adapter-pair-disconnect", [
    adapter,
    ctx.installationId,
    uid,
    actorId,
    generation,
  ]);
  const previousStatus = ctx.adapters.status.get(adapter, accountId);
  ctx.adapters.status.beginLifecycle(adapter, accountId);
  try {
    const result = await service.adapterPairingDisconnect!(adapterInstallationContext(ctx), {
      operationId,
      installationId: ctx.installationId,
      accountId,
      actorId,
      surfaceId,
      localUid: uid,
      generation,
    });
    const current = ctx.adapters.identityLinks.get(adapter, accountId, actorId);
    if (
      current?.uid === uid
      && current.metadata?.routeGeneration === generation
    ) {
      ctx.adapters.identityLinks.unlink(adapter, accountId, actorId);
    }
    const stillLinked = ctx.adapters.identityLinks.listByAccount(adapter, accountId).length > 0;
    ctx.adapters.status.upsert(adapter, accountId, {
      accountId,
      connected: true,
      authenticated: stillLinked,
      mode: "managed-shared",
      lastActivity: Date.now(),
    });
    const currentStatus = ctx.adapters.status.get(adapter, accountId);
    if (currentStatus) {
      recordAdapterStatusTransition(previousStatus, currentStatus, ctx, {
        suppressAuthenticationRequired: true,
        intentionalDisconnect: !stillLinked,
      });
    }
    ctx.broadcastToUserUid(uid, "adapter.status", { adapter, accountId });
    return { disconnected: result.disconnected, adapter, accountId, actorId };
  } finally {
    ctx.adapters.status.endLifecycle(adapter, accountId);
  }
}

export async function handleAdapterSend(
  args: AdapterSendArgs,
  ctx: KernelContext,
  body?: BinaryBody,
): Promise<AdapterSendResult> {
  const boundaryError = adapterSendBoundaryError(args);
  if (boundaryError) return rejectAdapterSend(body, boundaryError);

  const adapter = args.adapter.trim().toLowerCase();
  const accountId = args.accountId.trim();

  if (!adapter) return rejectAdapterSend(body, "adapter is required");
  if (!accountId) return rejectAdapterSend(body, "accountId is required");
  let surface: AdapterSurface;
  try {
    surface = normalizeAdapterSurface(args.surface);
  } catch (error) {
    return rejectAdapterSend(
      body,
      error instanceof Error ? error.message : String(error),
    );
  }
  if (!args.also && isCurrentAutomaticReplyDestination(ctx, adapter, accountId, surface)) {
    return rejectAdapterSend(
      body,
      "This target is the current run's directed endpoint. Finish with Message, or use --also to intentionally send a separate message.",
    );
  }
  if (!canSendToAdapterSurface(ctx, adapter, accountId, surface)) {
    return rejectAdapterSend(body, "Permission denied");
  }

  return deliverAdapterMessage({
    ...args,
    adapter,
    accountId,
    surface,
    replyToId: args.replyToId?.trim() || undefined,
  }, ctx, body);
}

/**
 * Deliver to a trusted, Kernel-resolved adapter destination. This deliberately
 * bypasses the explicit-send duplicate guard while still rechecking that the
 * linked actor belongs to the destination owner.
 */
export async function deliverAdapterDestination(
  destination: AdapterMessageDestination,
  ownerUid: number,
  message: Pick<AdapterSendArgs, "deliveryId" | "text" | "media" | "replyToId"> & {
    routeGeneration?: string;
  },
  ctx: KernelContext,
  body?: BinaryBody,
  presentation?: AdapterDeliveryPresentation,
): Promise<AdapterSendResult> {
  let normalized: AdapterMessageDestination;
  try {
    normalized = normalizeAdapterMessageDestination(destination);
    assertAdapterMessageDestinationAccess(normalized, ownerUid, ctx);
  } catch (error) {
    await cancelBinaryBody(body, error);
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  return deliverAdapterMessage({
    adapter: normalized.adapter,
    accountId: normalized.accountId,
    actorId: normalized.actorId,
    surface: normalized.surface,
    ...message,
  }, ctx, body, presentation);
}

async function deliverAdapterMessage(
  args: Pick<AdapterSendArgs, "adapter" | "accountId" | "deliveryId" | "surface" | "text" | "media" | "replyToId"> & {
    actorId?: string;
    routeGeneration?: string;
  },
  ctx: KernelContext,
  body?: BinaryBody,
  presentation?: AdapterDeliveryPresentation,
): Promise<AdapterSendResult> {
  const startedAt = Date.now();
  try {
    const result = await deliverAdapterMessageOwned(args, ctx, body, presentation);
    emitTelemetry(ctx.env, {
      installationId: ctx.installationId,
      component: "gateway",
      event: {
        stream: "operational",
        name: "adapter.delivery.finished",
        properties: {
          adapter: args.adapter.trim().toLowerCase(),
          outcome: result.ok
            ? result.deliveryState ?? "sent"
            : result.retryable
              ? "retryable_error"
              : "rejected",
          hasMedia: Boolean(args.media?.length),
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
        name: "adapter.delivery.finished",
        properties: {
          adapter: args.adapter.trim().toLowerCase(),
          outcome: "error",
          hasMedia: Boolean(args.media?.length),
          durationMs: Math.max(0, Date.now() - startedAt),
        },
      },
    });
    throw error;
  }
}

async function deliverAdapterMessageOwned(
  args: Pick<AdapterSendArgs, "adapter" | "accountId" | "deliveryId" | "surface" | "text" | "media" | "replyToId"> & {
    actorId?: string;
    routeGeneration?: string;
  },
  ctx: KernelContext,
  body?: BinaryBody,
  presentation?: AdapterDeliveryPresentation,
): Promise<AdapterSendResult> {
  const adapter = args.adapter.trim().toLowerCase();
  const accountId = args.accountId.trim();

  let routeGeneration = args.routeGeneration;
  if (args.actorId) {
    const link = ctx.adapters.identityLinks.get(adapter, accountId, args.actorId);
    const currentGeneration = link
      ? identityLinkRouteGeneration(link, args.surface)
      : undefined;
    if (routeGeneration !== undefined && routeGeneration !== currentGeneration) {
      await cancelBinaryBody(body, "Adapter route changed before delivery");
      return {
        ok: false,
        error: "Adapter route changed before delivery",
        retryable: false,
      };
    }
    routeGeneration ??= currentGeneration;
  }

  const deliveryId = args.deliveryId?.trim() || crypto.randomUUID();
  if (deliveryId.length > 200 || !/^[a-zA-Z0-9._:-]+$/.test(deliveryId)) {
    await cancelBinaryBody(body, "Invalid adapter delivery id");
    return { ok: false, error: "Adapter deliveryId is invalid", retryable: false };
  }

  const service = resolveAdapterService(ctx.env, adapter);
  if (!service?.adapterFrame) {
    await cancelBinaryBody(body, `Adapter service unavailable: ${adapter}`);
    return {
      ok: false,
      error: `Adapter service unavailable: ${adapter}`,
      deliveryId,
      retryable: true,
    };
  }

  try {
    validateAdapterMediaBody(args.media, body, {
      maxBytes: MAX_MESSAGE_MEDIA_TOTAL_BYTES,
      maxPartBytes: MAX_MESSAGE_MEDIA_PART_BYTES,
    });
    validateAdapterMediaItems(args.media, "outbound");
    ctx.requestSignal?.throwIfAborted();
  } catch (error) {
    await cancelBinaryBody(body, error);
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      deliveryId,
      retryable: false,
    };
  }

  const context: AdapterDeliveryContext = {
    deliveryId,
    accountId,
    surface: args.surface,
    ...presentation,
  };
  if (args.actorId) context.actorId = args.actorId;
  if (routeGeneration !== undefined) context.routeGeneration = routeGeneration;
  const request: RequestFrame<"adapter.send"> = {
    type: "req",
    id: crypto.randomUUID(),
    call: "adapter.send",
    args: {
      adapter,
      accountId,
      deliveryId,
      surface: args.surface,
      text: args.text,
      ...(args.replyToId === undefined ? undefined : { replyToId: args.replyToId }),
      ...(args.media === undefined ? undefined : { media: args.media }),
    },
    ...(body === undefined ? undefined : { body }),
  };
  let responseBody: BinaryBody | undefined;
  try {
    const response = await service.adapterFrame(
      { installationId: ctx.installationId },
      context,
      request,
    );
    const parsedBody = adapterFrameBodySchema.safeParse(response);
    if (parsedBody.success) responseBody = parsedBody.data.body;
    if (!response || response.type !== "res" || response.id !== request.id) {
      return {
        ok: false,
        error: publicAdapterDeliveryError(adapter, true),
        deliveryId,
        retryable: true,
      };
    }
    if (!response.ok) {
      const retryable = response.error?.retryable === true;
      return {
        ok: false,
        error: publicAdapterDeliveryError(adapter, retryable),
        deliveryId,
        retryable,
      };
    }
    const decoded = adapterSendResultSchema.safeParse(response.data);
    if (!decoded.success) {
      logAdapterBoundaryFailure("error", "send_frame_invalid_response");
      return {
        ok: false,
        error: `Adapter returned an invalid adapter.send response: ${adapter}`,
        deliveryId,
        retryable: false,
      };
    }
    const result = decoded.data;
    if (!result.ok) {
      return {
        ok: false,
        error: publicAdapterDeliveryError(adapter, result.retryable === true),
        deliveryId,
        retryable: result.retryable === true,
      };
    }
    if (
      result.adapter !== adapter
      || result.accountId !== accountId
      || result.surfaceId !== args.surface.id
      || result.deliveryId !== deliveryId
    ) {
      logAdapterBoundaryFailure("error", "send_frame_mismatched_response");
      return {
        ok: false,
        error: `Adapter returned a mismatched adapter.send response: ${adapter}`,
        deliveryId,
        retryable: false,
      };
    }
    return result;
  } catch {
    return {
      ok: false,
      error: publicAdapterDeliveryError(adapter, true),
      deliveryId,
      retryable: true,
    };
  } finally {
    await Promise.all([
      cancelBinaryBody(responseBody, "adapter.send response body is unsupported"),
      responseBody === body
        ? Promise.resolve()
        : cancelBinaryBody(body, "adapter.send frame completed"),
    ]);
  }
}

function publicAdapterDeliveryError(adapter: string, retryable: boolean): string {
  const name = adapter === "whatsapp"
    ? "WhatsApp"
    : adapter.charAt(0).toUpperCase() + adapter.slice(1);
  return retryable
    ? `${name} delivery is temporarily unavailable`
    : `${name} rejected the delivery`;
}

async function rejectAdapterSend(body: BinaryBody | undefined, error: string): Promise<AdapterSendResult> {
  await cancelBinaryBody(body, error);
  return { ok: false, error, retryable: false };
}

function isCurrentAutomaticReplyDestination(
  ctx: KernelContext,
  adapter: string,
  accountId: string,
  surface: AdapterSurface,
): boolean {
  if (!ctx.processId || !ctx.processRunId) {
    return false;
  }
  const route = ctx.runRoutes.get(ctx.processRunId);
  if (route?.kind !== "adapter" || route.processId !== ctx.processId) {
    return false;
  }
  const { destination } = route;
  return destination.adapter === adapter
    && destination.accountId === accountId
    && destination.surface.kind === surface.kind
    && destination.surface.id === surface.id.trim()
    && (destination.surface.threadId ?? "") === (surface.threadId?.trim() ?? "");
}

function canSendToAdapterSurface(
  ctx: KernelContext,
  adapter: string,
  accountId: string,
  surface: AdapterSurface,
): boolean {
  const identity = ctx.identity;
  if (!identity) {
    return false;
  }
  if (identity.role === "service") {
    return true;
  }
  if (identity.role !== "user") {
    return false;
  }
  if (identity.process.uid === 0) {
    return true;
  }
  const ownerUid = resolveCallerOwnerUid(ctx);
  const links = ctx.adapters.identityLinks.list(ownerUid).filter((link) =>
    link.adapter.trim().toLowerCase() === adapter && link.accountId.trim() === accountId
  );
  if (links.length === 0) {
    return false;
  }
  return links.some((link) => identityLinkAllowsSurface(link, surface))
    || callerOwnsAdapterSurfaceRoute(ctx, adapter, accountId, surface, ownerUid, links);
}

function callerOwnsAdapterSurfaceRoute(
  ctx: KernelContext,
  adapter: string,
  accountId: string,
  surface: AdapterSurface,
  ownerUid: number,
  links: IdentityLinkRecord[],
): boolean {
  return links.some((link) => {
    const route = ctx.adapters.surfaceRoutes.get({
      adapter,
      accountId,
      actorId: link.actorId,
      surfaceKind: surface.kind,
      surfaceId: surface.id.trim(),
      threadId: surface.threadId,
    });
    return route?.uid === ownerUid;
  });
}

export async function handleAdapterStatus(
  args: AdapterStatusArgs,
  ctx: KernelContext,
): Promise<AdapterStatusResult> {
  const adapter = normalizeAdapterName(args.adapter);
  if (!adapter) throw new Error("adapter is required");
  const accountId = args.accountId?.trim() || undefined;

  const service = resolveAdapterService(ctx.env, adapter);
  if (service?.adapterStatus) {
    const refreshAccountIds = adapterStatusRefreshAccountIds(ctx, adapter, accountId);
    for (const refreshAccountId of refreshAccountIds) {
      try {
        const decoded = adapterStatusListSchema.safeParse(
          await callAdapterStatus(service, ctx, refreshAccountId),
        );
        if (!decoded.success) {
          logAdapterBoundaryFailure("error", "status_invalid_response");
          continue;
        }
        const statuses = decoded.data;
        const allowedAccountIds = refreshAccountId ? new Set([refreshAccountId]) : null;
        for (const status of statuses) {
          if (allowedAccountIds && !allowedAccountIds.has(status.accountId.trim())) {
            continue;
          }
          const localized = localizeAdapterStatus(ctx, adapter, status);
          const previous = ctx.adapters.status.get(adapter, localized.accountId);
          const current = ctx.adapters.status.upsert(
            adapter,
            localized.accountId,
            localized,
          );
          if (!ctx.adapters.status.isLifecycleActive(adapter, localized.accountId)) {
            recordAdapterStatusTransition(previous, current, ctx);
          }
        }
      } catch {
        // status syscall should still return last known state when live check fails
      }
    }
  }

  const accounts = visibleAdapterStatusRecords(ctx, adapter, accountId)
    .map((row): AdapterAccountStatus => ({
      accountId: row.accountId,
      connected: row.connected,
      authenticated: row.authenticated,
      mode: row.mode,
      lastActivity: row.lastActivity,
      error: row.error,
      extra: row.extra,
    }));

  return { adapter, accounts };
}

export async function handleAdapterList(
  _args: AdapterListArgs,
  ctx: KernelContext,
): Promise<AdapterListResult> {
  const entries = new Map<string, AdapterListEntry>();
  const deployed = Object.keys(ctx.env)
    .map((key) => adapterNameFromBindingKey(key))
    .filter((adapter): adapter is string => adapter !== null);

  await Promise.all(deployed.map(async (adapter) => {
    const service = resolveAdapterService(ctx.env, adapter);
    const descriptor = await describeAdapterService(adapter, service);
    entries.set(adapter, adapterListEntry(adapter, service, descriptor));
  }));

  const statuses = visibleAdapterStatusRecords(ctx);

  for (const status of statuses) {
    const adapter = normalizeAdapterName(status.adapter);
    if (!adapter) continue;

    const entry = entries.get(adapter) ?? adapterListEntry(adapter, null);
    entry.accounts.push(adapterAccountStatusFromRecord(status));
    entries.set(adapter, entry);
  }

  return {
    adapters: Array.from(entries.values())
      .map((entry) => ({
        ...entry,
        accounts: entry.accounts.sort((left, right) => left.accountId.localeCompare(right.accountId)),
      }))
      .sort((left, right) => left.adapter.localeCompare(right.adapter)),
  };
}

function adapterStatusRefreshAccountIds(
  ctx: KernelContext,
  adapter: string,
  accountId: string | undefined,
): Array<string | undefined> {
  if (canSeeAllAdapterStatuses(ctx)) {
    return [accountId];
  }

  const linkedAccounts = visibleAdapterAccounts(ctx, adapter, accountId);
  return linkedAccounts.map((account) => account.accountId);
}

function visibleAdapterStatusRecords(
  ctx: KernelContext,
  adapterFilter?: string,
  accountIdFilter?: string,
): AdapterStatusRecord[] {
  const adapter = adapterFilter ? normalizeAdapterName(adapterFilter) : undefined;
  const accountId = accountIdFilter?.trim();
  const statusStore = ctx.adapters.status;

  if (canSeeAllAdapterStatuses(ctx)) {
    if (adapter) {
      return statusStore.list(adapter, accountId);
    }
    return statusStore.listAll();
  }

  const accounts = visibleAdapterAccounts(ctx, adapter, accountId);
  const records: AdapterStatusRecord[] = [];
  for (const account of accounts) {
    records.push(
      ...statusStore
        .list(account.adapter, account.accountId)
        .map((status) => ({ ...status, adapter: account.adapter })),
    );
  }
  return records;
}

function visibleAdapterAccounts(
  ctx: KernelContext,
  adapter: string | undefined,
  accountId: string | undefined,
): Array<{ adapter: string; accountId: string }> {
  const identity = ctx.identity;
  if (!identity || identity.role !== "user") {
    return [];
  }

  const ownerUid = resolveCallerOwnerUid(ctx);
  const seen = new Set<string>();
  const accounts: Array<{ adapter: string; accountId: string }> = [];
  const add = (candidateAdapter: string, candidateAccountId: string): void => {
    const normalizedAdapter = normalizeAdapterName(candidateAdapter);
    const normalizedAccountId = candidateAccountId.trim();
    const key = `${normalizedAdapter}\0${normalizedAccountId}`;
    if (
      !normalizedAdapter || !normalizedAccountId || seen.has(key)
      || (adapter && normalizedAdapter !== adapter)
      || (accountId && normalizedAccountId !== accountId)
    ) {
      return;
    }
    seen.add(key);
    accounts.push({ adapter: normalizedAdapter, accountId: normalizedAccountId });
  };
  for (const status of ctx.adapters.status.listByOwner(ownerUid)) {
    add(status.adapter, status.accountId);
  }
  for (const link of ctx.adapters.identityLinks.list(ownerUid)) {
    add(link.adapter, link.accountId);
  }
  return accounts.sort((left, right) =>
    left.adapter.localeCompare(right.adapter) || left.accountId.localeCompare(right.accountId)
  );
}

function canSeeAllAdapterStatuses(ctx: KernelContext): boolean {
  const identity = ctx.identity;
  if (!identity) {
    return false;
  }
  if (identity.role === "service") {
    return true;
  }
  return identity.role === "user" && resolveCallerOwnerUid(ctx) === 0;
}

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

function validateAdapterMediaItems(
  media: AdapterMedia[] | undefined,
  direction: "inbound" | "outbound",
): void {
  if (media === undefined) return;
  if (!Array.isArray(media)) {
    throw new Error("Adapter media must be an array");
  }
  if (media.length > MAX_MESSAGE_MEDIA_ITEMS) {
    throw new Error(`Adapter media exceeds item limit (${MAX_MESSAGE_MEDIA_ITEMS})`);
  }

  for (const item of media) {
    if (!item || !["image", "audio", "video", "document"].includes(item.type)) {
      throw new Error("Adapter media has an invalid type");
    }
    if (!item.mimeType.trim()) {
      throw new Error("Adapter media requires mimeType");
    }
    if (item.size !== undefined && (!Number.isSafeInteger(item.size) || item.size < 0)) {
      throw new Error("Adapter media size must be a non-negative safe integer");
    }
    if (item.duration !== undefined && (!Number.isFinite(item.duration) || item.duration < 0)) {
      throw new Error("Adapter media duration must be a non-negative number");
    }
    if (item.body && item.size !== undefined && item.size !== item.body.length) {
      throw new Error("Adapter media size must match its binary body length");
    }
    if (direction === "inbound" && !item.body) {
      throw new Error("Inbound adapter media must include a binary body");
    }
    if (direction === "outbound" && !item.body && !item.url?.trim()) {
      throw new Error("Outbound adapter media must include a URL or binary body");
    }
    if (item.url) {
      let url: URL;
      try {
        url = new URL(item.url);
      } catch {
        throw new Error("Adapter media URL is invalid");
      }
      if (url.protocol !== "https:" && url.protocol !== "http:") {
        throw new Error("Adapter media URL must use HTTP or HTTPS");
      }
    }
  }
}

export function handleAdapterStateUpdate(
  args: AdapterStateUpdateArgs,
  ctx: KernelContext,
): AdapterStateUpdateResult {
  const identity = ctx.identity;
  if (!identity || identity.role !== "service") {
    throw new Error("adapter.state.update requires a service identity");
  }

  const adapter = args.adapter.trim().toLowerCase();
  const accountId = args.accountId.trim();
  if (!adapter) {
    throw new Error("adapter is required");
  }
  if (!accountId) {
    throw new Error("accountId is required");
  }

  const localized = localizeAdapterStatus(ctx, adapter, {
    ...args.status,
    accountId,
  });
  const previous = ctx.adapters.status.get(adapter, accountId);
  const status = ctx.adapters.status.upsert(adapter, accountId, localized);
  if (!ctx.adapters.status.isLifecycleActive(adapter, accountId)) {
    recordAdapterStatusTransition(previous, status, ctx);
  }
  const uids = new Set([0]);
  if (status.ownerUid !== null) {
    uids.add(status.ownerUid);
  }
  for (const link of ctx.adapters.identityLinks.listByAccount(adapter, accountId)) {
    uids.add(link.uid);
  }
  for (const uid of uids) {
    ctx.broadcastToUserUid(uid, "adapter.status", { adapter, accountId });
  }

  return { ok: true };
}

function adapterNameFromBindingKey(key: string): string | null {
  if (!key.startsWith("CHANNEL_")) {
    return null;
  }
  return normalizeAdapterName(key.slice("CHANNEL_".length)) || null;
}

function normalizeAdapterName(adapter: string): string {
  return adapter.trim().toLowerCase();
}

function adapterListEntry(
  adapter: string,
  service: AdapterServiceBinding | null,
  descriptor: AdapterServiceDescriptor | null = null,
): AdapterListEntry {
  const capabilities = descriptor?.capabilities;
  return {
    adapter,
    available: service !== null,
    descriptor: descriptor ?? undefined,
    supportsConnect: capabilities?.connect ?? false,
    supportsDisconnect: capabilities?.disconnect ?? false,
    supportsSend: capabilities?.send ?? false,
    supportsStatus: capabilities?.status ?? false,
    supportsActivity: capabilities?.activity ?? false,
    supportsPairing: capabilities?.pairing ?? false,
    accounts: [],
  };
}

async function describeAdapterService(
  adapter: string,
  service: AdapterServiceBinding | null,
): Promise<AdapterServiceDescriptor | null> {
  if (!service?.adapterDescribe) return null;
  try {
    const result = adapterServiceDescriptorSchema.safeParse(await service.adapterDescribe());
    if (!result.success || result.data.id !== adapter) {
      logAdapterBoundaryFailure("error", "descriptor_invalid_response");
      return null;
    }
    return result.data;
  } catch {
    logAdapterBoundaryFailure("error", "descriptor_worker_failed");
    return null;
  }
}

function adapterAccountStatusFromRecord(status: AdapterStatusRecord): AdapterAccountStatus {
  return {
    accountId: status.accountId,
    connected: status.connected,
    authenticated: status.authenticated,
    mode: status.mode,
    lastActivity: status.lastActivity,
    error: status.error,
    extra: status.extra,
  };
}

export async function setAdapterActivityForKernel(
  env: GatewayEnv,
  installationId: KernelContext["installationId"],
  adapter: string,
  accountId: string,
  surface: AdapterSurface,
  activity: AdapterActivity,
): Promise<void> {
  const service = resolveAdapterService(env, adapter);
  if (!service?.adapterSetActivity) {
    return;
  }

  try {
    const decoded = adapterWorkerActivityResultSchema.safeParse(
      await callAdapterSetActivity(
        service,
        installationId,
        accountId,
        surface,
        activity,
      ),
    );
    if (!decoded.success) {
      logAdapterBoundaryFailure("warn", "activity_invalid_response");
      return;
    }
    const result = decoded.data;
    if (!result.ok) {
      logAdapterBoundaryFailure("warn", "activity_rejected");
    }
  } catch {
    logAdapterBoundaryFailure("warn", "activity_worker_failed");
  }
}

async function refreshAdapterStatus(
  service: AdapterServiceBinding,
  ctx: KernelContext,
  adapter: string,
  accountId: string,
): Promise<AdapterAccountStatus | null> {
  if (!service.adapterStatus) {
    return null;
  }

  try {
    const decoded = adapterStatusListSchema.safeParse(
      await callAdapterStatus(service, ctx, accountId),
    );
    if (!decoded.success) {
      logAdapterBoundaryFailure("error", "status_invalid_response");
      return null;
    }
    const statuses = decoded.data;
    const accountStatuses = statuses.filter((status) => status.accountId === accountId);
    for (const status of accountStatuses) {
      const localized = localizeAdapterStatus(ctx, adapter, status);
      ctx.adapters.status.upsert(adapter, localized.accountId, localized);
    }
    return accountStatuses[0] ?? null;
  } catch {
    logAdapterBoundaryFailure("error", "status_refresh_failed");
    return null;
  }
}

function localizeAdapterStatus(
  ctx: KernelContext,
  adapter: string,
  status: AdapterAccountStatus,
): AdapterAccountStatus {
  if (status.mode !== "managed-shared") return status;
  return {
    ...status,
    authenticated: ctx.adapters.identityLinks.listByAccount(
      adapter,
      status.accountId,
    ).length > 0,
  };
}

function adapterInstallationContext(
  ctx: KernelContext,
): AdapterInstallationContext {
  return { installationId: ctx.installationId };
}

function callAdapterConnect(
  service: AdapterServiceBinding,
  ctx: KernelContext,
  accountId: string,
  config?: AdapterConnectConfig,
) {
  return service.adapterConnect!(adapterInstallationContext(ctx), accountId, config);
}

function callAdapterDisconnect(
  service: AdapterServiceBinding,
  ctx: KernelContext,
  accountId: string,
) {
  return service.adapterDisconnect!(adapterInstallationContext(ctx), accountId);
}

function callAdapterSetActivity(
  service: AdapterServiceBinding,
  installationId: KernelContext["installationId"],
  accountId: string,
  surface: AdapterSurface,
  activity: AdapterActivity,
) {
  return service.adapterSetActivity!({ installationId }, accountId, surface, activity);
}

function callAdapterStatus(
  service: AdapterServiceBinding,
  ctx: KernelContext,
  accountId?: string,
) {
  return service.adapterStatus!(adapterInstallationContext(ctx), accountId);
}

function requirePairingService(
  ctx: KernelContext,
  adapter: string,
): AdapterPairingWorkerInterface {
  if (!adapter) throw new Error("adapter is required");
  if (ctx.installationId === SINGLETON_INSTALLATION_ID) {
    throw new Error("Managed adapter pairing is not available in standalone GSV");
  }
  const service = resolveAdapterService(ctx.env, adapter);
  if (
    !service
    || !service.adapterPairingInfo
    || !service.adapterPairingInspect
    || !service.adapterPairingPrepare
    || !service.adapterPairingActivate
    || !service.adapterPairingFinalize
    || !service.adapterPairingDisconnect
  ) {
    throw new Error(`Adapter does not support managed pairing: ${adapter}`);
  }
  return {
    adapterPairingInfo: (...args) => service.adapterPairingInfo!(...args),
    adapterPairingInspect: (...args) => service.adapterPairingInspect!(...args),
    adapterPairingPrepare: (...args) => service.adapterPairingPrepare!(...args),
    adapterPairingActivate: (...args) => service.adapterPairingActivate!(...args),
    adapterPairingFinalize: (...args) => service.adapterPairingFinalize!(...args),
    adapterPairingDisconnect: (...args) => service.adapterPairingDisconnect!(...args),
  };
}

function normalizePairingCode(value: string): string {
  const normalized = value.trim().toUpperCase().replace(/[\s-]+/g, "");
  if (!/^[A-HJ-NP-Z2-9]{12}$/.test(normalized)) {
    throw new Error("Pairing code is invalid");
  }
  return normalized;
}

function requirePairingCandidate(value: AdapterPairingCandidate): AdapterPairingCandidate {
  const parsed = pairingCandidateSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("Adapter returned an invalid pairing candidate");
  }
  const accountId = parsed.data.accountId.trim();
  const actorId = parsed.data.actorId.trim();
  const surfaceId = parsed.data.surfaceId.trim();
  if (!accountId || !actorId || !surfaceId) {
    throw new Error("Adapter returned an invalid pairing candidate");
  }
  return {
    ...parsed.data,
    accountId,
    actorId,
    surfaceId,
  };
}

function pairingRouteScope(candidate: AdapterPairingCandidate): "surface" | "actor" {
  return candidate.routeScope ?? "surface";
}

function requirePairingPreparation(
  value: AdapterPairingPreparation,
  installationId: string,
  localUid: number,
): AdapterPairingPreparation {
  const parsed = pairingPreparationSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("Adapter returned an invalid pairing preparation");
  }
  const preparation = parsed.data;
  const candidate = requirePairingCandidate(preparation.candidate);
  const route = preparation.route;
  if (
    !route
    || route.installationId !== installationId
    || route.localUid !== localUid
  ) {
    throw new Error("Adapter returned an invalid pairing route");
  }
  const previous = preparation.previousRoute;
  if (previous && (
    previous.installationId.length === 0
    || !Number.isSafeInteger(previous.localUid)
    || previous.generation.length === 0
  )) {
    throw new Error("Adapter returned an invalid previous pairing route");
  }
  const result: AdapterPairingPreparation = {
    candidate,
    route,
  };
  if (previous) result.previousRoute = previous;
  return result;
}

function logAdapterBoundaryFailure(
  level: "warn" | "error",
  event: string,
): void {
  const message = JSON.stringify({ component: "adapter", event });
  if (level === "error") {
    console.error(message);
  } else {
    console.warn(message);
  }
}

function identityForUid(uid: number, ctx: KernelContext): ProcessIdentity | null {
  const user = ctx.auth.getPasswdByUid(uid);
  if (!user) return null;

  return {
    uid: user.uid,
    gid: user.gid,
    gids: ctx.auth.resolveGids(user.username, user.gid),
    username: user.username,
    home: user.home,
    cwd: user.home,
  };
}

async function resolveAdapterRoute(
  adapter: string,
  accountId: string,
  actorId: string,
  surface: AdapterSurface,
  uid: number,
  operationId: string,
  userIdentity: ProcessIdentity,
  ctx: KernelContext,
): Promise<string> {
  const routeKey = {
    adapter,
    accountId,
    actorId,
    surfaceKind: surface.kind,
    surfaceId: surface.id,
    threadId: surface.threadId,
    uid,
  };

  if (surface.kind === "dm") {
    return (await resolvePrivateDmSelection(routeKey, uid, ctx)).process.processId;
  }

  const route = ctx.adapters.surfaceRoutes.resolveRoute(routeKey);
  if (route) {
    const routedProcess = ctx.procs.get(route.pid);
    if (
      route.mode === "surface"
      && isOwnedInteractiveProcess(routedProcess, uid)
    ) {
      return routedProcess.processId;
    }
    ctx.adapters.surfaceRoutes.clearRouteIfMatches({
      ...routeKey,
      pid: route.pid,
      mode: route.mode,
    });
  }

  const personalAgent = await ensurePersonalAgent(ctx, userIdentity);
  const pid = await spawnAdapterAgentProcess(
    {
      uid: personalAgent.identity.uid,
      username: personalAgent.identity.username,
      label: personalAgent.identity.username,
      identity: personalAgent.identity,
    },
    uid,
    operationId,
    ctx,
  );
  ctx.adapters.surfaceRoutes.setRoute({
    ...routeKey,
    pid,
    mode: "surface",
    updatedByUid: uid,
  });
  return pid;
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

async function deliverAdapterWorkReturnedEvent(
  recovery: AdapterIngressWorkReturnRecovery,
  receiptId: string,
  providerMessageId: string,
  ctx: KernelContext,
): Promise<string | null> {
  const destination: AdapterMessageDestination = {
    kind: "adapter",
    adapter: recovery.route.adapter,
    accountId: recovery.route.accountId,
    actorId: recovery.route.actorId,
    surface: { kind: "dm", id: recovery.route.surfaceId },
  };
  if (recovery.route.threadId) destination.surface.threadId = recovery.route.threadId;
  if (!ctx.adapters.ingressReceipts.isLatestPrivateMessage(destination, providerMessageId)) {
    return null;
  }
  ctx.adapters.surfaceRoutes.clearRouteIfMatches({
    ...recovery.route,
    pid: recovery.workPid,
  });
  const personalPid = await ensurePersonalController(recovery.uid, ctx);
  if (!ctx.adapters.ingressReceipts.isLatestPrivateMessage(destination, providerMessageId)) {
    return null;
  }
  const eventId = `adapter-home:${receiptId}`;
  const request: InternalRequestFrame<"proc.runtime.event.deliver"> = {
    type: "req",
    id: crypto.randomUUID(),
    call: "proc.runtime.event.deliver",
    args: {
      eventId,
      event: {
        type: "adapter.work.returned",
        workPid: recovery.workPid,
      },
    },
  };
  const response: InternalResponseFrame<"proc.runtime.event.deliver"> | null = await sendFrameToProcess(
    ctx.installationId,
    personalPid,
    request,
  );
  if (
    !response
    || response.type !== "res"
    || response.id !== request.id
    || !response.ok
    || response.data.eventId !== eventId
  ) {
    throw new Error("Personal return event was not admitted");
  }
  return personalPid;
}

async function resolvePrivateDmSelection(
  routeKey: {
    adapter: string;
    accountId: string;
    actorId: string;
    surfaceKind: AdapterSurface["kind"];
    surfaceId: string;
    threadId?: string;
    uid: number;
  },
  uid: number,
  ctx: KernelContext,
): Promise<{ process: ProcessRecord; route: SurfaceRouteRecord | null }> {
  const route = ctx.adapters.surfaceRoutes.resolveRoute(routeKey);
  if (route) {
    const routedProcess = ctx.procs.get(route.pid);
    if (route.mode === "work" && isOwnedInteractiveProcess(routedProcess, uid)) {
      return { process: routedProcess, route };
    }
    if (
      route.mode === "legacy"
      && isOwnedInteractiveProcess(routedProcess, uid)
      && await shouldDrainLegacyDmRoute(routedProcess, ctx)
    ) {
      return { process: routedProcess, route };
    }
    const cleared = ctx.adapters.surfaceRoutes.clearRouteIfMatches({
      ...routeKey,
      pid: route.pid,
      mode: route.mode,
    });
    if (!cleared) {
      return resolvePrivateDmSelection(routeKey, uid, ctx);
    }
  }

  const personalPid = await ensurePersonalController(uid, ctx);
  const personal = ctx.procs.get(personalPid);
  if (!isOwnedInteractiveProcess(personal, uid) || !personal.isPersonalController) {
    throw new Error("Personal controller is unavailable");
  }
  return { process: personal, route: null };
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

function isOwnedInteractiveProcess(
  process: ProcessRecord | null,
  ownerUid: number,
): process is ProcessRecord {
  return Boolean(process?.interactive && process.ownerUid === ownerUid);
}

function processHasUnfinishedWork(process: ProcessRecord): boolean {
  return process.state !== "idle"
    || process.activeRunId !== null
    || process.queuedCount > 0;
}

async function shouldDrainLegacyDmRoute(
  process: ProcessRecord,
  ctx: KernelContext,
): Promise<boolean> {
  if (processHasUnfinishedWork(process)) {
    return true;
  }
  const pendingHil = await processHasPendingHil(ctx.installationId, process.processId);
  if (pendingHil === null) {
    return true;
  }
  const current = ctx.procs.get(process.processId);
  return current !== null
    && (processHasUnfinishedWork(current) || pendingHil);
}

async function processHasPendingHil(
  installationId: KernelContext["installationId"],
  pid: string,
): Promise<boolean | null> {
  const response = await sendFrameToProcess(installationId, pid, {
    type: "req",
    id: crypto.randomUUID(),
    call: "proc.history",
    args: { pid, limit: 1, offset: 0 },
  });
  if (!response || response.type !== "res" || !response.ok || !response.data?.ok) {
    return null;
  }
  return response.data.pendingHil !== null && response.data.pendingHil !== undefined;
}

type RunnableAgent = {
  uid: number;
  username: string;
  label: string;
  identity: ProcessIdentity;
};

async function spawnAdapterAgentProcess(
  agent: RunnableAgent,
  ownerUid: number,
  operationId: string,
  ctx: KernelContext,
): Promise<string> {
  const pid = `proc:${operationId}`;
  if (!ctx.procs.get(pid)) {
    ctx.procs.spawn(pid, agent.identity, {
      ownerUid,
      interactive: true,
      cwd: agent.identity.cwd,
    });
  }

  await sendFrameToProcess(ctx.installationId, pid, {
    type: "req",
    id: crypto.randomUUID(),
    call: "proc.setidentity",
    args: {
      identity: agent.identity,
      interactive: true,
      autoTitle: true,
    },
  });

  return pid;
}

function describeProcessRoute(record: NonNullable<ReturnType<KernelContext["procs"]["get"]>>): string {
  return `${shortProcessId(record.processId)} ${record.label || record.username}`;
}

function adapterPrivateActivityAt(timestamp: number | undefined): number {
  const now = Date.now();
  return timestamp !== undefined && Number.isSafeInteger(timestamp) && timestamp > 0
    ? Math.min(timestamp, now)
    : now;
}

function shortProcessId(pid: string): string {
  if (pid.startsWith("proc:")) {
    return pid.slice(0, 13);
  }
  return pid.length > 13 ? pid.slice(0, 13) : pid;
}

function resolveActorId(message: AdapterInboundMessage): string | null {
  const actor = message.actor?.id?.trim();
  if (actor) return actor;

  if (message.surface.kind === "dm") {
    const fallback = message.surface.id.trim();
    return fallback || null;
  }

  return null;
}

function adapterInteractionOrigin(
  adapter: string,
  accountId: string,
  message: AdapterInboundMessage,
  actorId: string,
): Extract<InteractionOrigin, { kind: "adapter" }> {
  const actorLabel = message.actor?.handle?.trim() || message.actor?.name?.trim() || undefined;
  const origin: Extract<InteractionOrigin, { kind: "adapter" }> = {
    kind: "adapter",
    adapter,
    accountId,
    surface: message.surface,
    actorId,
  };
  if (actorLabel) origin.actorLabel = actorLabel;
  const messageId = message.messageId.trim();
  if (messageId) origin.messageId = messageId;
  return origin;
}
