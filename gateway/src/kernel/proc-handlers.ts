/**
 * Kernel-side proc.* syscall handlers.
 *
 * proc.list — answered entirely by the kernel ProcessRegistry.
 * proc.spawn — registers in ProcessRegistry, DO is lazily instantiated.
 * proc.send/kill/history/reset — forwarded to the Process DO via recvFrame.
 */

import type { RequestFrame, ResponseFrame } from "../protocol/frames";
import type { KernelContext } from "./context";
import { resolveCallerOwnerUid } from "./context";
import type {
  ProcListArgs,
  ProcListResult,
  ProcListEntry,
  ProcIpcCallArgs,
  ProcIpcCallResult,
  ProcIpcSendArgs,
  ProcIpcSendResult,
  ProcSpawnAssignment,
  ProcSpawnMountSpec,
  ProcSpawnArgs,
  ProcSpawnResult,
  ProcSendArgs,
} from "../syscalls/proc";
import type { InteractionOrigin } from "../syscalls/interaction-origin";
import { sendFrameToProcess } from "../shared/utils";
import type { ProcessIdentity } from "@gsv/protocol/syscalls/system";
import type { ProcessMount } from "./processes";
import {
  normalizePath,
  packageSourcePathNameForRecord,
  resolveUserPath,
} from "../fs";
import { resolveInstalledPackage } from "./pkg";
import {
  type InstalledPackageRecord,
  visiblePackageScopesForActor,
} from "./packages";
import { ensureDefaultConversationExecutor, ensurePersonalAgent } from "./agents";
import { accountIdentity } from "./accounts";
import { canOwnerDelegateRunAs } from "./account-access";
import { resolvePackageAgentRunAs } from "./package-agents";
import { DEFAULT_CONVERSATION_ID } from "../process/conversations";

const DEFAULT_IPC_CALL_TIMEOUT_MS = 60_000;
const MIN_IPC_CALL_TIMEOUT_MS = 1_000;
const MAX_IPC_CALL_TIMEOUT_MS = 10 * 60 * 1000;

export function handleProcList(
  args: ProcListArgs,
  ctx: KernelContext,
): ProcListResult {
  // Visibility is keyed on the owning human (owner_uid), not the run-as
  // account. A personal agent listing its human's processes must resolve to the
  // human owner, otherwise it filters on the agent's uid and sees nothing.
  const callerOwnerUid = resolveCallerOwnerUid(ctx);
  const isRoot = callerOwnerUid === 0;
  const uid = args.uid ?? (isRoot ? undefined : callerOwnerUid);

  const records = ctx.procs.list(uid);

  const processes: ProcListEntry[] = records.map((r) => {
    const conversation = ctx.conversations?.getByActivePid(r.processId);
    return {
      pid: r.processId,
      uid: r.ownerUid,
      username: r.username,
      interactive: r.interactive,
      parentPid: r.parentPid,
      state: r.state,
      activeRunId: r.activeRunId,
      activeConversationId: r.activeConversationId,
      queuedCount: r.queuedCount,
      lastActiveAt: r.lastActiveAt,
      label: r.label,
      createdAt: r.createdAt,
      cwd: r.cwd,
      isDefaultConversation: conversation?.isDefault === true,
    };
  });

  return { processes };
}

