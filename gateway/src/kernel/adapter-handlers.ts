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
  isAdapterWorkerActivityResult,
  isAdapterWorkerConnectResult,
  isAdapterWorkerDisconnectResult,
  isAdapterWorkerSendResult,
  isAdapterWorkerStatusResult,
  validateAdapterMediaBody,
} from "@humansandmachines/gsv/protocol";
import { resolveCallerOwnerUid, type KernelContext } from "./context";
import type { RequestFrame, ResponseOkFrame } from "../protocol/frames";
import type {
  ProcessAdapterDeliverRequestFrame,
  ProcessAdapterDeliverResponseFrame,
  ProcessRuntimeEventDeliverRequestFrame,
  ProcessRuntimeEventDeliverResponseFrame,
} from "../protocol/process-frames";
import { sendFrameToProcess } from "../shared/utils";
import { stableOpaqueId } from "../shared/stable-id";
import { ensurePersonalAgent } from "./agents";
import { ensurePersonalController } from "./personal-controller";
import type { ProcessRecord } from "./processes";
import type { SurfaceRouteRecord } from "./surface-routes";
import type { AdapterStatusRecord } from "./adapter-status";
import type { IdentityLinkRecord } from "./identity-links";
import {
  assertAdapterMessageDestinationAccess,
  identityLinkAllowsSurface,
  normalizeAdapterMessageDestination,
  normalizeAdapterSurface,
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
  | AdapterIngressHilRecovery
  | AdapterIngressWorkReturnRecovery;
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
    let connectResult: unknown;
    try {
      connectResult = await service.adapterConnect(accountId, args.config);
    } catch {
      logAdapterBoundaryFailure("error", "connect_worker_failed");
      return { ok: false, error: `Adapter connect failed: ${adapter}` };
    }
    if (!isAdapterWorkerConnectResult(connectResult)) {
      logAdapterBoundaryFailure("error", "connect_invalid_response");
      return { ok: false, error: `Adapter returned an invalid connect response: ${adapter}` };
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
    let result: unknown;
    try {
      result = await service.adapterDisconnect(accountId);
    } catch {
      logAdapterBoundaryFailure("error", "disconnect_worker_failed");
      return { ok: false, error: `Adapter disconnect failed: ${adapter}` };
    }
    if (!isAdapterWorkerDisconnectResult(result)) {
      logAdapterBoundaryFailure("error", "disconnect_invalid_response");
      return { ok: false, error: `Adapter returned an invalid disconnect response: ${adapter}` };
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

  let result: unknown;
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
  if (!isAdapterWorkerSendResult(result)) {
    logAdapterBoundaryFailure("error", "send_invalid_response");
    return {
      ok: false,
      error: `Adapter returned an invalid send response: ${adapter}`,
      deliveryId,
      retryable: false,
    };
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
  if (service && typeof service.adapterStatus === "function") {
    const refreshAccountIds = adapterStatusRefreshAccountIds(ctx, adapter, accountId);
    for (const refreshAccountId of refreshAccountIds) {
      try {
        const statuses: unknown = await service.adapterStatus(refreshAccountId);
        if (!isAdapterWorkerStatusResult(statuses)) {
          logAdapterBoundaryFailure("error", "status_invalid_response");
          continue;
        }
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
  const providerDeliveryId = typeof args.deliveryId === "string"
    ? args.deliveryId.trim()
    : "";
  const inbound = args.message;

  if (!adapter) return { ok: false, error: "adapter is required" };
  if (!accountId) return { ok: false, error: "accountId is required" };
  if (!providerDeliveryId) return { ok: false, error: "deliveryId is required" };
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

  if (recovery === null && message.surface.kind === "dm") {
    const link = ctx.adapters.identityLinks.get(adapter, accountId, actorId);
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
  if (recovery?.kind === "work_return") {
    if (recovery.uid !== uid) {
      return { ok: false, error: "Adapter ingress owner changed during recovery" };
    }
    const personalPid = await deliverAdapterWorkReturnedEvent(
      recovery,
      receiptId,
      ctx,
    );
    const personal = ctx.procs.get(personalPid);
    return {
      ok: true,
      reply: {
        text: `[PERSONAL HOME] Returned to ${personal ? describeProcessRoute(personal) : shortProcessId(personalPid)}.`,
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
    return {
      ok: true,
      ...(command.reply ? { reply: command.reply } : {}),
    };
  }

  const parsedDecision = message.surface.kind === "dm"
    ? parseHilDecision(message.text)
    : null;
  let pid: string;
  let pendingHil: AdapterHilRequest | null;
  if (parsedDecision?.requestToken) {
    const correlated = await findPendingHilDecisionTarget(
      uid,
      parsedDecision.requestToken,
      ctx,
    );
    if (correlated.kind !== "found") {
      return {
        ok: true,
        reply: {
          text: correlated.kind === "ambiguous"
            ? "I found more than one pending approval with that token. Open Chat to resolve it safely."
            : "I could not find a pending approval with that token. Use the token from the latest approval prompt.",
          replyToId: message.messageId,
        },
      };
    }
    pid = correlated.pid;
    pendingHil = correlated.pending;
  } else {
    pid = await resolveAdapterRoute(
      adapter,
      accountId,
      actorId,
      message.surface,
      uid,
      receiptId,
      userIdentity,
      ctx,
    );
    pendingHil = await getPendingHil(pid);
  }

  if (pendingHil) {
    const decision = parsedDecision?.requestToken === adapterHilRequestToken(pendingHil.requestId)
      ? parsedDecision
      : null;

    if (!decision) {
      return {
        ok: true,
        reply: {
          text: prefixAdapterDmProcessReply(
            parsedDecision
              ? renderAdapterHilCorrelationFailure(pendingHil, message.surface.kind)
              : renderAdapterHilPrompt(pendingHil, message.surface.kind, "reminder"),
            pid,
            {
              kind: "adapter",
              adapter,
              accountId,
              actorId,
              surface: message.surface,
            },
            ctx,
          ),
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
          text: prefixAdapterDmProcessReply(
            renderAdapterHilPrompt(current, message.surface.kind, "reminder"),
            recovery.pid,
            adapterDestinationForInbound(adapter, accountId, message),
            ctx,
          ),
          replyToId: message.messageId,
        },
      };
    }
    return adapterHilDecisionAcknowledgement(message, recovery, ctx, adapter, accountId);
  }

  const nextPendingHil = normalizeAdapterHilRequest(data?.pendingHil);
  if (nextPendingHil) {
    return {
      ok: true,
      reply: {
        text: prefixAdapterDmProcessReply(
          renderAdapterHilPrompt(nextPendingHil, message.surface.kind, "reminder"),
          recovery.pid,
          adapterDestinationForInbound(adapter, accountId, message),
          ctx,
        ),
        replyToId: message.messageId,
      },
    };
  }
  return adapterHilDecisionAcknowledgement(message, recovery, ctx, adapter, accountId);
}

function adapterHilDecisionAcknowledgement(
  message: AdapterInboundMessage,
  recovery: AdapterIngressHilRecovery,
  ctx: KernelContext,
  adapter: string,
  accountId: string,
): AdapterInboundDisposition {
  return {
    ok: true,
    reply: {
      text: prefixAdapterDmProcessReply(
        recovery.decision === "approve"
          ? recovery.remember
            ? "Approved. I will remember this for this conversation."
            : "Approved. Continuing."
          : "Denied. Continuing.",
        recovery.pid,
        adapterDestinationForInbound(adapter, accountId, message),
        ctx,
      ),
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
    const runId = await stableOpaqueId(
      "adapter-run",
      [input.checkpoint.receiptId],
    );
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
  });
  // Adapter ingress is itself an RPC from the adapter. Calling activity back
  // into a stateful adapter here would re-enter its Durable Object before this
  // request can return. Process lifecycle signals own typing activity.
  const response: ProcessAdapterDeliverResponseFrame | null = await sendFrameToProcess(pid, {
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

  if (!response || response.type !== "res") {
    throw new Error("No response from process");
  }
  if (!response.ok) {
    throw new Error(response.error.message);
  }

  const data = (response as ProcessAdapterDeliverResponseFrame & { ok: true }).data;
  if (!data.ok) {
    ctx.runRoutes.delete(runId);
    await rollbackAdapterMedia(pid, media);
    return { ok: false, error: data.error };
  }
  const queued = data.queued === true;
  if (data.runId !== runId) {
    ctx.runRoutes.delete(runId);
    await rollbackAdapterMedia(pid, media);
    return { ok: false, error: "proc.adapter.deliver admitted an unexpected run" };
  }
  if (data.replayed === "recorded") {
    ctx.runRoutes.delete(runId);
    await rollbackAdapterMedia(pid, media);
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
  } else if (recovery.kind === "work_return") {
    const route = recovery.route && typeof recovery.route === "object"
      ? recovery.route as Partial<AdapterIngressWorkReturnRecovery["route"]>
      : null;
    if (
      Number.isSafeInteger(recovery.uid)
      && typeof recovery.workPid === "string"
      && route
      && typeof route.adapter === "string"
      && typeof route.accountId === "string"
      && typeof route.actorId === "string"
      && route.surfaceKind === "dm"
      && typeof route.surfaceId === "string"
      && (route.threadId === undefined || typeof route.threadId === "string")
      && (route.mode === "legacy" || route.mode === "work" || route.mode === "surface")
    ) {
      return recovery as AdapterIngressWorkReturnRecovery;
    }
  }
  throw new Error("Invalid adapter ingress recovery checkpoint");
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
    const result: unknown = await service.adapterSetActivity(accountId, surface, activity);
    if (!isAdapterWorkerActivityResult(result)) {
      logAdapterBoundaryFailure("warn", "activity_invalid_response");
      return;
    }
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
  if (typeof service.adapterStatus !== "function") {
    return null;
  }

  try {
    const statuses: unknown = await service.adapterStatus(accountId);
    if (!isAdapterWorkerStatusResult(statuses)) {
      logAdapterBoundaryFailure("error", "status_invalid_response");
      return null;
    }
    const accountStatuses = statuses.filter((status) => status.accountId === accountId);
    for (const status of accountStatuses) {
      ctx.adapters.status.upsert(adapter, status.accountId, status);
    }
    return accountStatuses[0] ?? null;
  } catch {
    logAdapterBoundaryFailure("error", "status_refresh_failed");
    return null;
  }
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

  const text = message.text.trim();
  if (!text.startsWith("/")) {
    return { handled: false };
  }

  const [rawCommand] = text.split(/\s+/);
  const command = rawCommand.toLowerCase();
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

  if (command === "/help") {
    return replyToAdapterCommand(message, renderAdapterCommandHelp());
  }

  if (command === "/where") {
    const selection = await resolvePrivateDmSelection(routeKey, uid, ctx);
    return replyToAdapterCommand(
      message,
      selection.route
        ? `[INTERNAL WORK / WORK SESSION] ${describeProcessRoute(selection.process)} [${selection.process.state}]. Use /home to return.`
        : `[PERSONAL HOME] ${describeProcessRoute(selection.process)} [${selection.process.state}].`,
    );
  }

  if (command === "/home") {
    const selectedRoute = ctx.adapters.surfaceRoutes.resolveRoute(routeKey);
    if (!selectedRoute) {
      const personalPid = await ensurePersonalController(uid, ctx);
      const personal = ctx.procs.get(personalPid);
      return replyToAdapterCommand(
        message,
        `[PERSONAL HOME] Already using ${personal ? describeProcessRoute(personal) : shortProcessId(personalPid)}.`,
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
        ...(selectedRoute.threadId ? { threadId: selectedRoute.threadId } : {}),
        mode: selectedRoute.mode,
      },
    };
    ctx.adapters.ingressReceipts.checkpoint(receiptId, claimToken, recovery);
    const personalPid = await deliverAdapterWorkReturnedEvent(
      recovery,
      receiptId,
      ctx,
    );
    const personal = ctx.procs.get(personalPid);
    return replyToAdapterCommand(
      message,
      `[PERSONAL HOME] Returned to ${personal ? describeProcessRoute(personal) : shortProcessId(personalPid)}.`,
    );
  }

  return replyToAdapterCommand(message, `Unknown command: ${rawCommand}\n\n${renderAdapterCommandHelp()}`);
}

async function deliverAdapterWorkReturnedEvent(
  recovery: AdapterIngressWorkReturnRecovery,
  receiptId: string,
  ctx: KernelContext,
): Promise<string> {
  ctx.adapters.surfaceRoutes.clearRouteIfMatches({
    ...recovery.route,
    pid: recovery.workPid,
  });
  const personalPid = await ensurePersonalController(recovery.uid, ctx);
  const eventId = `adapter-home:${receiptId}`;
  const request: ProcessRuntimeEventDeliverRequestFrame = {
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
  const response = await sendFrameToProcess(personalPid, request) as (
    ProcessRuntimeEventDeliverResponseFrame | null
  );
  if (
    !response
    || response.type !== "res"
    || response.id !== request.id
    || !response.ok
    || response.data.runId !== eventId
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

function renderAdapterCommandHelp(): string {
  return [
    "Adapter commands:",
    "/where - show PERSONAL HOME or the selected WORK SESSION",
    "/home - leave the work session and return to personal home",
    "",
    "When approval is pending, reply approve, deny, or approve always.",
  ].join("\n");
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
  const inspection = await inspectPendingHil(process.processId);
  if (!inspection.ok) {
    return true;
  }
  const current = ctx.procs.get(process.processId);
  return current !== null
    && (processHasUnfinishedWork(current) || inspection.pending !== null);
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

  await sendFrameToProcess(pid, {
    type: "req",
    id: crypto.randomUUID(),
    call: "proc.setidentity",
    args: {
      pid,
      identity: agent.identity,
      interactive: true,
      autoTitle: true,
    },
  } as RequestFrame);

  return pid;
}

function describeProcessRoute(record: NonNullable<ReturnType<KernelContext["procs"]["get"]>>): string {
  return `${shortProcessId(record.processId)} ${record.label || record.username}`;
}

export function prefixAdapterDmProcessReply(
  text: string,
  processId: string,
  destination: AdapterMessageDestination,
  ctx: KernelContext,
): string {
  if (destination.surface.kind !== "dm") {
    return text;
  }
  const process = ctx.procs.get(processId);
  if (process?.isPersonalController === false) {
    return text ? `[WORK SESSION] ${text}` : "[WORK SESSION]";
  }
  if (process?.isPersonalController === true) {
    const currentRoute = ctx.adapters.surfaceRoutes.resolveRoute({
      adapter: destination.adapter,
      accountId: destination.accountId,
      actorId: destination.actorId,
      surfaceKind: destination.surface.kind,
      surfaceId: destination.surface.id,
      threadId: destination.surface.threadId,
      uid: process.ownerUid,
    });
    if (currentRoute?.mode === "work") {
      return text ? `[PERSONAL INTELLIGENCE] ${text}` : "[PERSONAL INTELLIGENCE]";
    }
  }
  return text;
}

function adapterDestinationForInbound(
  adapter: string,
  accountId: string,
  message: AdapterInboundMessage,
): AdapterMessageDestination {
  return {
    kind: "adapter",
    adapter,
    accountId,
    actorId: resolveActorId(message) ?? message.surface.id,
    surface: message.surface,
  };
}

function adapterPrivateActivityAt(timestamp: number | undefined): number {
  const now = Date.now();
  return typeof timestamp === "number" && Number.isSafeInteger(timestamp) && timestamp > 0
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
  const inspection = await inspectPendingHil(pid);
  return inspection.ok ? inspection.pending : null;
}

async function inspectPendingHil(
  pid: string,
): Promise<{ ok: true; pending: AdapterHilRequest | null } | { ok: false }> {
  const response = await sendFrameToProcess(pid, {
    type: "req",
    id: crypto.randomUUID(),
    call: "proc.history",
    args: { pid, limit: 1, offset: 0 },
  } as RequestFrame);

  if (!response || response.type !== "res" || !response.ok) {
    return { ok: false };
  }

  const data = (response as { data?: { ok?: boolean; pendingHil?: unknown } }).data;
  if (data?.ok === false) {
    return { ok: false };
  }
  return { ok: true, pending: normalizeAdapterHilRequest(data?.pendingHil) };
}

async function findPendingHilDecisionTarget(
  ownerUid: number,
  requestToken: string,
  ctx: KernelContext,
): Promise<
  | { kind: "found"; pid: string; pending: AdapterHilRequest }
  | { kind: "missing" }
  | { kind: "ambiguous" }
> {
  const candidates = ctx.procs.list(ownerUid).filter((process) => (
    process.interactive && process.state === "waiting_hil"
  ));
  const inspected = await Promise.all(candidates.map(async (process) => ({
    process,
    inspection: await inspectPendingHil(process.processId),
  })));
  const matches = inspected.filter(({ inspection }) => (
    inspection.ok
    && inspection.pending !== null
    && adapterHilRequestToken(inspection.pending.requestId) === requestToken
  ));
  if (matches.length === 0) {
    return { kind: "missing" };
  }
  if (matches.length > 1) {
    return { kind: "ambiguous" };
  }
  const match = matches[0];
  if (!match.inspection.ok || !match.inspection.pending) {
    return { kind: "missing" };
  }
  return {
    kind: "found",
    pid: match.process.processId,
    pending: match.inspection.pending,
  };
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
