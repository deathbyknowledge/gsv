import type {
  AdapterActivity,
  AdapterInboundMessage,
  AdapterAccountStatus,
  AdapterMedia,
  AdapterOutboundMessage,
  AdapterSurface,
  AdapterWorkerInterface,
} from "../adapter-interface";
import type {
  AdapterConnectArgs,
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
  AdapterStateUpdateArgs,
  AdapterStateUpdateResult,
  AdapterSendArgs,
  AdapterSendResult,
  AdapterStatusArgs,
  AdapterStatusResult,
  BinaryBody,
  ProcMediaInput,
  ProcessIdentity,
} from "@humansandmachines/gsv/protocol";
import {
  cancelBinaryBody,
  consumeAdapterMediaBodyParts,
  validateAdapterMediaBody,
} from "@humansandmachines/gsv/protocol";
import { resolveCallerOwnerUid, type KernelContext } from "./context";
import type { RequestFrame, ResponseOkFrame } from "../protocol/frames";
import type {
  ProcessAdapterDeliverRequestFrame,
  ProcessAdapterDeliverResponseFrame,
} from "../protocol/process-frames";
import { sendFrameToProcess } from "../shared/utils";
import { stableOpaqueId } from "../shared/stable-id";
import { ensureDefaultConversationExecutor } from "./agents";
import { canOwnerRunAsAccount } from "./account-access";
import { isLocked } from "../auth/shadow";
import type { AdapterStatusRecord } from "./adapter-status";
import type { IdentityLinkRecord } from "./identity-links";
import {
  assertAdapterMessageDestinationAccess,
  normalizeAdapterMessageDestination,
} from "./adapter-destinations";
import {
  MAX_MESSAGE_MEDIA_ITEMS,
  MAX_MESSAGE_MEDIA_PART_BYTES,
  MAX_MESSAGE_MEDIA_TOTAL_BYTES,
} from "../shared/message-media-limits";

type AdapterServiceBinding = Fetcher & Partial<AdapterWorkerInterface>;
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
type HilDecision = {
  decision: "approve" | "deny";
  remember: boolean;
};
type ParsedHilDecision = HilDecision & {
  requestToken?: string;
};
type AdapterIngressProcessRecovery = {
  kind: "process_delivery";
  uid: number;
  pid: string;
  runId: string;
  media: ProcMediaInput[];
  origin: InteractionOrigin;
};
type AdapterIngressHilRecovery = {
  kind: "hil_decision";
  pid: string;
  requestId: string;
  decision: "approve" | "deny";
  remember: boolean;
};
type AdapterIngressRecovery = AdapterIngressProcessRecovery | AdapterIngressHilRecovery;
export type AdapterHilRequest = {
  requestId: string;
  toolName: string;
  syscall: string;
  args: Record<string, unknown>;
};