export async function handleProcSpawn(
  args: ProcSpawnArgs,
  ctx: KernelContext,
): Promise<ProcSpawnResult> {
  const identity = ctx.identity!;
  const pid = `proc:${crypto.randomUUID()}`;
  const explicitRunAs = typeof args.runAs === "string" && args.runAs.trim().length > 0;
  const hasCustomSpawnOptions =
    args.assignment !== undefined ||
    args.cwd !== undefined ||
    args.mounts !== undefined;

  // An interactive, top-level spawn with no explicit run-as targets the caller's
  // default ("inbox") conversation with their personal agent — the stable
  // surface. Background spawns (interactive === false, e.g. cron) and child
  // spawns from a process get their own fresh executor + conversation.
  const useDefaultExecutor =
    !explicitRunAs &&
    !hasCustomSpawnOptions &&
    args.interactive !== false &&
    !ctx.processId &&
    !args.parentPid;

  if (useDefaultExecutor) {
    const human = resolveCallerOwnerIdentity(ctx, identity.process);
    const pidResolved = await ensureDefaultConversationExecutor(ctx, human);
    const record = ctx.procs.get(pidResolved);
    if (!record) {
      return { ok: false, error: "Failed to resolve personal-agent executor" };
    }

    if (args.prompt) {
      const origin = interactionOriginForContext(ctx);
      await sendFrameToProcess(pidResolved, {
        type: "req",
        id: crypto.randomUUID(),
        call: "proc.send",
        args: {
          pid: pidResolved,
          message: args.prompt,
          ...(origin ? { origin } : {}),
        },
      });
    }

    return {
      ok: true,
      pid: record.processId,
      label: record.label ?? undefined,
      cwd: record.cwd,
    };
  }

  const callerOwnerUid = resolveCallerOwnerUid(ctx);
  const parentPid = args.parentPid ?? ctx.processId;
  const parent = parentPid ? ctx.procs.get(parentPid) : null;
  const parentIsCurrentCaller = !!parentPid && parentPid === ctx.processId;
  const parentRunsAsCaller = !!parent && parent.uid === identity.process.uid;

  if (parentPid) {
    if (!parent || parent.ownerUid !== callerOwnerUid) {
      if (identity.process.uid !== 0) {
        return { ok: false, error: `Cannot spawn under foreign process: ${parentPid}` };
      }
    }
    if (
      parent &&
      args.parentPid &&
      !parentIsCurrentCaller &&
      !parentRunsAsCaller &&
      !explicitRunAs &&
      identity.process.uid !== 0
    ) {
      return { ok: false, error: `Cannot inherit run-as identity from unrelated parent process: ${parentPid}` };
    }
  }

  // The spawning human owns the process. The run-as identity is, in order of
  // precedence: an explicit `runAs` account, the parent's identity (so children
  // of an agent also run as that agent), or — for a parentless spawn — the
  // caller's personal agent (processes run as an agent, not the human).
  const ownerUid = parent ? parent.ownerUid : callerOwnerUid;
  const inheritParentIdentity = parent && (
    parentIsCurrentCaller ||
    parentRunsAsCaller ||
    !args.parentPid ||
    identity.process.uid === 0
  );
  let baseIdentity: ProcessIdentity = inheritParentIdentity
    ? {
        uid: parent.uid,
        gid: parent.gid,
        gids: parent.gids,
        username: parent.username,
        home: parent.home,
        cwd: parent.cwd,
      }
    : identity.process;

  if (explicitRunAs) {
    const resolved = resolveRunAsIdentity(ctx, args.runAs!, ownerUid);
    if (!resolved.ok) {
      return { ok: false, error: resolved.error };
    }
    baseIdentity = resolved.identity;
  } else if (!parent) {
    const agent = await ensurePersonalAgent(ctx, identity.process);
    baseIdentity = agent.identity;
  }

  const hasRequestedMounts = args.mounts !== undefined;
  const materializedMounts = materializeSpawnMounts(args.mounts, ctx, ownerUid);
  if (!materializedMounts.ok) {
    return { ok: false, error: materializedMounts.error };
  }

  const spawnIdentity: ProcessIdentity = {
    ...baseIdentity,
    cwd: resolveSpawnCwd(args.cwd, baseIdentity, hasRequestedMounts ? materializedMounts.mounts : []),
  };

  const interactive = args.interactive ?? true;

  ctx.procs.spawn(pid, spawnIdentity, {
    parentPid: parentPid ?? undefined,
    ownerUid,
    interactive,
    label: args.label,
    cwd: spawnIdentity.cwd,
    mounts: materializedMounts.mounts,
    contextFiles: args.assignment?.contextFiles ?? [],
  });

  // Each spawned process gets its own durable conversation so its transcript
  // persists in the run-as agent's home, addressable independent of this
  // (fungible) executor.
  let conversationId: string | undefined;
  if (ctx.conversations) {
    const conversation = ctx.conversations.create({
      ownerUid,
      agentUid: spawnIdentity.uid,
      agentHome: spawnIdentity.home,
      title: args.label ?? null,
    });
    conversationId = conversation.conversationId;
    ctx.conversations.setActivePid(conversationId, pid);
  }

  await sendFrameToProcess(pid, {
    type: "req",
    id: crypto.randomUUID(),
    call: "proc.setidentity",
    args: {
      pid,
      identity: spawnIdentity,
      interactive,
      assignment: args.assignment as ProcSpawnAssignment | undefined,
      ...(conversationId ? { conversationId } : {}),
    },
  });

  if (args.prompt) {
    const origin = interactionOriginForContext(ctx);
    await sendFrameToProcess(pid, {
      type: "req",
      id: crypto.randomUUID(),
      call: "proc.send",
      args: {
        pid,
        message: args.prompt,
        ...(origin ? { origin } : {}),
      },
    });
  }

  return {
    ok: true,
    pid,
    label: args.label,
    cwd: spawnIdentity.cwd,
  };
}

