import type {
  AdapterActivity,
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
import type { ProcessIdentity } from "@gsv/protocol/syscalls/system";
import type { RequestFrame } from "../protocol/frames";
import { sendFrameToProcess } from "../shared/utils";

type AdapterServiceBinding = Fetcher & Partial<AdapterWorkerInterface>;
type ProcSendData = {
  ok?: boolean;
  status?: string;
  runId?: string;
  queued?: boolean;
};

function traceIdFromConfig(config: Record<string, unknown> | undefined): string {
  const value = config?.__traceId;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : "no-trace";
}

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
  const traceId = traceIdFromConfig(args.config);

  if (!adapter) return { ok: false, error: "adapter is required" };
  if (!accountId) return { ok: false, error: "accountId is required" };
  console.log(`[adapter.connect:${traceId}] start adapter=${adapter} accountId=${accountId}`);

  const service = resolveAdapterService(ctx.env, adapter);
  if (!service) {
    console.error(`[adapter.connect:${traceId}] missing service binding adapter=${adapter}`);
    return { ok: false, error: `Adapter service unavailable: ${adapter}` };
  }
  if (typeof service.adapterConnect !== "function") {
    console.error(`[adapter.connect:${traceId}] service missing adapterConnect() adapter=${adapter}`);
    return { ok: false, error: `Adapter service does not implement connect: ${adapter}` };
  }

  let connectResult;
  try {
    connectResult = await service.adapterConnect(accountId, args.config);
  } catch (error) {
    console.error(
      `[adapter.connect:${traceId}] service.adapterConnect threw adapter=${adapter} accountId=${accountId}`,
      error,
    );
    throw error;
  }
  console.log(
    `[adapter.connect:${traceId}] service.adapterConnect ok=${connectResult.ok === true} challenge=${Boolean(connectResult.challenge)}`,
  );
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
  console.log(
    `[adapter.connect:${traceId}] complete adapter=${adapter} accountId=${accountId} connected=${connected} authenticated=${authenticated}`,
  );

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
  if (typeof service.adapterDisconnect !== "function") {
    return { ok: false, error: `Adapter service does not implement disconnect: ${adapter}` };
  }

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

export async function handleAdapterStatus(
  args: AdapterStatusArgs,
  ctx: KernelContext,
): Promise<AdapterStatusResult> {
  const adapter = args.adapter.trim();
  if (!adapter) throw new Error("adapter is required");

  const service = resolveAdapterService(ctx.env, adapter);
  if (service && typeof service.adapterStatus === "function") {
    try {
      const statuses = await service.adapterStatus(args.accountId);
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

  const pendingHil = await getPendingHil(pid);
  if (pendingHil) {
    const decision = message.surface.kind === "dm"
      ? parseHilDecision(message.text)
      : null;

    if (!decision) {
      return {
        ok: true,
        reply: {
          text: renderAdapterHilReminder(pendingHil, message.surface.kind),
          replyToId: message.messageId,
        },
      };
    }

    const hilResponse = await sendFrameToProcess(pid, {
      type: "req",
      id: crypto.randomUUID(),
      call: "proc.hil",
      args: { pid, requestId: pendingHil.requestId, decision },
    } as RequestFrame);

    if (!hilResponse || hilResponse.type !== "res") {
      return { ok: false, error: "No response from process" };
    }
    if (!hilResponse.ok) {
      return { ok: false, error: hilResponse.error.message };
    }

    const hilData = (hilResponse as { data?: { resumed?: boolean; pendingHil?: unknown } }).data;
    const nextPendingHil = normalizePendingHil(hilData?.pendingHil);
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
              text: renderAdapterHilReminder(nextPendingHil, message.surface.kind),
              replyToId: message.messageId,
            },
          }
        : {
            reply: {
              text: decision === "approve" ? "Approved. Continuing." : "Denied. Continuing.",
              replyToId: message.messageId,
            },
          }),
    };
  }

  const incomingText = renderAdapterInboundText(adapter, message, actorId);
  const response = await sendFrameToProcess(pid, {
    type: "req",
    id: crypto.randomUUID(),
    call: "proc.send",
    args: { pid, message: incomingText, media: message.media },
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

  ctx.adapters.status.upsert(adapter, accountId, {
    ...args.status,
    accountId,
  });

  return { ok: true };
}

export function resolveAdapterServiceForKernel(env: Env, adapter: string): AdapterServiceBinding | null {
  return resolveAdapterService(env, adapter);
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
    console.log(`[adapter.status] refreshing adapter=${adapter} accountId=${accountId}`);
    const statuses = await service.adapterStatus(accountId);
    for (const status of statuses) {
      ctx.adapters.status.upsert(adapter, status.accountId, status);
    }
    const exact = statuses.find((status) => status.accountId === accountId);
    if (exact) {
      console.log(
        `[adapter.status] refreshed adapter=${adapter} accountId=${accountId} connected=${exact.connected} authenticated=${exact.authenticated}`,
      );
    }
    return exact || null;
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
    workspaceId: null,
  };
}

async function ensureUserInitProcess(identity: ProcessIdentity, ctx: KernelContext): Promise<string> {
  const { pid, created } = ctx.procs.ensureInit(identity);

  if (created) {
    await sendFrameToProcess(pid, {
      type: "req",
      id: crypto.randomUUID(),
      call: "proc.setidentity",
      args: { pid, identity, profile: "init" },
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

type PendingHilSummary = {
  requestId: string;
  toolName: string;
  syscall: string;
  args: Record<string, unknown>;
};

async function getPendingHil(pid: string): Promise<PendingHilSummary | null> {
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
  return normalizePendingHil(data?.pendingHil);
}

function normalizePendingHil(value: unknown): PendingHilSummary | null {
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

function parseHilDecision(text: string): "approve" | "deny" | null {
  const normalized = text.trim().toLowerCase().replace(/[.!?]+$/g, "");
  if (["approve", "allow", "yes"].includes(normalized)) {
    return "approve";
  }
  if (["deny", "reject", "no"].includes(normalized)) {
    return "deny";
  }
  return null;
}

function renderAdapterHilReminder(
  pendingHil: PendingHilSummary,
  surfaceKind: AdapterSurface["kind"],
): string {
  const action = summarizePendingHil(pendingHil);
  const responseLine = surfaceKind === "dm"
    ? 'Reply "approve" or "deny" to continue.'
    : "Open Chat to approve or deny this action.";
  return [
    "I’m waiting for confirmation before I can continue.",
    "",
    action,
    "",
    responseLine,
  ].join("\n");
}

function summarizePendingHil(pendingHil: PendingHilSummary): string {
  const path = typeof pendingHil.args.path === "string" ? pendingHil.args.path : "";
  const command = typeof pendingHil.args.command === "string" ? pendingHil.args.command : "";

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
