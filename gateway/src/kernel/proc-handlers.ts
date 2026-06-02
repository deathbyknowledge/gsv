/**
 * Kernel-side proc.* syscall handlers.
 *
 * proc.list — answered entirely by the kernel ProcessRegistry.
 * proc.spawn — registers in ProcessRegistry, DO is lazily instantiated.
 * proc.send/kill/history/reset — forwarded to the Process DO via recvFrame.
 */

import type { RequestFrame, ResponseFrame } from "../protocol/frames";
import type { KernelContext } from "./context";
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
import {
  isAiContextProfile,
  isSystemAiContextProfile,
  isUserAiContextProfile,
  type AiContextProfile,
} from "../syscalls/ai";
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
  resolvePackageProfileReference,
  visiblePackageScopesForActor,
} from "./packages";
import { resolveUserAiProfile } from "./user-profiles";
import { ensurePersonalAgent } from "./agents";
import { accountIdentity } from "./accounts";
import { resolvePackageAgentRunAs } from "./package-agents";

/**
 * The owner uid for processes spawned in this context: the calling process's
 * owner when invoked from a process, otherwise the connecting user.
 */
function resolveCallerOwnerUid(ctx: KernelContext): number {
  if (ctx.processId) {
    const self = ctx.procs.get(ctx.processId);
    if (self) return self.ownerUid;
  }
  return ctx.identity!.process.uid;
}

const DEFAULT_IPC_CALL_TIMEOUT_MS = 60_000;
const MIN_IPC_CALL_TIMEOUT_MS = 1_000;
const MAX_IPC_CALL_TIMEOUT_MS = 10 * 60 * 1000;

export function handleProcList(
  args: ProcListArgs,
  ctx: KernelContext,
): ProcListResult {
  const identity = ctx.identity!;
  const isRoot = identity.process.uid === 0;
  const uid = args.uid ?? (isRoot ? undefined : identity.process.uid);

  const records = ctx.procs.list(uid);

  const processes: ProcListEntry[] = records.map((r) => ({
    pid: r.processId,
    uid: r.ownerUid,
    profile: r.profile,
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
  }));

  return { processes };
}