/**
 * Resolve a `runAs` account selector (username or uid) to its run-as identity,
 * authorizing the owning human. A human may run as an account when it is their
 * own account, their personal agent, an account whose private group they belong
 * to, or when the caller is root.
 */
export function resolveRunAsIdentity(
  ctx: KernelContext,
  runAs: string,
  ownerUid: number,
): { ok: true; identity: ProcessIdentity } | { ok: false; error: string } {
  const auth = ctx.auth;
  const trimmed = runAs.trim();
  const isRoot = ctx.identity!.process.uid === 0;

  if (trimmed.includes("#")) {
    return resolvePackageAgentRunAs(ctx, trimmed, ownerUid, isRoot);
  }

  const entry = /^\d+$/.test(trimmed)
    ? auth.getPasswdByUid(Number(trimmed))
    : auth.getPasswdByUsername(trimmed);
  if (!entry) {
    return { ok: false, error: `Unknown account: ${runAs}` };
  }

  // "Self" is the caller's *actual* run-as identity, not the owning human.
  // Otherwise an agent-backed process could pass runAs=<owner human> and assume
  // the human's identity (and its `users` capabilities), escalating past the
  // agent's least-privilege isolation. The owner's delegated run-as rights
  // (personal agent, group-member agents) are still honored below.
  const isSelf = entry.uid === ctx.identity!.process.uid;
  const canDelegate = canOwnerDelegateRunAs(auth, ownerUid, entry);

  if (!isRoot && !isSelf && !canDelegate) {
    return { ok: false, error: `Permission denied: cannot run as ${entry.username}` };
  }

  return { ok: true, identity: accountIdentity(auth, entry) };
}

function withProcSendOrigin(frame: RequestFrame, ctx: KernelContext): RequestFrame {
  const args = (frame.args ?? {}) as ProcSendArgs & Record<string, unknown>;
  const nextArgs: ProcSendArgs & Record<string, unknown> = { ...args };
  const origin = interactionOriginForContext(ctx);
  if (origin) {
    nextArgs.origin = origin;
  } else {
    delete nextArgs.origin;
  }
  return { ...frame, args: nextArgs } as RequestFrame;
}

function interactionOriginForContext(ctx: KernelContext): InteractionOrigin | undefined {
  if (ctx.appFrame) {
    return {
      kind: "app",
      packageId: ctx.appFrame.packageId,
      packageName: ctx.appFrame.packageName,
      entrypointName: ctx.appFrame.entrypointName,
      routeBase: ctx.appFrame.routeBase,
    };
  }

  if (ctx.processId) {
    return processInteractionOrigin(ctx.processId, ctx.identity?.process.uid);
  }

  const identity = ctx.identity;
  if (!identity) return undefined;

  if (identity.role === "driver") {
    return {
      kind: "device",
      deviceId: identity.device,
      ...(identity.process.cwd ? { cwd: identity.process.cwd } : {}),
    };
  }

  if (identity.role === "user") {
    const connection = ctx.connection as { id?: string; state?: unknown } | null | undefined;
    if (!connection?.id) return undefined;
    const state = connection.state as { clientId?: unknown; clientPlatform?: unknown } | undefined;
    const clientId = typeof state?.clientId === "string" && state.clientId.trim()
      ? state.clientId.trim()
      : undefined;
    const platform = typeof state?.clientPlatform === "string" && state.clientPlatform.trim()
      ? state.clientPlatform.trim()
      : undefined;
    return {
      kind: "client",
      connectionId: connection.id,
      ...(clientId ? { clientId } : {}),
      ...(platform ? { platform } : {}),
    };
  }

  return undefined;
}

function processInteractionOrigin(sourcePid: string, uid?: number): InteractionOrigin {
  return {
    kind: "process",
    sourcePid,
    ...(typeof uid === "number" && Number.isFinite(uid) ? { uid } : {}),
  };
}