export function resolveAdapterService(env: Env, adapter: string): AdapterServiceBinding | null {
  const key = `CHANNEL_${adapter.trim().toUpperCase()}`;
  const binding = (env as unknown as Record<string, unknown>)[key];
  if (!binding) return null;
  return binding as AdapterServiceBinding;
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
  if (typeof service.adapterConnect !== "function") {
    return { ok: false, error: `Adapter service does not implement connect: ${adapter}` };
  }

  const needsOwnerClaim = adapterAccountNeedsOwnerClaim(ctx, adapter, accountId, ownerUid);
  ctx.adapters.status.beginLifecycle(adapter, accountId);
  try {
    if (needsOwnerClaim) {
      ctx.adapters.status.setOwner(adapter, accountId, ownerUid);
    }
    let connectResult;
    try {
      connectResult = await service.adapterConnect(accountId, args.config);
    } catch (error) {
      console.error(`[adapter.connect] failed adapter=${adapter} accountId=${accountId}`, error);
      throw error;
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
      connected: connectResult.connected ?? true,
      authenticated: connectResult.authenticated ?? !connectResult.challenge,
      mode: previous?.mode,
      lastActivity: previous?.lastActivity,
      error: undefined,
      extra: previous?.extra,
    });
    const status = await refreshAdapterStatus(service, ctx, adapter, accountId);
    const connected = status?.connected ?? connectResult.connected ?? true;
    const authenticated =
      status?.authenticated ?? connectResult.authenticated ?? !connectResult.challenge;

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
  if (ownerUid !== 0 && ctx.adapters.status.get(adapter, accountId)?.ownerUid !== ownerUid) {
    throw new Error(`Permission denied: adapter account ${adapter}/${accountId}`);
  }

  const service = resolveAdapterService(ctx.env, adapter);
  if (!service) {
    return { ok: false, error: `Adapter service unavailable: ${adapter}` };
  }
  if (typeof service.adapterDisconnect !== "function") {
    return { ok: false, error: `Adapter service does not implement disconnect: ${adapter}` };
  }

  ctx.adapters.status.beginLifecycle(adapter, accountId);
  try {
    const result = await service.adapterDisconnect(accountId);
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

export async function handleAdapterSend(
  args: AdapterSendArgs,
  ctx: KernelContext,
  body?: BinaryBody,
): Promise<AdapterSendResult> {
  const adapter = typeof args.adapter === "string" ? args.adapter.trim().toLowerCase() : "";
  const accountId = typeof args.accountId === "string" ? args.accountId.trim() : "";

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
  if (typeof args.text !== "string") {
    return rejectAdapterSend(body, "text must be a string");
  }
  if (args.replyToId !== undefined && typeof args.replyToId !== "string") {
    return rejectAdapterSend(body, "replyToId must be a string");
  }
  if (args.also !== undefined && typeof args.also !== "boolean") {
    return rejectAdapterSend(body, "also must be a boolean");
  }
  if (!args.also && isCurrentAutomaticReplyDestination(ctx, adapter, accountId, surface)) {
    return rejectAdapterSend(
      body,
      "This target is the current run's automatic reply destination. Return the text normally, or use --also to intentionally send an additional message.",
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
 * Deliver the terminal output for a run to its trusted reply destination.
 * This deliberately bypasses the explicit-send duplicate guard while still
 * rechecking that the linked actor belongs to the route owner.
 */
export async function deliverAdapterReply(
  destination: AdapterMessageDestination,
  ownerUid: number,
  message: Pick<AdapterSendArgs, "deliveryId" | "text" | "media" | "replyToId">,
  ctx: KernelContext,
  body?: BinaryBody,
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
  }, ctx, body);
}

async function deliverAdapterMessage(
  args: Pick<AdapterSendArgs, "adapter" | "accountId" | "deliveryId" | "surface" | "text" | "media" | "replyToId"> & {
    actorId?: string;
  },
  ctx: KernelContext,
  body?: BinaryBody,
): Promise<AdapterSendResult> {
  const adapter = args.adapter.trim().toLowerCase();
  const accountId = args.accountId.trim();

  if (args.deliveryId !== undefined && typeof args.deliveryId !== "string") {
    await cancelBinaryBody(body, "Invalid adapter delivery id");
    return { ok: false, error: "Adapter deliveryId is invalid", retryable: false };
  }
  const deliveryId = args.deliveryId?.trim() || crypto.randomUUID();
  if (deliveryId.length > 200 || !/^[a-zA-Z0-9._:-]+$/.test(deliveryId)) {
    await cancelBinaryBody(body, "Invalid adapter delivery id");
    return { ok: false, error: "Adapter deliveryId is invalid", retryable: false };
  }

  const service = resolveAdapterService(ctx.env, adapter);
  if (!service || typeof service.adapterSend !== "function") {
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

  const outbound: AdapterOutboundMessage = {
    deliveryId,
    surface: args.surface,
    ...(args.actorId ? { actorId: args.actorId } : {}),
    text: args.text,
    media: args.media,
    replyToId: args.replyToId,
  };

  let result;
  try {
    result = await service.adapterSend(accountId, outbound, body);
  } catch {
    return {
      ok: false,
      error: publicAdapterDeliveryError(adapter, true),
      deliveryId,
      retryable: true,
    };
  } finally {
    await cancelBinaryBody(body, "adapter.send completed");
  }
  if (!result.ok) {
    if (result.ambiguous) {
      return {
        ok: true,
        adapter,
        accountId,
        surfaceId: args.surface.id,
        deliveryId,
        deliveryState: "ambiguous",
      };
    }
    return {
      ok: false,
      error: publicAdapterDeliveryError(adapter, result.retryable === true),
      deliveryId,
      retryable: result.retryable === true,
    };
  }

  return {
    ok: true,
    adapter,
    accountId,
    surfaceId: args.surface.id,
    deliveryId,
    messageId: result.messageId,
    deliveryState: result.deduplicated ? "deduplicated" : "sent",
  };
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
  return route?.kind === "adapter"
    && route.processId === ctx.processId
    && route.adapter === adapter
    && route.accountId === accountId
    && route.surfaceKind === surface.kind
    && route.surfaceId === surface.id.trim()
    && (route.threadId ?? "") === (surface.threadId?.trim() ?? "");
}

function normalizeAdapterSurface(surface: AdapterSurface | undefined): AdapterSurface {
  if (!surface || typeof surface !== "object") {
    throw new Error("surface is required");
  }
  if (
    surface.kind !== "dm"
    && surface.kind !== "group"
    && surface.kind !== "channel"
    && surface.kind !== "thread"
  ) {
    throw new Error("surface.kind is invalid");
  }
  if (typeof surface.id !== "string" || !surface.id.trim()) {
    throw new Error("surface.id is required");
  }
  if (surface.threadId !== undefined && typeof surface.threadId !== "string") {
    throw new Error("surface.threadId must be a string");
  }
  return {
    kind: surface.kind,
    id: surface.id.trim(),
    ...(surface.threadId?.trim() ? { threadId: surface.threadId.trim() } : {}),
  };
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
  return links.some((link) => linkAllowsAdapterSurface(link, surface))
    || callerOwnsAdapterSurfaceRoute(ctx, adapter, accountId, surface, ownerUid, links);
}

function linkAllowsAdapterSurface(link: IdentityLinkRecord, surface: AdapterSurface): boolean {
  const surfaceKind = surface.kind;
  const surfaceId = surface.id.trim();
  const linkedSurfaceKind = metadataString(link.metadata, "surfaceKind");
  const linkedSurfaceId = metadataString(link.metadata, "surfaceId");
  if (linkedSurfaceKind && linkedSurfaceId) {
    return linkedSurfaceKind === surfaceKind && linkedSurfaceId === surfaceId;
  }
  return false;
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

function metadataString(metadata: Record<string, unknown> | null | undefined, key: string): string {
  const value = metadata?.[key];
  return typeof value === "string" ? value.trim() : "";
}

export async function handleAdapterStatus(
  args: AdapterStatusArgs,
  ctx: KernelContext,
): Promise<AdapterStatusResult> {
  const adapter = normalizeAdapterName(args.adapter);
  if (!adapter) throw new Error("adapter is required");
  const accountId = args.accountId?.trim() || undefined;

  const service = resolveAdapterService(ctx.env, adapter);
  if (service && typeof service.adapterStatus === "function") {
    const refreshAccountIds = adapterStatusRefreshAccountIds(ctx, adapter, accountId);
    for (const refreshAccountId of refreshAccountIds) {
      try {
        const statuses = await service.adapterStatus(refreshAccountId);
        const allowedAccountIds = refreshAccountId ? new Set([refreshAccountId]) : null;
        for (const status of statuses) {
          if (allowedAccountIds && !allowedAccountIds.has(status.accountId.trim())) {
            continue;
          }
          ctx.adapters.status.upsert(adapter, status.accountId, status);
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

export function handleAdapterList(
  _args: AdapterListArgs,
  ctx: KernelContext,
): AdapterListResult {
  const entries = new Map<string, AdapterListEntry>();

  for (const key of Object.keys(ctx.env)) {
    const adapter = adapterNameFromBindingKey(key);
    if (!adapter) continue;

    const value = Reflect.get(ctx.env, key);
    const service = value && typeof value === "object"
      ? value as AdapterServiceBinding
      : null;
    entries.set(adapter, adapterListEntry(adapter, service));
  }

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
  try {
    return await handleAdapterInboundOwned(args, ctx, body);
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

  const adapter = typeof args.adapter === "string" ? args.adapter.trim().toLowerCase() : "";
  const accountId = typeof args.accountId === "string" ? args.accountId.trim() : "";
  const inbound = args.message;

  if (!adapter) return { ok: false, error: "adapter is required" };
  if (!accountId) return { ok: false, error: "accountId is required" };
  if (typeof inbound?.messageId !== "string" || !inbound.messageId.trim()) {
    return { ok: false, error: "message.messageId is required" };
  }
  if (typeof inbound?.surface?.id !== "string" || !inbound.surface.id.trim()) {
    return { ok: false, error: "message.surface.id is required" };
  }
  if (
    inbound.surface.kind !== "dm"
    && inbound.surface.kind !== "group"
    && inbound.surface.kind !== "channel"
    && inbound.surface.kind !== "thread"
  ) {
    return { ok: false, error: "message.surface.kind is invalid" };
  }
  if (typeof inbound.text !== "string") {
    return { ok: false, error: "message.text is required" };
  }
  if (inbound.actor && typeof inbound.actor.id !== "string") {
    return { ok: false, error: "message.actor.id is invalid" };
  }
  if (inbound.surface.threadId !== undefined && typeof inbound.surface.threadId !== "string") {
    return { ok: false, error: "message.surface.threadId is invalid" };
  }
  if (inbound.replyToId !== undefined && typeof inbound.replyToId !== "string") {
    return { ok: false, error: "message.replyToId is invalid" };
  }
  const message: AdapterInboundMessage = {
    ...inbound,
    messageId: inbound.messageId.trim(),
    surface: {
      ...inbound.surface,
      id: inbound.surface.id.trim(),
      ...(inbound.surface.threadId?.trim()
        ? { threadId: inbound.surface.threadId.trim() }
        : { threadId: undefined }),
    },
    ...(inbound.actor
      ? { actor: { ...inbound.actor, id: inbound.actor.id.trim() } }
      : {}),
    replyToId: inbound.replyToId?.trim() || undefined,
  };

  const actorId = resolveActorId(message);
  if (!actorId) {
    return { ok: false, error: "message.actor.id is required" };
  }

  const receiptId = await stableOpaqueId("adapter-ingress", [
    adapter,
    accountId,
    actorId,
    message.surface.kind,
    message.surface.id,
    message.surface.threadId ?? null,
    message.messageId,
  ]);
  // The receipt id is already opaque, stable, and valid as a delivery-id
  // prefix. Suffixing the immediate outcome avoids another hashing round on
  // every inbound message while keeping reply and challenge attempts distinct.
  const replyDeliveryId = `${receiptId}:reply`;
  const challengeDeliveryId = `${receiptId}:challenge`;
  const receipt = ctx.adapters.ingressReceipts.claim({
    receiptId,
    adapter,
    accountId,
    actorId,
    surfaceKind: message.surface.kind,
    surfaceId: message.surface.id,
    threadId: message.surface.threadId,
    providerMessageId: message.messageId,
  });
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
      message,
      body,
      ctx,
    });
    const {
      reply: immediateReply,
      challenge: immediateChallenge,
      ...baseDisposition
    } = disposition;
    const result: AdapterInboundSyscallResult = {
      ...baseDisposition,
      ...(immediateReply
        ? { reply: { deliveryId: replyDeliveryId, ...immediateReply } }
        : {}),
      ...(immediateChallenge
        ? { challenge: { deliveryId: challengeDeliveryId, ...immediateChallenge } }
        : {}),
    };
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
  recovery?: unknown;
  adapter: string;
  accountId: string;
  actorId: string;
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
    message,
    body,
    ctx,
  } = input;
  const recovery = normalizeAdapterIngressRecovery(input.recovery);
  const uid = ctx.adapters.identityLinks.resolveUid(adapter, accountId, actorId);
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

  if (recovery?.kind === "process_delivery") {
    if (recovery.uid !== uid) {
      return { ok: false, error: "Adapter ingress owner changed during recovery" };
    }
    return deliverAdapterInboundToProcess({
      adapter,
      accountId,
      actorId,
      message,
      ctx,
      recovery,
    });
  }
  if (recovery?.kind === "hil_decision") {
    return deliverAdapterHilDecision({
      adapter,
      accountId,
      message,
      ctx,
      recovery,
      reconciling: true,
    });
  }

  const command = await handleAdapterCommand({
    adapter,
    accountId,
    message,
    uid,
    operationId: receiptId,
    ctx,
  });
  if (command.handled) {
    return {
      ok: true,
      ...(command.reply ? { reply: command.reply } : {}),
    };
  }

  const pid = await resolveAdapterRoute(
    adapter,
    accountId,
    actorId,
    message.surface,
    uid,
    userIdentity,
    ctx,
  );
  ctx.adapters.surfaceRoutes.setRoute({
    adapter,
    accountId,
    actorId,
    surfaceKind: message.surface.kind,
    surfaceId: message.surface.id,
    threadId: message.surface.threadId,
    uid,
    pid,
    updatedByUid: uid,
  });

  const pendingHil = await getPendingHil(pid);
  if (pendingHil) {
    const parsedDecision = message.surface.kind === "dm"
      ? parseHilDecision(message.text)
      : null;
    const decision = parsedDecision?.requestToken === adapterHilRequestToken(pendingHil.requestId)
      ? parsedDecision
      : null;

    if (!decision) {
      return {
        ok: true,
        reply: {
          text: parsedDecision
            ? renderAdapterHilCorrelationFailure(pendingHil, message.surface.kind)
            : renderAdapterHilPrompt(pendingHil, message.surface.kind, "reminder"),
          replyToId: message.messageId,
        },
      };
    }

    const hilRecovery: AdapterIngressHilRecovery = {
      kind: "hil_decision",
      pid,
      requestId: pendingHil.requestId,
      decision: decision.decision,
      remember: decision.remember,
    };
    ctx.adapters.ingressReceipts.checkpoint(receiptId, claimToken, hilRecovery);
    return deliverAdapterHilDecision({
      adapter,
      accountId,
      message,
      ctx,
      recovery: hilRecovery,
      reconciling: false,
    });
  }
  return deliverAdapterInboundToProcess({
    adapter,
    accountId,
    actorId,
    message,
    body,
    uid,
    pid,
    ctx,
    checkpoint: { receiptId, claimToken },
  });
}

async function deliverAdapterHilDecision(input: {
  adapter: string;
  accountId: string;
  message: AdapterInboundMessage;
  ctx: KernelContext;
  recovery: AdapterIngressHilRecovery;
  reconciling: boolean;
}): Promise<AdapterInboundDisposition> {
  const { adapter, accountId, message, ctx, recovery, reconciling } = input;
  const response = await sendFrameToProcess(recovery.pid, {
    type: "req",
    id: crypto.randomUUID(),
    call: "proc.hil",
    args: {
      pid: recovery.pid,
      requestId: recovery.requestId,
      decision: recovery.decision,
      ...(recovery.remember ? { remember: true } : {}),
    },
  } as RequestFrame);

  if (!response || response.type !== "res") {
    throw new Error("No response from process");
  }
  if (!response.ok) {
    // A Process error envelope does not prove whether the durable decision was
    // committed. Leave the checkpoint reclaimable and retry the same request.
    throw new Error(response.error.message);
  }

  const data = (response as {
    data?: {
      ok?: boolean;
      error?: string;
      resumed?: boolean;
      pendingHil?: unknown;
    };
  }).data;
  if (data?.ok === false) {
    if (!reconciling) {
      return { ok: false, error: data.error || "Process rejected approval" };
    }

    // The earlier attempt may have committed and cleared this request before
    // its response was lost. Query current state, but never apply the old
    // YES/DENY to a newer approval or turn it into ordinary conversation text.
    const current = await getPendingHil(recovery.pid);
    if (current?.requestId === recovery.requestId) {
      throw new Error(data.error || "Process has not reconciled approval yet");
    }
    if (current) {
      return {
        ok: true,
        reply: {
          text: renderAdapterHilPrompt(current, message.surface.kind, "reminder"),
          replyToId: message.messageId,
        },
      };
    }
    return adapterHilDecisionAcknowledgement(message, recovery);
  }

  const nextPendingHil = normalizeAdapterHilRequest(data?.pendingHil);
  if (!nextPendingHil && data?.resumed) {
    await setAdapterActivityForKernel(
      ctx.env,
      adapter,
      accountId,
      message.surface,
      { kind: "typing", active: true },
    );
  }
  if (nextPendingHil) {
    return {
      ok: true,
      reply: {
        text: renderAdapterHilPrompt(nextPendingHil, message.surface.kind, "reminder"),
        replyToId: message.messageId,
      },
    };
  }
  return adapterHilDecisionAcknowledgement(message, recovery);
}

function adapterHilDecisionAcknowledgement(
  message: AdapterInboundMessage,
  recovery: AdapterIngressHilRecovery,
): AdapterInboundDisposition {
  return {
    ok: true,
    reply: {
      text: recovery.decision === "approve"
        ? recovery.remember
          ? "Approved. I will remember this for this conversation."
          : "Approved. Continuing."
        : "Denied. Continuing.",
      replyToId: message.messageId,
    },
  };
}

async function deliverAdapterInboundToProcess(input: {
  adapter: string;
  accountId: string;
  actorId: string;
  message: AdapterInboundMessage;
  ctx: KernelContext;
  body?: BinaryBody;
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
    const runId = await stableOpaqueId("adapter-run", [
      adapter,
      accountId,
      actorId,
      message.surface.kind,
      message.surface.id.trim(),
      message.surface.threadId?.trim() || null,
      message.messageId.trim(),
    ]);
    const media = await storeAdapterInboundMedia(
      input.pid,
      runId,
      message.media,
      input.body,
      ctx.requestSignal,
    );
    recovery = {
      kind: "process_delivery",
      uid: input.uid,
      pid: input.pid,
      runId,
      media: media ?? [],
      origin: adapterInteractionOrigin(adapter, accountId, message, actorId),
    };
    ctx.adapters.ingressReceipts.checkpoint(
      input.checkpoint.receiptId,
      input.checkpoint.claimToken,
      recovery,
    );
  }

  const { uid, pid, runId, origin } = recovery;
  const media = recovery.media.length > 0 ? recovery.media : undefined;
  ctx.adapters.surfaceRoutes.setRoute({
    adapter,
    accountId,
    actorId,
    surfaceKind: message.surface.kind,
    surfaceId: message.surface.id,
    threadId: message.surface.threadId,
    uid,
    pid,
    updatedByUid: uid,
  });
  ctx.runRoutes.setAdapterRoute({
    runId,
    processId: pid,
    uid,
    adapter,
    accountId,
    actorId,
    surfaceKind: message.surface.kind,
    surfaceId: message.surface.id,
    threadId: message.surface.threadId,
    replyToId: message.messageId,
  });
  await setAdapterActivityForKernel(
    ctx.env,
    adapter,
    accountId,
    message.surface,
    { kind: "typing", active: true },
  );

  let response: ProcessAdapterDeliverResponseFrame | null;
  try {
    response = await sendFrameToProcess(pid, {
      type: "req",
      id: crypto.randomUUID(),
      call: "proc.adapter.deliver",
      args: {
        runId,
        pid,
        message: message.text?.trim() || "",
        media,
        origin,
      },
    } as ProcessAdapterDeliverRequestFrame);
  } catch (error) {
    await stopAdapterTyping(ctx, adapter, accountId, message.surface);
    throw error;
  }

  if (!response || response.type !== "res") {
    await stopAdapterTyping(ctx, adapter, accountId, message.surface);
    throw new Error("No response from process");
  }
  if (!response.ok) {
    await stopAdapterTyping(ctx, adapter, accountId, message.surface);
    throw new Error(response.error.message);
  }

  const data = (response as ProcessAdapterDeliverResponseFrame & { ok: true }).data;
  if (!data.ok) {
    ctx.runRoutes.delete(runId);
    await stopAdapterTyping(ctx, adapter, accountId, message.surface);
    await rollbackAdapterMedia(pid, media);
    return { ok: false, error: data.error };
  }
  const queued = data.queued === true;
  if (data.runId !== runId) {
    ctx.runRoutes.delete(runId);
    await stopAdapterTyping(ctx, adapter, accountId, message.surface);
    await rollbackAdapterMedia(pid, media);
    return { ok: false, error: "proc.adapter.deliver admitted an unexpected run" };
  }
  if (data.replayed === "recorded") {
    ctx.runRoutes.delete(runId);
    await stopAdapterTyping(ctx, adapter, accountId, message.surface);
    await rollbackAdapterMedia(pid, media);
  }
  if (queued) {
    await stopAdapterTyping(ctx, adapter, accountId, message.surface);
  }

  return {
    ok: true,
    delivered: { uid, pid, runId, queued },
  };
}

function normalizeAdapterIngressRecovery(value: unknown): AdapterIngressRecovery | null {
  if (value === undefined) return null;
  if (!value || typeof value !== "object") {
    throw new Error("Invalid adapter ingress recovery checkpoint");
  }
  const recovery = value as Partial<AdapterIngressRecovery>;
  if (recovery.kind === "hil_decision") {
    if (
      typeof recovery.pid === "string"
      && typeof recovery.requestId === "string"
      && (recovery.decision === "approve" || recovery.decision === "deny")
      && typeof recovery.remember === "boolean"
    ) {
      return recovery as AdapterIngressHilRecovery;
    }
  } else if (recovery.kind === "process_delivery") {
    if (
      Number.isSafeInteger(recovery.uid)
      && typeof recovery.pid === "string"
      && typeof recovery.runId === "string"
      && Array.isArray(recovery.media)
      && recovery.origin
      && typeof recovery.origin === "object"
      && recovery.origin.kind === "adapter"
    ) {
      return recovery as AdapterIngressProcessRecovery;
    }
  }
  throw new Error("Invalid adapter ingress recovery checkpoint");
}

async function stopAdapterTyping(
  ctx: KernelContext,
  adapter: string,
  accountId: string,
  surface: AdapterSurface,
): Promise<void> {
  await setAdapterActivityForKernel(
    ctx.env,
    adapter,
    accountId,
    surface,
    { kind: "typing", active: false },
  );
}

async function storeAdapterInboundMedia(
  pid: string,
  runId: string,
  media: AdapterInboundMessage["media"],
  body: BinaryBody | undefined,
  signal?: AbortSignal,
): Promise<ProcMediaInput[] | undefined> {
  validateAdapterMediaItems(media, "inbound");
  const stored: ProcMediaInput[] = [];
  try {
    await consumeAdapterMediaBodyParts(media, body, async ({
      mediaIndex,
      media: item,
      body: partBody,
    }) => {
      const response = await sendFrameToProcess(pid, {
        type: "req",
        id: crypto.randomUUID(),
        call: "proc.media.write",
        args: {
          pid,
          type: item.type,
          mimeType: item.mimeType,
          mediaId: `${runId}:${mediaIndex}`,
          ...(item.filename ? { filename: item.filename } : {}),
          ...(item.duration !== undefined ? { duration: item.duration } : {}),
          ...(item.transcription ? { transcription: item.transcription } : {}),
        },
        body: partBody,
      } as RequestFrame<"proc.media.write">);
      if (!response || response.type !== "res" || !response.ok) {
        throw new Error(response && response.type === "res" && !response.ok
          ? response.error.message
          : "No response while storing adapter media");
      }
      const result = (response as ResponseOkFrame<"proc.media.write">).data;
      if (!result?.ok) {
        throw new Error(result?.error || "Failed to store adapter media");
      }
      stored.push(result.media);
    }, {
      maxBytes: MAX_MESSAGE_MEDIA_TOTAL_BYTES,
      maxPartBytes: MAX_MESSAGE_MEDIA_PART_BYTES,
      signal,
    });
  } catch (error) {
    await rollbackAdapterMedia(pid, stored);
    throw error;
  }
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
    if (typeof item.mimeType !== "string" || !item.mimeType.trim()) {
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

async function rollbackAdapterMedia(
  pid: string,
  media: ProcMediaInput[] | undefined,
): Promise<void> {
  await Promise.allSettled((media ?? []).flatMap(({ key }) => key
    ? [sendFrameToProcess(pid, {
        type: "req",
        id: crypto.randomUUID(),
        call: "proc.media.delete",
        args: { pid, key },
      } as RequestFrame<"proc.media.delete">)]
    : []));
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

  const status = ctx.adapters.status.upsert(adapter, accountId, {
    ...args.status,
    accountId,
  });
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

function adapterListEntry(adapter: string, service: AdapterServiceBinding | null): AdapterListEntry {
  return {
    adapter,
    available: service !== null,
    supportsConnect: typeof service?.adapterConnect === "function",
    supportsDisconnect: typeof service?.adapterDisconnect === "function",
    supportsSend: typeof service?.adapterSend === "function",
    supportsStatus: typeof service?.adapterStatus === "function",
    supportsActivity: typeof service?.adapterSetActivity === "function",
    accounts: [],
  };
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
  env: Env,
  adapter: string,
  accountId: string,
  surface: AdapterSurface,
  activity: AdapterActivity,
): Promise<void> {
  const service = resolveAdapterService(env, adapter);
  if (!service || typeof service.adapterSetActivity !== "function") {
    return;
  }

  try {
    const result = await service.adapterSetActivity(accountId, surface, activity);
    if (!result.ok) {
      console.warn(
        `[adapter.activity] failed adapter=${adapter} accountId=${accountId} kind=${activity.kind} active=${activity.active} error=${result.error}`,
      );
    }
  } catch (error) {
    console.warn(
      `[adapter.activity] threw adapter=${adapter} accountId=${accountId} kind=${activity.kind} active=${activity.active}`,
      error,
    );
  }
}

async function refreshAdapterStatus(
  service: AdapterServiceBinding,
  ctx: KernelContext,
  adapter: string,
  accountId: string,
): Promise<AdapterAccountStatus | null> {
  if (typeof service.adapterStatus !== "function") {
    return null;
  }

  try {
    const statuses = await service.adapterStatus(accountId);
    for (const status of statuses) {
      ctx.adapters.status.upsert(adapter, status.accountId, status);
    }
    return statuses.find((status) => status.accountId === accountId) ?? null;
  } catch (error) {
    console.error(`[adapter.status] refresh failed adapter=${adapter} accountId=${accountId}`, error);
    return null;
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
  const routedPid = ctx.adapters.surfaceRoutes.resolvePid(routeKey);
  if (routedPid) {
    const routedProcess = ctx.procs.get(routedPid);
    if (routedProcess && routedProcess.ownerUid === uid && routedProcess.interactive) {
      return routedPid;
    }
    ctx.adapters.surfaceRoutes.clearRoute(routeKey);
  }

  return ensureDefaultConversationExecutor(ctx, userIdentity);
}

async function handleAdapterCommand(args: {
  adapter: string;
  accountId: string;
  message: AdapterInboundMessage;
  uid: number;
  operationId: string;
  ctx: KernelContext;
}): Promise<AdapterCommandResult> {
  const { adapter, accountId, message, uid, operationId, ctx } = args;
  if (message.surface.kind !== "dm") {
    return { handled: false };
  }

  const text = message.text.trim();
  if (!text.startsWith("/")) {
    return { handled: false };
  }

  const [rawCommand, ...rest] = text.split(/\s+/);
  const command = rawCommand.toLowerCase();
  const selector = rest.join(" ").trim();
  const actorId = resolveActorId(message);
  if (!actorId) {
    return replyToAdapterCommand(message, "This adapter message has no linked actor identity.");
  }

  if (command === "/help") {
    return replyToAdapterCommand(message, renderAdapterCommandHelp());
  }

  if (command === "/where") {
    const routed = resolveExistingAdapterRoute(
      adapter,
      accountId,
      actorId,
      message.surface,
      uid,
      ctx,
    );
    return replyToAdapterCommand(
      message,
      routed
        ? `This chat is routed to ${describeProcessRoute(routed)}. Use /use personal to return to your personal conversation.`
        : "This chat is using your personal conversation. Use /list to see routable agents and processes.",
    );
  }

  if (command === "/list") {
    return replyToAdapterCommand(message, renderAdapterRouteList(uid, ctx));
  }

  if (command === "/use") {
    if (!selector) {
      return replyToAdapterCommand(message, "Usage: /use personal, /use <process-id>, or /use <agent-name>.");
    }

    const normalized = selector.toLowerCase();
    if (normalized === "personal" || normalized === "default" || normalized === "home") {
      const identity = identityForUid(uid, ctx);
      if (!identity) {
        return replyToAdapterCommand(message, "Your local user identity is unavailable.");
      }
      const pid = await ensureDefaultConversationExecutor(ctx, identity);
      ctx.adapters.surfaceRoutes.setRoute({
        adapter,
        accountId,
        actorId,
        surfaceKind: message.surface.kind,
        surfaceId: message.surface.id,
        threadId: message.surface.threadId,
        uid,
        pid,
        updatedByUid: uid,
      });
      return replyToAdapterCommand(message, "This chat now uses your personal conversation.");
    }

    const processMatch = findProcessForSelector(selector, uid, ctx);
    if (processMatch.kind === "ambiguous") {
      return replyToAdapterCommand(message, `More than one process matches "${selector}". Use a longer process id from /list.`);
    }
    if (processMatch.kind === "found") {
      ctx.adapters.surfaceRoutes.setRoute({
        adapter,
        accountId,
        actorId,
        surfaceKind: message.surface.kind,
        surfaceId: message.surface.id,
        threadId: message.surface.threadId,
        uid,
        pid: processMatch.record.processId,
        updatedByUid: uid,
      });
      return replyToAdapterCommand(message, `This chat now uses ${describeProcessRoute(processMatch.record)}.`);
    }

    const agent = findRunnableAgent(selector, uid, ctx);
    if (!agent) {
      return replyToAdapterCommand(message, `I could not find a process or agent named "${selector}". Use /list to see available targets.`);
    }

    const pid = await spawnAdapterAgentProcess(
      agent,
      uid,
      message.surface,
      operationId,
      ctx,
    );
    ctx.adapters.surfaceRoutes.setRoute({
      adapter,
      accountId,
      actorId,
      surfaceKind: message.surface.kind,
      surfaceId: message.surface.id,
      threadId: message.surface.threadId,
      uid,
      pid,
      updatedByUid: uid,
    });
    return replyToAdapterCommand(message, `This chat now uses ${agent.username}.`);
  }

  return replyToAdapterCommand(message, `Unknown command: ${rawCommand}\n\n${renderAdapterCommandHelp()}`);
}

function resolveExistingAdapterRoute(
  adapter: string,
  accountId: string,
  actorId: string,
  surface: AdapterSurface,
  uid: number,
  ctx: KernelContext,
): NonNullable<ReturnType<KernelContext["procs"]["get"]>> | null {
  const routeKey = {
    adapter,
    accountId,
    actorId,
    surfaceKind: surface.kind,
    surfaceId: surface.id,
    threadId: surface.threadId,
    uid,
  };
  const routedPid = ctx.adapters.surfaceRoutes.resolvePid(routeKey);
  if (!routedPid) {
    return null;
  }
  const routedProcess = ctx.procs.get(routedPid);
  if (routedProcess && routedProcess.ownerUid === uid && routedProcess.interactive) {
    return routedProcess;
  }
  ctx.adapters.surfaceRoutes.clearRoute(routeKey);
  return null;
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

function renderAdapterCommandHelp(): string {
  return [
    "Adapter commands:",
    "/list - show available agents and active processes",
    "/where - show where this chat is routed",
    "/use personal - route back to your personal conversation",
    "/use <process-id> - route this chat to an active process",
    "/use <agent-name> - start and route this chat to an agent",
    "",
    "When approval is pending, reply approve, deny, or approve always.",
  ].join("\n");
}

function renderAdapterRouteList(uid: number, ctx: KernelContext): string {
  const agents = listRunnableAgents(uid, ctx);
  const processes = ctx.procs.list(uid).filter((record) => record.interactive);
  const lines = ["Available routes:"];

  lines.push("", "Agents:");
  if (agents.length === 0) {
    lines.push("- none");
  } else {
    for (const agent of agents.slice(0, 8)) {
      lines.push(`- ${agent.username}${agent.label ? ` (${agent.label})` : ""}`);
    }
  }

  lines.push("", "Processes:");
  if (processes.length === 0) {
    lines.push("- none");
  } else {
    for (const process of processes.slice(0, 8)) {
      lines.push(`- ${shortProcessId(process.processId)} ${process.label || process.username} [${process.state}]`);
    }
  }

  lines.push("", "Use /use personal, /use <agent-name>, or /use <process-id>.");
  return lines.join("\n");
}

type ProcessSelectorResult =
  | { kind: "found"; record: NonNullable<ReturnType<KernelContext["procs"]["get"]>> }
  | { kind: "ambiguous" }
  | { kind: "missing" };

function findProcessForSelector(selector: string, uid: number, ctx: KernelContext): ProcessSelectorResult {
  const normalized = selector.trim().toLowerCase();
  if (!normalized) {
    return { kind: "missing" };
  }

  const processes = ctx.procs.list(uid).filter((record) => record.interactive);
  const exact = processes.find((record) => record.processId.toLowerCase() === normalized);
  if (exact) {
    return { kind: "found", record: exact };
  }

  const matches = processes.filter((record) => {
    const pid = record.processId.toLowerCase();
    const shortPid = shortProcessId(record.processId).toLowerCase();
    const label = record.label?.trim().toLowerCase();
    return pid.startsWith(normalized)
      || shortPid === normalized
      || shortPid.startsWith(normalized)
      || label === normalized;
  });

  if (matches.length === 1) {
    return { kind: "found", record: matches[0] };
  }
  if (matches.length > 1) {
    return { kind: "ambiguous" };
  }
  return { kind: "missing" };
}

type RunnableAgent = {
  uid: number;
  username: string;
  label: string;
  identity: ProcessIdentity;
};

function findRunnableAgent(selector: string, ownerUid: number, ctx: KernelContext): RunnableAgent | null {
  const normalized = selector.trim().toLowerCase();
  return listRunnableAgents(ownerUid, ctx).find((agent) => (
    agent.username.toLowerCase() === normalized
    || agent.label.toLowerCase() === normalized
  )) ?? null;
}

function listRunnableAgents(ownerUid: number, ctx: KernelContext): RunnableAgent[] {
  const entries = ctx.auth.getPasswdEntries();
  const personalAgentUid = ctx.auth.getPersonalAgentUid(ownerUid);
  const agents: RunnableAgent[] = [];

  for (const entry of entries) {
    if (entry.uid !== personalAgentUid) {
      const shadow = ctx.auth.getShadowByUsername(entry.username);
      if (!shadow || !isLocked(shadow)) {
        continue;
      }
    }
    if (entry.uid < 1000 && entry.uid !== personalAgentUid) {
      continue;
    }
    if (!canOwnerRunAsAccount(ctx.auth, ownerUid, entry, false)) {
      continue;
    }

    agents.push({
      uid: entry.uid,
      username: entry.username,
      label: entry.gecos?.trim() || entry.username,
      identity: {
        uid: entry.uid,
        gid: entry.gid,
        gids: ctx.auth.resolveGids(entry.username, entry.gid),
        username: entry.username,
        home: entry.home,
        cwd: entry.home,
      },
    });
  }

  agents.sort((left, right) => {
    if (left.uid === personalAgentUid) return -1;
    if (right.uid === personalAgentUid) return 1;
    return left.username.localeCompare(right.username);
  });
  return agents;
}

async function spawnAdapterAgentProcess(
  agent: RunnableAgent,
  ownerUid: number,
  surface: AdapterSurface,
  operationId: string,
  ctx: KernelContext,
): Promise<string> {
  const pid = `proc:${operationId}`;
  const conversationId = `adapter:${operationId}`;
  const label = `adapter ${describeAdapterSurface(surface)} (${agent.username})`;
  if (!ctx.procs.get(pid)) {
    ctx.procs.spawn(pid, agent.identity, {
      ownerUid,
      interactive: true,
      label,
      cwd: agent.identity.cwd,
    });
  }

  const conversation = ctx.conversations.get(conversationId) ?? ctx.conversations.create({
    conversationId,
    ownerUid,
    agentUid: agent.identity.uid,
    agentHome: agent.identity.home,
    title: label,
  });
  ctx.conversations.setActivePid(conversation.conversationId, pid);

  await sendFrameToProcess(pid, {
    type: "req",
    id: crypto.randomUUID(),
    call: "proc.setidentity",
    args: {
      pid,
      identity: agent.identity,
      interactive: true,
      conversationId: conversation.conversationId,
    },
  } as RequestFrame);

  return pid;
}

function describeProcessRoute(record: NonNullable<ReturnType<KernelContext["procs"]["get"]>>): string {
  return `${shortProcessId(record.processId)} ${record.label || record.username}`;
}

function shortProcessId(pid: string): string {
  if (pid.startsWith("proc:")) {
    return pid.slice(0, 13);
  }
  return pid.length > 13 ? pid.slice(0, 13) : pid;
}

function describeAdapterSurface(surface: AdapterSurface): string {
  const label = surface.name?.trim() || surface.handle?.trim() || surface.id;
  return surface.kind === "dm" ? "dm" : `${surface.kind} ${label}`;
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
): InteractionOrigin {
  const actorLabel = message.actor?.handle?.trim() || message.actor?.name?.trim() || undefined;
  return {
    kind: "adapter",
    adapter,
    accountId,
    surface: message.surface,
    actorId,
    ...(actorLabel ? { actorLabel } : {}),
    ...(message.messageId?.trim() ? { messageId: message.messageId.trim() } : {}),
  };
}

async function getPendingHil(pid: string): Promise<AdapterHilRequest | null> {
  const response = await sendFrameToProcess(pid, {
    type: "req",
    id: crypto.randomUUID(),
    call: "proc.history",
    args: { pid, limit: 1, offset: 0 },
  } as RequestFrame);

  if (!response || response.type !== "res" || !response.ok) {
    return null;
  }

  const data = (response as { data?: { pendingHil?: unknown } }).data;
  return normalizeAdapterHilRequest(data?.pendingHil);
}

export function normalizeAdapterHilRequest(
  value: unknown,
  source: "pending" | "signal" = "pending",
): AdapterHilRequest | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.requestId !== "string"
    || typeof record.toolName !== "string"
    || typeof record.syscall !== "string"
    || !record.args
    || typeof record.args !== "object"
    || (source === "signal" && (
      typeof record.runId !== "string"
      || typeof record.callId !== "string"
    ))
  ) {
    return null;
  }
  return {
    requestId: record.requestId,
    toolName: record.toolName,
    syscall: record.syscall,
    args: record.args as Record<string, unknown>,
  };
}

function parseHilDecision(text: string): ParsedHilDecision | null {
  const normalized = text.trim().replace(/[.!?]+$/g, "");
  const match = /^(approve\s+always|allow\s+always|yes\s+always|always\s+approve|always\s+allow|approve|allow|yes|deny|reject|no)(?:\s+(\S+))?$/i.exec(normalized);
  if (!match) return null;

  const phrase = match[1].toLowerCase().replace(/\s+/g, " ");
  const decision = phrase === "deny" || phrase === "reject" || phrase === "no"
    ? "deny"
    : "approve";
  return {
    decision,
    remember: decision === "approve" && phrase.includes("always"),
    ...(match[2] ? { requestToken: match[2] } : {}),
  };
}

function adapterHilRequestToken(requestId: string): string {
  return `hil[${requestId}]`;
}

function renderAdapterHilCorrelationFailure(
  pendingHil: AdapterHilRequest,
  surfaceKind: AdapterSurface["kind"],
): string {
  return [
    "I couldn\u2019t verify that approval response was for the current request.",
    "",
    renderAdapterHilPrompt(pendingHil, surfaceKind, "reminder"),
  ].join("\n");
}

export function renderAdapterHilPrompt(
  pendingHil: AdapterHilRequest,
  surfaceKind: AdapterSurface["kind"],
  phase: "initial" | "reminder",
): string {
  const action = summarizeAdapterHilRequest(pendingHil);
  const requestToken = adapterHilRequestToken(pendingHil.requestId);
  const responseLine = surfaceKind === "dm"
    ? phase === "initial"
      ? `Reply "approve ${requestToken}" to continue, "approve always ${requestToken}" to remember it for this conversation, or "deny ${requestToken}" to stop this action.`
      : `Reply "approve ${requestToken}", "deny ${requestToken}", or "approve always ${requestToken}" to continue.`
    : "Open Chat to approve or deny this action.";
  return [
    phase === "initial"
      ? "I need your confirmation before I can continue."
      : "I’m waiting for confirmation before I can continue.",
    "",
    action,
    "",
    responseLine,
  ].join("\n");
}

function summarizeAdapterHilRequest(pendingHil: AdapterHilRequest): string {
  const path = typeof pendingHil.args.path === "string" ? pendingHil.args.path : "";
  const command = typeof pendingHil.args.input === "string" ? pendingHil.args.input : "";

  if (pendingHil.syscall === "shell.exec") {
    return command
      ? `Requested action: run \`${command}\`.`
      : "Requested action: run a shell command.";
  }
  if (pendingHil.syscall === "fs.read") {
    return path
      ? `Requested action: read \`${path}\`.`
      : "Requested action: read a file.";
  }
  if (pendingHil.syscall === "fs.write") {
    return path
      ? `Requested action: write \`${path}\`.`
      : "Requested action: write a file.";
  }
  if (pendingHil.syscall === "fs.edit") {
    return path
      ? `Requested action: edit \`${path}\`.`
      : "Requested action: edit a file.";
  }
  if (pendingHil.syscall === "fs.delete") {
    return path
      ? `Requested action: delete \`${path}\`.`
      : "Requested action: delete a file.";
  }
  return `Requested action: ${pendingHil.toolName}.`;
}