export async function handleProcSpawn(
  args: ProcSpawnArgs,
  ctx: KernelContext,
): Promise<ProcSpawnResult> {
  const identity = ctx.identity!;
  const pid = crypto.randomUUID();
  const profile = normalizeSpawnProfile(args.profile);

  if (!isAiContextProfile(profile)) {
    return { ok: false, error: `Invalid process profile: ${String(profile)}` };
  }
  if (profile === "init") {
    const agent = await ensurePersonalAgent(ctx, identity.process);
    const ensured = ctx.procs.ensureInit(identity.process.uid, agent.identity);
    const initRecord = ctx.procs.get(ensured.pid);
    if (!initRecord) {
      return { ok: false, error: "Failed to resolve init process" };
    }

    if (ensured.created) {
      await sendFrameToProcess(ensured.pid, {
        type: "req",
        id: crypto.randomUUID(),
        call: "proc.setidentity",
        args: {
          pid: ensured.pid,
          identity: agent.identity,
          profile: "init",
          interactive: true,
          assignment: args.assignment as ProcSpawnAssignment | undefined,
        },
      });
    }

    if (args.prompt) {
      const origin = interactionOriginForContext(ctx);
      await sendFrameToProcess(ensured.pid, {
        type: "req",
        id: crypto.randomUUID(),
        call: "proc.send",
        args: {
          pid: ensured.pid,
          message: args.prompt,
          ...(origin ? { origin } : {}),
        },
      });
    }

    return {
      ok: true,
      pid: initRecord.processId,
      label: initRecord.label ?? undefined,
      profile: "init",
      cwd: initRecord.cwd,
    };
  }
  if (!isSystemAiContextProfile(profile) && !isUserAiContextProfile(profile)) {
    try {
      const resolved = resolvePackageProfileReference(
        profile,
        ctx.packages,
        visiblePackageScopesForActor(identity.process),
      );
      if (!resolved) {
        return { ok: false, error: `Unknown package profile: ${profile}` };
      }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  } else if (isUserAiContextProfile(profile)) {
    const userProfile = await resolveUserAiProfile(ctx, profile);
    if (!userProfile) {
      return { ok: false, error: `Unknown user profile: ${profile}` };
    }
  }

  const callerOwnerUid = resolveCallerOwnerUid(ctx);
  const parentPid = args.parentPid ?? ctx.processId ?? `init:${callerOwnerUid}`;
  const parent = ctx.procs.get(parentPid);

  if (parentPid !== `init:${callerOwnerUid}`) {
    if (!parent || parent.ownerUid !== callerOwnerUid) {
      if (identity.process.uid !== 0) {
        return { ok: false, error: `Cannot spawn under foreign process: ${parentPid}` };
      }
    }
  }

  // The spawning human owns the process. The run-as identity is, in order of
  // precedence: an explicit `runAs` account, the parent's identity (so children
  // of the personal agent also run as the agent), or the caller's identity.
  const ownerUid = parent ? parent.ownerUid : callerOwnerUid;
  let baseIdentity: ProcessIdentity = parent
    ? {
        uid: parent.uid,
        gid: parent.gid,
        gids: parent.gids,
        username: parent.username,
        home: parent.home,
        cwd: parent.cwd,
      }
    : identity.process;

  if (typeof args.runAs === "string" && args.runAs.trim()) {
    const resolved = resolveRunAsIdentity(ctx, args.runAs, ownerUid);
    if (!resolved.ok) {
      return { ok: false, error: resolved.error };
    }
    baseIdentity = resolved.identity;
  }

  const hasRequestedMounts = args.mounts !== undefined;
  const materializedMounts = materializeSpawnMounts(args.mounts, ctx);
  if (!materializedMounts.ok) {
    return { ok: false, error: materializedMounts.error };
  }

  const spawnIdentity: ProcessIdentity = {
    ...baseIdentity,
    cwd: resolveSpawnCwd(args.cwd, baseIdentity, hasRequestedMounts ? materializedMounts.mounts : []),
  };

  const interactive = args.interactive ?? defaultInteractiveForProfile(profile);

  ctx.procs.spawn(pid, spawnIdentity, {
    parentPid,
    ownerUid,
    profile,
    interactive,
    label: args.label,
    cwd: spawnIdentity.cwd,
    mounts: materializedMounts.mounts,
    contextFiles: args.assignment?.contextFiles ?? [],
  });

  await sendFrameToProcess(pid, {
    type: "req",
    id: crypto.randomUUID(),
    call: "proc.setidentity",
    args: {
      pid,
      identity: spawnIdentity,
      profile,
      interactive,
      assignment: args.assignment as ProcSpawnAssignment | undefined,
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
    profile,
    cwd: spawnIdentity.cwd,
  };
}

/**
 * Default interactivity for a spawn when not explicitly specified. Background
 * worker spawns (cron) cannot request human-in-the-loop approval.
 */
function defaultInteractiveForProfile(profile: AiContextProfile): boolean {
  return profile !== "cron";
}

/**
 * Resolve a `runAs` account selector (username or uid) to its run-as identity,
 * authorizing the owning human. A human may run as an account when it is their
 * own account, their personal agent, an account whose private group they belong
 * to, or when the caller is root.
 */
function resolveRunAsIdentity(
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

  const isSelf = entry.uid === ownerUid;
  const isPersonalAgent = auth.getPersonalAgentUid(ownerUid) === entry.uid;
  const ownerName = auth.getPasswdByUid(ownerUid)?.username;
  const group = auth.getGroupByGid(entry.gid);
  const isGroupMember = !!ownerName && !!group && group.members.includes(ownerName);

  if (!isRoot && !isSelf && !isPersonalAgent && !isGroupMember) {
    return { ok: false, error: `Permission denied: cannot run as ${entry.username}` };
  }

  return { ok: true, identity: accountIdentity(auth, entry) };
}

function normalizeSpawnProfile(profile: ProcSpawnArgs["profile"] | undefined): AiContextProfile {
  if (profile === "personal") {
    return "init";
  }
  return profile ?? "task";
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
  const pid = args.pid ?? `init:${callerOwnerUid}`;

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
      if (frame.call === "proc.kill") {
        ctx.procs.kill(pid);
      }
      return (res as { data?: unknown }).data;
    } else {
      throw new Error((res as { error: { message: string } }).error.message);
    }
  }

  return { ok: true, status: "delivered" };
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
): SpawnMountOutcome {
  const mounts: ProcessMount[] = [];
  const seen = new Set<string>();
  const sourcePackages = ctx.packages.list({ scopes: visiblePackageScopesForActor(ctx.identity?.process) });
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