export async function handleProcIpcSend(
  args: ProcIpcSendArgs,
  ctx: KernelContext,
): Promise<ProcIpcSendResult> {
  const resolved = resolveSameOwnerIpc(args, ctx, "proc.ipc.send");
  if (!resolved.ok) return resolved;

  const response = await sendFrameToProcess(resolved.args.pid, {
    type: "req",
    id: crypto.randomUUID(),
    call: "proc.ipc.deliver",
    args: {
      sourcePid: resolved.sourcePid,
      source: ctx.identity!.process,
      conversationId: resolved.args.conversationId,
      message: resolved.args.message,
      metadata: resolved.args.metadata,
      origin: processInteractionOrigin(resolved.sourcePid, resolved.source.uid),
      sentAt: Date.now(),
    },
  });

  if (response && response.type === "res") {
    const res = response as ResponseFrame;
    if (res.ok) {
      return (res as { data: ProcIpcSendResult }).data;
    }
    return { ok: false, error: (res as { error: { message: string } }).error.message };
  }

  return { ok: false, error: "proc.ipc.deliver did not return a response" };
}

export async function handleProcIpcCall(
  args: ProcIpcCallArgs,
  ctx: KernelContext,
): Promise<ProcIpcCallResult> {
  const resolved = resolveSameOwnerIpc(args, ctx, "proc.ipc.call");
  if (!resolved.ok) return resolved;
  if (!ctx.ipcCalls) {
    return { ok: false, error: "proc.ipc.call store is not configured" };
  }
  if (!ctx.scheduleIpcCallTimeout) {
    return { ok: false, error: "proc.ipc.call scheduler is not configured" };
  }

  const timeoutMs = clampIpcCallTimeout(args.timeoutMs);
  const deadlineAt = Date.now() + timeoutMs;
  const callId = crypto.randomUUID();

  ctx.ipcCalls.create({
    callId,
    uid: resolved.source.uid,
    sourcePid: resolved.sourcePid,
    targetPid: resolved.args.pid,
    deadlineAt,
  });

  let response: ResponseFrame | null;
  try {
    response = await sendFrameToProcess(resolved.args.pid, {
      type: "req",
      id: crypto.randomUUID(),
      call: "proc.ipc.deliver",
      args: {
        sourcePid: resolved.sourcePid,
        source: ctx.identity!.process,
        conversationId: resolved.args.conversationId,
        message: resolved.args.message,
        metadata: resolved.args.metadata,
        origin: processInteractionOrigin(resolved.sourcePid, resolved.source.uid),
        sentAt: Date.now(),
        call: {
          callId,
          replyToPid: resolved.sourcePid,
          deadlineAt,
        },
      },
    }) as ResponseFrame | null;
  } catch (error) {
    ctx.ipcCalls.remove(callId);
    return { ok: false, error: formatError(error) };
  }

  if (!response || response.type !== "res") {
    ctx.ipcCalls.remove(callId);
    return { ok: false, error: "proc.ipc.deliver did not return a response" };
  }
  if (!response.ok) {
    ctx.ipcCalls.remove(callId);
    return { ok: false, error: response.error.message };
  }

  const delivered = response.data as ProcIpcSendResult;
  if (!delivered.ok) {
    ctx.ipcCalls.remove(callId);
    return delivered;
  }

  ctx.ipcCalls.attachRun(callId, delivered.runId);
  await ctx.scheduleIpcCallTimeout(callId, timeoutMs);

  return {
    ok: true,
    status: "started",
    callId,
    pid: delivered.pid,
    sourcePid: resolved.sourcePid,
    conversationId: delivered.conversationId,
    runId: delivered.runId,
    deadlineAt,
    ...(delivered.queued ? { queued: true } : {}),
  };
}

/**
 * Forward a proc.* request to the target Process DO.
 *
 * Resolves the target pid (defaults to caller's init process),
 * verifies ownership, and delivers via recvFrame RPC.
 */
