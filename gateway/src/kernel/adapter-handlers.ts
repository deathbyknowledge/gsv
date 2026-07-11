import type {
  AdapterActivity,
  AdapterInboundMessage,
  AdapterAccountStatus,
  AdapterOutboundMessage,
  AdapterSurface,
  AdapterWorkerInterface,
} from "../adapter-interface";
import type { ShellExecArgs, ShellExecResult } from "../syscalls/shell";
import type {
  AdapterConnectArgs,
  AdapterConnectResult as AdapterConnectSyscallResult,
  AdapterDisconnectArgs,
  AdapterDisconnectResult as AdapterDisconnectSyscallResult,
  AdapterInboundArgs,
  AdapterInboundSyscallResult,
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
  ProcessIdentity,
} from "@humansandmachines/gsv/protocol";
import { resolveCallerOwnerUid, type KernelContext } from "./context";
import type { RequestFrame } from "../protocol/frames";
import { sendFrameToProcess } from "../shared/utils";
import { isVisibleAdapterTarget } from "./adapter-targets";
import { ensureDefaultConversationExecutor } from "./agents";
import { canOwnerRunAsAccount } from "./account-access";
import { isLocked } from "../auth/shadow";
import type { AdapterStatusRecord } from "./adapter-status";
import type { IdentityLinkRecord } from "./identity-links";

