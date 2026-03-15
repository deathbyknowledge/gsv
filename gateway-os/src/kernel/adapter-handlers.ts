import type {
  AdapterInboundMessage,
  AdapterAccountStatus,
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
  AdapterStateUpdateArgs,
  AdapterStateUpdateResult,
  AdapterSendArgs,
  AdapterSendResult,
  AdapterStatusArgs,
  AdapterStatusResult,
} from "../syscalls/adapter";
import type { KernelContext } from "./context";
import type { ProcessIdentity } from "../syscalls/system";
import type { RequestFrame } from "../protocol/frames";
import { sendFrameToProcess } from "../shared/utils";

type AdapterServiceBinding = Fetcher & Partial<AdapterWorkerInterface>;
type ProcSendData = {
  ok?: boolean;
  status?: string;
  runId?: string;
  queued?: boolean;
};

function resolveAdapterService(env: Env, adapter: string): AdapterServiceBinding | null {
  const key = `CHANNEL_${adapter.trim().toUpperCase()}`;
  const binding = (env as unknown as Record<string, unknown>)[key];
  if (!binding) return null;
  return binding as AdapterServiceBinding;
}

export async function handleAdapterConnect(
  args: AdapterConnectArgs,
  ctx: KernelContext,
): Promise<AdapterConnectSyscallResult> {
  const adapter = args.adapter.trim();
  const accountId = args.accountId.trim();

  if (!adapter) return { ok: false, error: "adapter is required" };
  if (!accountId) return { ok: false, error: "accountId is required" };

  const service = resolveAdapterService(ctx.env, adapter);
  if (!service) {
    return { ok: false, error: `Adapter service unavailable: ${adapter}` };
  }
  if (typeof service.connect !== "function") {
    return { ok: false, error: `Adapter service does not implement connect: ${adapter}` };
  }

  const connectResult = await service.connect(accountId, args.config);
  if (!connectResult.ok) {
    return {
      ok: false,
      error: connectResult.error,
      challenge: connectResult.challenge,
    };
  }

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
}

export async function handleAdapterDisconnect(
  args: AdapterDisconnectArgs,
  ctx: KernelContext,
): Promise<AdapterDisconnectSyscallResult> {
  const adapter = args.adapter.trim();
  const accountId = args.accountId.trim();

  if (!adapter) return { ok: false, error: "adapter is required" };
  if (!accountId) return { ok: false, error: "accountId is required" };

  const service = resolveAdapterService(ctx.env, adapter);
  if (!service) {
    return { ok: false, error: `Adapter service unavailable: ${adapter}` };
  }
  if (typeof service.disconnect !== "function") {
    return { ok: false, error: `Adapter service does not implement disconnect: ${adapter}` };
  }

  const result = await service.disconnect(accountId);
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
}

export async function handleAdapterSend(
  args: AdapterSendArgs,
  ctx: KernelContext,
): Promise<AdapterSendResult> {
  const adapter = args.adapter.trim();
  const accountId = args.accountId.trim();

  if (!adapter) return { ok: false, error: "adapter is required" };
  if (!accountId) return { ok: false, error: "accountId is required" };
  if (!args.surface?.id?.trim()) return { ok: false, error: "surface.id is required" };

  const service = resolveAdapterService(ctx.env, adapter);
  if (!service || typeof service.send !== "function") {
    return { ok: false, error: `Adapter service unavailable: ${adapter}` };
  }

  const outbound: AdapterOutboundMessage = {
    surface: args.surface,
    text: args.text,
    media: args.media,
    replyToId: args.replyToId,
  };

  const result = await service.send(accountId, outbound);
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

export async function handleAdapterStatus(
  args: AdapterStatusArgs,
  ctx: KernelContext,
): Promise<AdapterStatusResult> {
  const adapter = args.adapter.trim();
  if (!adapter) throw new Error("adapter is required");

  const service = resolveAdapterService(ctx.env, adapter);
  if (service && typeof service.status === "function") {
    try {
      const statuses = await service.status(args.accountId);
      for (const status of statuses) {
        ctx.adapters.status.upsert(adapter, status.accountId, status);
      }
    } catch {
      // status syscall should still return last known state when live check fails
    }
  }

  const accounts = ctx.adapters.status
    .list(adapter, args.accountId)
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
        prompt: `Link your account by running: gsv auth link ${challenge.code}`,
        expiresAt: challenge.expiresAt,
      },
    };
  }

  const userIdentity = identityForUid(uid, ctx);
  if (!userIdentity) {
    return { ok: false, error: `Unknown local user uid=${uid}` };
  }

  const initPid = await ensureUserInitProcess(userIdentity, ctx);
  let pid =
    ctx.adapters.surfaceRoutes.resolvePid(
      adapter,
      accountId,
      message.surface.kind,
      message.surface.id,
      uid,
    ) ?? initPid;

  const target = ctx.procs.get(pid);
  if (!target || target.uid !== uid) {
    pid = initPid;
  }

  const incomingText = renderAdapterInboundText(adapter, message, actorId);
  const response = await sendFrameToProcess(pid, {
    type: "req",
    id: crypto.randomUUID(),
    call: "proc.send",
    args: { pid, message: incomingText },
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

  ctx.adapters.status.upsert(adapter, accountId, {
    ...args.status,
    accountId,
  });

  return { ok: true };
}

export function resolveAdapterServiceForKernel(env: Env, adapter: string): AdapterServiceBinding | null {
  return resolveAdapterService(env, adapter);
}

async function refreshAdapterStatus(
  service: AdapterServiceBinding,
  ctx: KernelContext,
  adapter: string,
  accountId: string,
): Promise<AdapterAccountStatus | null> {
  if (typeof service.status !== "function") {
    return null;
  }

  try {
    const statuses = await service.status(accountId);
    for (const status of statuses) {
      ctx.adapters.status.upsert(adapter, status.accountId, status);
    }
    const exact = statuses.find((status) => status.accountId === accountId);
    return exact || null;
  } catch {
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
  };
}

async function ensureUserInitProcess(identity: ProcessIdentity, ctx: KernelContext): Promise<string> {
  const { pid, created } = ctx.procs.ensureInit(identity);

  if (created) {
    await sendFrameToProcess(pid, {
      type: "req",
      id: crypto.randomUUID(),
      call: "proc.setidentity",
      args: { pid, identity },
    } as RequestFrame);
  }

  return pid;
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

function renderAdapterInboundText(
  adapter: string,
  message: AdapterInboundMessage,
  actorId: string,
): string {
  const base = message.text?.trim() || "";
  if (message.surface.kind === "dm") {
    return base;
  }

  const surface = describeSurface(message.surface);
  const actorLabel = message.actor?.handle || message.actor?.name || actorId;
  return [`[${adapter} ${surface} ${actorLabel}]`, base]
    .filter(Boolean)
    .join("\n");
}

function describeSurface(surface: AdapterSurface): string {
  if (surface.kind === "thread" && surface.threadId) {
    return `${surface.kind}:${surface.id}:${surface.threadId}`;
  }
  return `${surface.kind}:${surface.id}`;
}