export async function forwardToProcess(
  frame: RequestFrame,
  ctx: KernelContext,
): Promise<unknown> {
  const identity = ctx.identity!;
  const callerOwnerUid = resolveCallerOwnerUid(ctx);
  const args = frame.args as { pid?: string };
  // No explicit target → the caller's default ("inbox") conversation executor
  // (allocating/reusing one), which is the stable surface for their personal
  // agent.
  const pid = args.pid ?? await ensureDefaultConversationExecutor(
    ctx,
    resolveCallerOwnerIdentity(ctx, identity.process),
  );

  const proc = ctx.procs.get(pid);
  if (!proc) {
    throw new Error(`Process not found: ${pid}`);
  }

  if (proc.ownerUid !== callerOwnerUid && identity.process.uid !== 0) {
    throw new Error(`Permission denied: cannot access process ${pid}`);
  }

  const processFrame = frame.call === "proc.send"
    ? withProcSendOrigin(frame, ctx)
    : frame;
  const response = await sendFrameToProcess(pid, processFrame);

  if (response && response.type === "res") {
    const res = response as ResponseFrame;
    if (res.ok) {
      const conversation = ctx.conversations?.getByActivePid(pid);
      if (frame.call === "proc.reset") {
        clearLatestArchiveForConversation(ctx, conversation);
      } else if (frame.call === "proc.conversation.reset") {
        const data = (res as { data?: { conversationId?: string } }).data;
        if (data?.conversationId === DEFAULT_CONVERSATION_ID) {
          clearLatestArchiveForConversation(ctx, conversation);
        }
      } else if (frame.call === "proc.kill") {
        ctx.procs.kill(pid);
        // The executor is gone. Record where its conversation's transcript was
        // archived (so a future executor hydrates from it), then detach so the
        // next delivery allocates a fresh executor.
        if (conversation) {
          const archived = (res as { data?: { archives?: Array<{ path?: string }> } }).data;
          const base = conversation.archiveBase.replace(/^\/+/, "");
          const primaryArchive = archived?.archives?.find((a) =>
            typeof a.path === "string" && a.path.replace(/^\/+/, "").startsWith(base),
          );
          if (primaryArchive?.path) {
            ctx.conversations?.setLatestArchive(conversation.conversationId, primaryArchive.path);
          }
        }
        ctx.conversations?.clearActivePid(pid);
      }
      return (res as { data?: unknown }).data;
    } else {
      throw new Error((res as { error: { message: string } }).error.message);
    }
  }

  return { ok: true, status: "delivered" };
}

function clearLatestArchiveForConversation(
  ctx: KernelContext,
  conversation: { conversationId: string } | null | undefined,
): void {
  if (conversation) {
    ctx.conversations?.setLatestArchive(conversation.conversationId, null);
  }
}

function resolveCallerOwnerIdentity(ctx: KernelContext, fallback: ProcessIdentity): ProcessIdentity {
  const ownerUid = resolveCallerOwnerUid(ctx);
  if (ownerUid === fallback.uid) {
    return fallback;
  }
  const entry = ctx.auth.getPasswdByUid(ownerUid);
  if (!entry) {
    throw new Error(`Cannot resolve caller owner uid ${ownerUid}`);
  }
  return accountIdentity(ctx.auth, entry);
}

type NormalizedIpcSendArgs =
  | {
      ok: true;
      pid: string;
      conversationId?: string;
      message: string;
      metadata?: Record<string, unknown>;
    }
  | { ok: false; error: string };

type ResolvedSameOwnerIpc =
  | {
      ok: true;
      sourcePid: string;
      source: { uid: number };
      target: { uid: number };
      args: Extract<NormalizedIpcSendArgs, { ok: true }>;
    }
  | { ok: false; error: string };

function resolveSameOwnerIpc(
  args: ProcIpcSendArgs,
  ctx: KernelContext,
  syscall: "proc.ipc.send" | "proc.ipc.call",
): ResolvedSameOwnerIpc {
  const sourcePid = ctx.processId;
  if (!sourcePid) {
    return { ok: false, error: `${syscall} requires a process caller` };
  }

  const validated = normalizeIpcSendArgs(args, syscall);
  if (!validated.ok) {
    return validated;
  }

  const source = ctx.procs.get(sourcePid);
  if (!source) {
    return { ok: false, error: `Source process not found: ${sourcePid}` };
  }

  const target = ctx.procs.get(validated.pid);
  if (!target) {
    return { ok: false, error: `Process not found: ${validated.pid}` };
  }

  if (source.uid !== ctx.identity!.process.uid) {
    return { ok: false, error: `Source process identity mismatch: ${sourcePid}` };
  }

  if (target.ownerUid !== source.ownerUid) {
    return { ok: false, error: "Permission denied: target process belongs to another user" };
  }

  return {
    ok: true,
    sourcePid,
    source,
    target,
    args: validated,
  };
}

