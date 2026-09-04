import type {
  AdapterInboundMessage,
  AdapterSurface,
} from "../adapter-interface";
import type {
  InternalRequestFrame,
  InternalResponseFrame,
} from "../protocol/process-frames";
import type {
  AdapterMessageDestination,
  InteractionOrigin,
  ProcessIdentity,
} from "@humansandmachines/gsv/protocol";
import {
  type KernelContext,
} from "./context";
import {
  sendFrameToProcess,
} from "../shared/utils";
import {
  ensurePersonalAgent,
} from "./agents";
import {
  ensurePersonalController,
} from "./personal-controller";
import type {
  ProcessRecord,
} from "./processes";
import type {
  SurfaceRouteRecord,
} from "./surface-routes";
import type {
  AdapterIngressWorkReturnRecovery,
} from "./adapter-service";

/** Adapter route resolution, private DM selection, and process spawning for adapter traffic. */
export function identityForUid(uid: number, ctx: KernelContext): ProcessIdentity | null {
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

export async function resolveAdapterRoute(
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

export async function deliverAdapterWorkReturnedEvent(
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

export async function resolvePrivateDmSelection(
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

export function describeProcessRoute(record: NonNullable<ReturnType<KernelContext["procs"]["get"]>>): string {
  return `${shortProcessId(record.processId)} ${record.label || record.username}`;
}

export function adapterPrivateActivityAt(timestamp: number | undefined): number {
  const now = Date.now();
  return timestamp !== undefined && Number.isSafeInteger(timestamp) && timestamp > 0
    ? Math.min(timestamp, now)
    : now;
}

export function shortProcessId(pid: string): string {
  if (pid.startsWith("proc:")) {
    return pid.slice(0, 13);
  }
  return pid.length > 13 ? pid.slice(0, 13) : pid;
}

export function resolveActorId(message: AdapterInboundMessage): string | null {
  const actor = message.actor?.id?.trim();
  if (actor) return actor;

  if (message.surface.kind === "dm") {
    const fallback = message.surface.id.trim();
    return fallback || null;
  }

  return null;
}

export function adapterInteractionOrigin(
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