type AdapterServiceBinding = Fetcher & Partial<AdapterWorkerInterface>;
type ProcSendData = {
  runId?: string;
  queued?: boolean;
};
type AdapterCommandResult = {
  handled: boolean;
  reply?: {
    text: string;
    replyToId?: string;
  };
};
type HilDecision = {
  decision: "approve" | "deny";
  remember: boolean;
};
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
): Promise<AdapterSendResult> {
  const adapter = args.adapter.trim().toLowerCase();
  const accountId = args.accountId.trim();

  if (!adapter) return { ok: false, error: "adapter is required" };
  if (!accountId) return { ok: false, error: "accountId is required" };
  if (!args.surface?.id?.trim()) return { ok: false, error: "surface.id is required" };
  if (!canSendToAdapterSurface(ctx, adapter, accountId, args.surface)) {
    return { ok: false, error: "Permission denied" };
  }

  const service = resolveAdapterService(ctx.env, adapter);
  if (!service || typeof service.adapterSend !== "function") {
    return { ok: false, error: `Adapter service unavailable: ${adapter}` };
  }

  const outbound: AdapterOutboundMessage = {
    surface: args.surface,
    text: args.text,
    media: args.media,
    replyToId: args.replyToId,
  };

  const result = await service.adapterSend(accountId, outbound);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  return {
    ok: true,
    adapter,
    accountId,
    surfaceId: args.surface.id,
    messageId: result.messageId,
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
    || callerOwnsAdapterSurfaceRoute(ctx, adapter, accountId, surface, ownerUid);
}

function linkAllowsAdapterSurface(link: IdentityLinkRecord, surface: AdapterSurface): boolean {
  const surfaceKind = surface.kind;
  const surfaceId = surface.id.trim();
  const linkedSurfaceKind = metadataString(link.metadata, "surfaceKind");
  const linkedSurfaceId = metadataString(link.metadata, "surfaceId");
  if (linkedSurfaceKind && linkedSurfaceId) {
    return linkedSurfaceKind === surfaceKind && linkedSurfaceId === surfaceId;
  }
  return surfaceKind === "dm" && link.actorId.trim() === surfaceId;
}

function callerOwnsAdapterSurfaceRoute(
  ctx: KernelContext,
  adapter: string,
  accountId: string,
  surface: AdapterSurface,
  ownerUid: number,
): boolean {
  const route = ctx.adapters.surfaceRoutes.get(adapter, accountId, surface.kind, surface.id.trim());
  return route?.uid === ownerUid;
}

function metadataString(metadata: Record<string, unknown> | null | undefined, key: string): string {
  const value = metadata?.[key];
  return typeof value === "string" ? value.trim() : "";
}

export async function handleAdapterShellExec(
  adapter: string,
  accountId: string,
  args: unknown,
  ctx: KernelContext,
): Promise<ShellExecResult> {
  const normalizedAdapter = adapter.trim().toLowerCase();
  const normalizedAccountId = accountId.trim();
  if (!normalizedAdapter) {
    return failedShellResult("adapter is required");
  }
  if (!normalizedAccountId) {
    return failedShellResult("accountId is required");
  }
  if (!isVisibleAdapterTarget(ctx, normalizedAdapter, normalizedAccountId)) {
    throw new Error(`Access denied to adapter target: ${normalizedAdapter}`);
  }

  const service = resolveAdapterService(ctx.env, normalizedAdapter);
  if (!service || typeof service.adapterShellExec !== "function") {
    return failedShellResult(`Adapter does not expose shell commands: ${normalizedAdapter}`);
  }

  const execArgs = normalizeAdapterShellArgs(args);
  if (!execArgs.input.trim()) {
    return completedShellResult("");
  }

  return service.adapterShellExec(normalizedAccountId, execArgs);
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
): Promise<AdapterInboundSyscallResult> {
  const identity = ctx.identity;
  if (!identity || identity.role !== "service") {
    throw new Error("adapter.inbound requires a service identity");
  }

  const adapter = args.adapter.trim().toLowerCase();
  const accountId = args.accountId.trim();
  const message = args.message;

  if (!adapter) return { ok: false, error: "adapter is required" };
  if (!accountId) return { ok: false, error: "accountId is required" };
  if (!message?.surface?.id?.trim()) return { ok: false, error: "message.surface.id is required" };

  const actorId = resolveActorId(message);
  if (!actorId) {
    return { ok: false, error: "message.actor.id is required" };
  }

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

  const userIdentity = identityForUid(uid, ctx);
  if (!userIdentity) {
    return { ok: false, error: `Unknown local user uid=${uid}` };
  }

  const command = await handleAdapterCommand({
    adapter,
    accountId,
    message,
    uid,
    ctx,
  });
  if (command.handled) {
    return {
      ok: true,
      ...(command.reply ? { reply: command.reply } : {}),
    };
  }

  const pid = await resolveAdapterRoute(adapter, accountId, message.surface, uid, userIdentity, ctx);

  const pendingHil = await getPendingHil(pid);
  if (pendingHil) {
    const decision = message.surface.kind === "dm"
      ? parseHilDecision(message.text)
      : null;

    if (!decision) {
      return {
        ok: true,
        reply: {
          text: renderAdapterHilPrompt(pendingHil, message.surface.kind, "reminder"),
          replyToId: message.messageId,
        },
      };
    }

    const hilResponse = await sendFrameToProcess(pid, {
      type: "req",
      id: crypto.randomUUID(),
      call: "proc.hil",
      args: {
        pid,
        requestId: pendingHil.requestId,
        decision: decision.decision,
        ...(decision.remember ? { remember: true } : {}),
      },
    } as RequestFrame);

    if (!hilResponse || hilResponse.type !== "res") {
      return { ok: false, error: "No response from process" };
    }
    if (!hilResponse.ok) {
      return { ok: false, error: hilResponse.error.message };
    }

    const hilData = (hilResponse as { data?: { resumed?: boolean; pendingHil?: unknown } }).data;
    const nextPendingHil = normalizeAdapterHilRequest(hilData?.pendingHil);
    if (!nextPendingHil && hilData?.resumed) {
      await setAdapterActivityForKernel(
        ctx.env,
        adapter,
        accountId,
        message.surface,
        { kind: "typing", active: true },
      );
    }

    return {
      ok: true,
      ...(nextPendingHil
        ? {
            reply: {
              text: renderAdapterHilPrompt(nextPendingHil, message.surface.kind, "reminder"),
              replyToId: message.messageId,
            },
          }
        : {
            reply: {
              text: decision.decision === "approve"
                ? decision.remember
                  ? "Approved. I will remember this for this conversation."
                  : "Approved. Continuing."
                : "Denied. Continuing.",
              replyToId: message.messageId,
            },
          }),
    };
  }

  const origin = adapterInteractionOrigin(adapter, accountId, message, actorId);
  const response = await sendFrameToProcess(pid, {
    type: "req",
    id: crypto.randomUUID(),
    call: "proc.send",
    args: {
      pid,
      message: message.text?.trim() || "",
      media: message.media,
      origin,
    },
  } as RequestFrame);

  if (!response || response.type !== "res") {
    return { ok: false, error: "No response from process" };
  }
  if (!response.ok) {
    return { ok: false, error: response.error.message };
  }

  const data = (response as { data?: ProcSendData }).data;
  const runId = typeof data?.runId === "string" ? data.runId : null;
  const queued = data?.queued === true;

  if (!runId) {
    return { ok: false, error: "proc.send did not return runId" };
  }

  ctx.runRoutes.setAdapterRoute(
    runId,
    uid,
    adapter,
    accountId,
    message.surface.kind,
    message.surface.id,
    message.surface.threadId,
  );

  await setAdapterActivityForKernel(
    ctx.env,
    adapter,
    accountId,
    message.surface,
    { kind: "typing", active: true },
  );

  return {
    ok: true,
    delivered: {
      uid,
      pid,
      runId,
      queued,
    },
  };
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
    supportsShellExec: typeof service?.adapterShellExec === "function",
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

function normalizeAdapterShellArgs(args: unknown): ShellExecArgs {
  const raw = args && typeof args === "object" ? args as Record<string, unknown> : {};
  return {
    input: typeof raw.input === "string" ? raw.input : "",
    ...(typeof raw.cwd === "string" ? { cwd: raw.cwd } : {}),
    ...(typeof raw.sessionId === "string" ? { sessionId: raw.sessionId } : {}),
    ...(typeof raw.timeout === "number" ? { timeout: raw.timeout } : {}),
    ...(typeof raw.background === "boolean" ? { background: raw.background } : {}),
    ...(typeof raw.yieldMs === "number" ? { yieldMs: raw.yieldMs } : {}),
  };
}

function completedShellResult(output: string): ShellExecResult {
  return {
    status: "completed",
    output,
    exitCode: 0,
    ok: true,
    pid: 0,
    stdout: output,
    stderr: "",
  };
}

function failedShellResult(error: string): ShellExecResult {
  return {
    status: "failed",
    output: error,
    error,
    exitCode: 1,
    ok: false,
    pid: 0,
    stdout: "",
    stderr: error,
  };
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
  surface: AdapterSurface,
  uid: number,
  userIdentity: ProcessIdentity,
  ctx: KernelContext,
): Promise<string> {
  const routedPid = ctx.adapters.surfaceRoutes.resolvePid(
    adapter,
    accountId,
    surface.kind,
    surface.id,
    uid,
  );
  if (routedPid) {
    const routedProcess = ctx.procs.get(routedPid);
    if (routedProcess && routedProcess.ownerUid === uid && routedProcess.interactive) {
      return routedPid;
    }
    ctx.adapters.surfaceRoutes.clearRoute(adapter, accountId, surface.kind, surface.id);
  }

  return ensureDefaultConversationExecutor(ctx, userIdentity);
}

async function handleAdapterCommand(args: {
  adapter: string;
  accountId: string;
  message: AdapterInboundMessage;
  uid: number;
  ctx: KernelContext;
}): Promise<AdapterCommandResult> {
  const { adapter, accountId, message, uid, ctx } = args;
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

  if (command === "/help") {
    return replyToAdapterCommand(message, renderAdapterCommandHelp());
  }

  if (command === "/where") {
    const routed = resolveExistingAdapterRoute(adapter, accountId, message.surface, uid, ctx);
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
      const cleared = ctx.adapters.surfaceRoutes.clearRoute(adapter, accountId, message.surface.kind, message.surface.id);
      return replyToAdapterCommand(
        message,
        cleared
          ? "This chat now uses your personal conversation."
          : "This chat is already using your personal conversation.",
      );
    }

    const processMatch = findProcessForSelector(selector, uid, ctx);
    if (processMatch.kind === "ambiguous") {
      return replyToAdapterCommand(message, `More than one process matches "${selector}". Use a longer process id from /list.`);
    }
    if (processMatch.kind === "found") {
      ctx.adapters.surfaceRoutes.setRoute(
        adapter,
        accountId,
        message.surface.kind,
        message.surface.id,
        uid,
        processMatch.record.processId,
        uid,
      );
      return replyToAdapterCommand(message, `This chat now uses ${describeProcessRoute(processMatch.record)}.`);
    }

    const agent = findRunnableAgent(selector, uid, ctx);
    if (!agent) {
      return replyToAdapterCommand(message, `I could not find a process or agent named "${selector}". Use /list to see available targets.`);
    }

    const pid = await spawnAdapterAgentProcess(agent, uid, message.surface, ctx);
    ctx.adapters.surfaceRoutes.setRoute(
      adapter,
      accountId,
      message.surface.kind,
      message.surface.id,
      uid,
      pid,
      uid,
    );
    return replyToAdapterCommand(message, `This chat now uses ${agent.username}.`);
  }

  return replyToAdapterCommand(message, `Unknown command: ${rawCommand}\n\n${renderAdapterCommandHelp()}`);
}

function resolveExistingAdapterRoute(
  adapter: string,
  accountId: string,
  surface: AdapterSurface,
  uid: number,
  ctx: KernelContext,
): NonNullable<ReturnType<KernelContext["procs"]["get"]>> | null {
  const routedPid = ctx.adapters.surfaceRoutes.resolvePid(
    adapter,
    accountId,
    surface.kind,
    surface.id,
    uid,
  );
  if (!routedPid) {
    return null;
  }
  const routedProcess = ctx.procs.get(routedPid);
  if (routedProcess && routedProcess.ownerUid === uid && routedProcess.interactive) {
    return routedProcess;
  }
  ctx.adapters.surfaceRoutes.clearRoute(adapter, accountId, surface.kind, surface.id);
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
  ctx: KernelContext,
): Promise<string> {
  const pid = `proc:${crypto.randomUUID()}`;
  const label = `adapter ${describeAdapterSurface(surface)} (${agent.username})`;
  ctx.procs.spawn(pid, agent.identity, {
    ownerUid,
    interactive: true,
    label,
    cwd: agent.identity.cwd,
  });

  const conversation = ctx.conversations.create({
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

function parseHilDecision(text: string): HilDecision | null {
  const normalized = text.trim().toLowerCase().replace(/[.!?]+$/g, "");
  if (["approve always", "allow always", "yes always", "always approve", "always allow"].includes(normalized)) {
    return { decision: "approve", remember: true };
  }
  if (["approve", "allow", "yes"].includes(normalized)) {
    return { decision: "approve", remember: false };
  }
  if (["deny", "reject", "no"].includes(normalized)) {
    return { decision: "deny", remember: false };
  }
  return null;
}

export function renderAdapterHilPrompt(
  pendingHil: AdapterHilRequest,
  surfaceKind: AdapterSurface["kind"],
  phase: "initial" | "reminder",
): string {
  const action = summarizeAdapterHilRequest(pendingHil);
  const responseLine = surfaceKind === "dm"
    ? phase === "initial"
      ? 'Reply "approve" to continue, "approve always" to remember it for this conversation, or "deny" to stop this action.'
      : 'Reply "approve", "deny", or "approve always" to continue.'
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