function normalizeIpcSendArgs(
  args: ProcIpcSendArgs,
  syscall: "proc.ipc.send" | "proc.ipc.call",
): NormalizedIpcSendArgs {
  if (!args || typeof args !== "object") {
    return { ok: false, error: `${syscall} requires arguments` };
  }
  const record = args as Record<string, unknown>;
  const pid = normalizeRequiredString(record.pid);
  if (!pid) {
    return { ok: false, error: `${syscall} requires pid` };
  }

  const message = normalizeRequiredString(record.message);
  if (!message) {
    return { ok: false, error: `${syscall} requires message` };
  }

  const conversationId = record.conversationId === undefined
    ? undefined
    : normalizeRequiredString(record.conversationId);
  if (record.conversationId !== undefined && !conversationId) {
    return { ok: false, error: `${syscall} conversationId must be a non-empty string` };
  }

  if (
    record.metadata !== undefined
    && (!record.metadata || typeof record.metadata !== "object" || Array.isArray(record.metadata))
  ) {
    return { ok: false, error: `${syscall} metadata must be an object` };
  }

  return {
    ok: true,
    pid,
    message,
    ...(conversationId ? { conversationId } : {}),
    ...(record.metadata ? { metadata: record.metadata as Record<string, unknown> } : {}),
  };
}

function clampIpcCallTimeout(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_IPC_CALL_TIMEOUT_MS;
  }
  return Math.max(
    MIN_IPC_CALL_TIMEOUT_MS,
    Math.min(MAX_IPC_CALL_TIMEOUT_MS, Math.trunc(value)),
  );
}

function normalizeRequiredString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type SpawnMountOutcome =
  | {
      ok: true;
      mounts: ProcessMount[];
    }
  | {
      ok: false;
      error: string;
    };

type SpawnMountSpecWithRecord = {
  spec: ProcSpawnMountSpec;
  record: InstalledPackageRecord;
};

function materializeSpawnMounts(
  specs: ProcSpawnMountSpec[] | undefined,
  ctx: KernelContext,
  ownerUid: number,
): SpawnMountOutcome {
  const mounts: ProcessMount[] = [];
  const seen = new Set<string>();
  const sourcePackages = ctx.packages.list({ scopes: visiblePackageScopesForActor({ uid: ownerUid }) });
  const specsToMount: SpawnMountSpecWithRecord[] = specs
    ? specs.map((spec) => ({ spec, record: resolveInstalledPackage(spec.packageId, ctx) }))
    : sourcePackages.map((record) => ({
      spec: { kind: "package-source" as const, packageId: record.packageId },
      record,
    }));

  for (const { spec, record } of specsToMount) {
    const requestedMountPath = typeof spec.mountPath === "string" && spec.mountPath.trim()
      ? spec.mountPath
      : defaultMountPathForPackage(spec, record, sourcePackages);
    const mountPath = normalizePath(requestedMountPath);
    if (mountPath === "/" || !mountPath.startsWith("/src")) {
      return { ok: false, error: `Unsupported mount path: ${mountPath}` };
    }
    if (seen.has(mountPath)) {
      return { ok: false, error: `Conflicting package source mount path: ${mountPath}` };
    }
    seen.add(mountPath);

    mounts.push({
      kind: "ripgit-source",
      mountPath,
      packageId: record.packageId,
      scope: record.scope,
      repo: record.manifest.source.repo,
      ref: record.manifest.source.ref,
      resolvedCommit: record.manifest.source.resolvedCommit ?? null,
      subdir: spec.kind === "package-source" ? record.manifest.source.subdir : ".",
    });
  }

  return { ok: true, mounts };
}

function defaultMountPathForPackage(
  spec: ProcSpawnMountSpec,
  record: InstalledPackageRecord,
  sourcePackages: InstalledPackageRecord[],
): string {
  if (spec.kind === "package-repo") {
    return `/src/repos/${packageSourceRepoPathName(record)}`;
  }
  return `/src/packages/${packageSourcePathNameForRecord(record, sourcePackages)}`;
}

function packageSourceRepoPathName(record: InstalledPackageRecord): string {
  return sanitizeMountPathSegment(record.manifest.source.repo) || sanitizeMountPathSegment(record.packageId) || "repo";
}

function sanitizeMountPathSegment(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

function defaultMountCwd(mounts: ProcessMount[]): string | null {
  return mounts.find((mount) => mount.mountPath.startsWith("/src/packages/"))?.mountPath
    ?? mounts[0]?.mountPath
    ?? null;
}

function resolveSpawnCwd(
  cwd: string | undefined,
  baseIdentity: ProcessIdentity,
  mounts: ProcessMount[],
): string {
  if (typeof cwd === "string" && cwd.trim().length > 0) {
    return resolveUserPath(cwd, baseIdentity.home, baseIdentity.cwd);
  }
  return defaultMountCwd(mounts) ?? baseIdentity.cwd;
}
