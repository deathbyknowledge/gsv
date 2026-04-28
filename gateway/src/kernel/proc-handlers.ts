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
  ProcProfileListArgs,
  ProcProfileListEntry,
  ProcProfileListResult,
  ProcSpawnAssignment,
  ProcSpawnMountSpec,
  ProcSpawnArgs,
  ProcSpawnResult,
  ProcWorkspaceKind,
  ProcWorkspaceSpec,
} from "../syscalls/proc";
import {
  isAiContextProfile,
  isSystemAiContextProfile,
  type AiContextProfile,
} from "../syscalls/ai";
import { sendFrameToProcess } from "../shared/utils";
import type { ProcessIdentity } from "@gsv/protocol/syscalls/system";
import type { ProcessMount } from "./processes";
import {
  createWorkspaceBackend,
  normalizePath,
  workspaceRootPath,
} from "../fs";
import { resolveInstalledPackage } from "./pkg";
import {
  resolvePackageProfileReference,
  visiblePackageScopesForActor,
} from "./packages";

const SYSTEM_PROFILE_ENTRIES: ProcProfileListEntry[] = [
  {
    id: "init",
    kind: "system",
    displayName: "Home",
    description: "The persistent home conversation for the user.",
    interactive: true,
    startable: true,
    background: false,
    spawnMode: "singleton",
  },
  {
    id: "task",
    kind: "system",
    displayName: "Task",
    description: "A focused conversation for new work.",
    interactive: true,
    startable: true,
    background: false,
    spawnMode: "new",
  },
  {
    id: "review",
    kind: "system",
    displayName: "Review",
    description: "A skeptical review conversation for packages and changes.",
    interactive: true,
    startable: true,
    background: false,
    spawnMode: "new",
  },
  {
    id: "mcp",
    kind: "system",
    displayName: "Master Control",
    description: "Operational control-plane and diagnostics conversation.",
    interactive: true,
    startable: true,
    background: false,
    spawnMode: "new",
  },
  {
    id: "app",
    kind: "system",
    displayName: "App Runtime",
    description: "App-owned runtime profile.",
    interactive: false,
    startable: false,
    background: false,
    spawnMode: "new",
  },
  {
    id: "cron",
    kind: "system",
    displayName: "Cron",
    description: "Scheduled background worker.",
    interactive: false,
    startable: false,
    background: true,
    spawnMode: "new",
  },
];

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
    uid: r.uid,
    profile: r.profile,
    parentPid: r.parentPid,
    state: r.state,
    label: r.label,
    createdAt: r.createdAt,
    workspaceId: r.workspaceId,
    cwd: r.cwd,
  }));

  return { processes };
}

export function handleProcProfileList(
  _args: ProcProfileListArgs,
  ctx: KernelContext,
): ProcProfileListResult {
  const scopes = visiblePackageScopesForActor(ctx.identity?.process);
  const packageProfiles = ctx.packages
    .list({ scopes })
    .filter((record) => record.enabled)
    .flatMap((record) => (record.manifest.profiles ?? []).map((profile): ProcProfileListEntry => ({
      id: `${record.packageId}#${profile.name}`,
      alias: `${record.manifest.name}#${profile.name}`,
      kind: "package",
      displayName: profile.displayName,
      ...(profile.description ? { description: profile.description } : {}),
      ...(profile.icon ? { icon: profile.icon } : {}),
      interactive: true,
      startable: true,
      background: false,
      spawnMode: "new",
      packageId: record.packageId,
      packageName: record.manifest.name,
    })))
    .sort((left, right) => {
      const packageNameCompare = (left.packageName ?? "").localeCompare(right.packageName ?? "");
      if (packageNameCompare !== 0) {
        return packageNameCompare;
      }
      return left.displayName.localeCompare(right.displayName);
    });

  return {
    profiles: [...SYSTEM_PROFILE_ENTRIES, ...packageProfiles],
  };
}

export async function handleProcSpawn(
  args: ProcSpawnArgs,
  ctx: KernelContext,
): Promise<ProcSpawnResult> {
  const identity = ctx.identity!;
  const pid = crypto.randomUUID();
  const profile = args.profile;

  if (!isAiContextProfile(profile)) {
    return { ok: false, error: `Invalid process profile: ${String(profile)}` };
  }
  if (profile === "init") {
    const ensured = ctx.procs.ensureInit(identity.process);
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
          identity: identity.process,
          profile: "init",
          assignment: args.assignment as ProcSpawnAssignment | undefined,
        },
      });
    }

    if (args.prompt) {
      await sendFrameToProcess(ensured.pid, {
        type: "req",
        id: crypto.randomUUID(),
        call: "proc.send",
        args: { pid: ensured.pid, message: args.prompt },
      });
    }

    return {
      ok: true,
      pid: initRecord.processId,
      label: initRecord.label ?? undefined,
      profile: "init",
      workspaceId: initRecord.workspaceId,
      cwd: initRecord.cwd,
    };
  }
  if (!isSystemAiContextProfile(profile)) {
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
  }

  const parentPid = args.parentPid ?? `init:${identity.process.uid}`;
  const parent = ctx.procs.get(parentPid);

  if (parentPid !== `init:${identity.process.uid}`) {
    if (!parent || parent.uid !== identity.process.uid) {
      if (identity.process.uid !== 0) {
        return { ok: false, error: `Cannot spawn under foreign process: ${parentPid}` };
      }
    }
  }

  const baseIdentity = parent
    ? {
        uid: parent.uid,
        gid: parent.gid,
        gids: parent.gids,
        username: parent.username,
        home: parent.home,
        cwd: parent.cwd,
        workspaceId: parent.workspaceId,
      }
    : identity.process;

  const materialized = await materializeSpawnIdentity(args.workspace, baseIdentity, args.label, ctx);
  if (!materialized.ok) {
    return { ok: false, error: materialized.error };
  }

  const materializedMounts = materializeSpawnMounts(args.mounts, ctx);
  if (!materializedMounts.ok) {
    return { ok: false, error: materializedMounts.error };
  }

  const spawnIdentity: ProcessIdentity = {
    ...materialized.identity,
    cwd: materialized.workspaceId
      ? materialized.identity.cwd
      : defaultMountCwd(materializedMounts.mounts) ?? materialized.identity.cwd,
  };

  ctx.procs.spawn(pid, spawnIdentity, {
    parentPid,
    profile,
    label: args.label,
    cwd: spawnIdentity.cwd,
    workspaceId: materialized.identity.workspaceId,
    mounts: materializedMounts.mounts,
    contextFiles: args.assignment?.contextFiles ?? [],
  });

  if (materialized.workspaceId) {
    await ensureWorkspaceProcessFiles(ctx, materialized.workspaceId, pid, spawnIdentity);
  }

  await sendFrameToProcess(pid, {
    type: "req",
    id: crypto.randomUUID(),
    call: "proc.setidentity",
    args: {
      pid,
      identity: spawnIdentity,
      profile,
      assignment: args.assignment as ProcSpawnAssignment | undefined,
    },
  });

  if (args.prompt) {
    await sendFrameToProcess(pid, {
      type: "req",
      id: crypto.randomUUID(),
      call: "proc.send",
      args: { pid, message: args.prompt },
    });
  }

  return {
    ok: true,
    pid,
    label: args.label,
    profile,
    workspaceId: materialized.identity.workspaceId,
    cwd: spawnIdentity.cwd,
  };
}

export async function handleProcIpcSend(
  args: ProcIpcSendArgs,
  ctx: KernelContext,
): Promise<ProcIpcSendResult> {
  const resolved = resolveSameOwnerIpc(args, ctx, "proc.ipc.send");
  if (!resolved.ok) return resolved;

  if (resolved.target.workspaceId) {
    ctx.workspaces.touch(resolved.target.workspaceId);
  }

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

  if (resolved.target.workspaceId) {
    ctx.workspaces.touch(resolved.target.workspaceId);
  }

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
      sentAt: Date.now(),
      call: {
        callId,
        replyToPid: resolved.sourcePid,
        deadlineAt,
      },
    },
  });

  if (!response || response.type !== "res") {
    return { ok: false, error: "proc.ipc.deliver did not return a response" };
  }
  if (!response.ok) {
    return { ok: false, error: response.error.message };
  }

  const delivered = response.data as ProcIpcSendResult;
  if (!delivered.ok) {
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
  const args = frame.args as { pid?: string };
  const pid = args.pid ?? `init:${identity.process.uid}`;

  const proc = ctx.procs.get(pid);
  if (!proc) {
    throw new Error(`Process not found: ${pid}`);
  }

  if (proc.uid !== identity.process.uid && identity.process.uid !== 0) {
    throw new Error(`Permission denied: cannot access process ${pid}`);
  }

  if (frame.call === "proc.send" && proc.workspaceId) {
    ctx.workspaces.touch(proc.workspaceId);
  }
  const response = await sendFrameToProcess(pid, frame);

  if (response && response.type === "res") {
    const res = response as ResponseFrame;
    if (res.ok) {
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
      target: { uid: number; workspaceId: string | null };
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

  if (target.uid !== source.uid) {
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

type SpawnIdentityOutcome =
  | {
      ok: true;
      identity: ProcessIdentity;
      workspaceId: string | null;
    }
  | {
      ok: false;
      error: string;
    };

type SpawnMountOutcome =
  | {
      ok: true;
      mounts: ProcessMount[];
    }
  | {
      ok: false;
      error: string;
    };

async function materializeSpawnIdentity(
  workspace: ProcWorkspaceSpec | undefined,
  baseIdentity: ProcessIdentity,
  label: string | undefined,
  ctx: KernelContext,
): Promise<SpawnIdentityOutcome> {
  const spec = workspace ?? defaultWorkspaceSpec(baseIdentity);

  switch (spec.mode) {
    case "none":
      return {
        ok: true,
        identity: { ...baseIdentity, cwd: baseIdentity.home, workspaceId: null },
        workspaceId: null,
      };
    case "inherit":
      return {
        ok: true,
        identity: {
          ...baseIdentity,
          cwd: baseIdentity.workspaceId ? baseIdentity.cwd : baseIdentity.home,
        },
        workspaceId: baseIdentity.workspaceId,
      };
    case "attach": {
      const workspaceRecord = ctx.workspaces.get(spec.workspaceId);
      if (!workspaceRecord) {
        return { ok: false, error: `Workspace not found: ${spec.workspaceId}` };
      }
      if (ctx.identity!.process.uid !== 0 && workspaceRecord.ownerUid !== baseIdentity.uid) {
        return { ok: false, error: `Permission denied: workspace ${spec.workspaceId}` };
      }

      ctx.workspaces.touch(spec.workspaceId);
      return {
        ok: true,
        identity: {
          ...baseIdentity,
          cwd: workspaceRootPath(spec.workspaceId),
          workspaceId: spec.workspaceId,
        },
        workspaceId: spec.workspaceId,
      };
    }
    case "new": {
      const workspaceRecord = ctx.workspaces.create(baseIdentity, {
        label: spec.label ?? label,
        kind: spec.kind ?? "thread",
      });

      try {
        await ensureWorkspaceRoot(ctx, workspaceRecord.workspaceId, baseIdentity, spec.kind ?? "thread");
      } catch (error) {
        ctx.workspaces.delete(workspaceRecord.workspaceId);
        throw error;
      }

      return {
        ok: true,
        identity: {
          ...baseIdentity,
          cwd: workspaceRootPath(workspaceRecord.workspaceId),
          workspaceId: workspaceRecord.workspaceId,
        },
        workspaceId: workspaceRecord.workspaceId,
      };
    }
    default:
      return { ok: false, error: "Invalid workspace mode" };
  }
}

function materializeSpawnMounts(
  specs: ProcSpawnMountSpec[] | undefined,
  ctx: KernelContext,
): SpawnMountOutcome {
  const mounts: ProcessMount[] = [];
  const seen = new Set<string>();

  for (const spec of specs ?? []) {
    const record = resolveInstalledPackage(spec.packageId, ctx);
    const mountPath = normalizePath(spec.mountPath ?? defaultMountPathForSpec(spec));
    if (mountPath === "/" || !mountPath.startsWith("/src")) {
      return { ok: false, error: `Unsupported mount path: ${mountPath}` };
    }
    if (seen.has(mountPath)) {
      return { ok: false, error: `Duplicate mount path: ${mountPath}` };
    }
    seen.add(mountPath);

    mounts.push({
      kind: "ripgit-source",
      mountPath,
      packageId: record.packageId,
      repo: record.manifest.source.repo,
      ref: record.manifest.source.ref,
      resolvedCommit: record.manifest.source.resolvedCommit ?? null,
      subdir: spec.kind === "package-source" ? record.manifest.source.subdir : ".",
    });
  }

  return { ok: true, mounts };
}

function defaultMountPathForSpec(spec: ProcSpawnMountSpec): string {
  return spec.kind === "package-source" ? "/src/package" : "/src/repo";
}

function defaultMountCwd(mounts: ProcessMount[]): string | null {
  return mounts.find((mount) => mount.mountPath === "/src/package")?.mountPath
    ?? mounts[0]?.mountPath
    ?? null;
}

function defaultWorkspaceSpec(identity: ProcessIdentity): ProcWorkspaceSpec {
  return identity.workspaceId ? { mode: "inherit" } : { mode: "none" };
}

async function ensureWorkspaceRoot(
  ctx: KernelContext,
  workspaceId: string,
  identity: ProcessIdentity,
  kind: ProcWorkspaceKind,
): Promise<void> {
  const backend = requireWorkspaceBackend(ctx, identity);
  const root = workspaceRootPath(workspaceId);
  const workspaceJsonPath = `${root}/.gsv/workspace.json`;
  const summaryPath = `${root}/.gsv/summary.md`;

  const workspaceJsonExists = await backend.exists(workspaceJsonPath);
  if (!workspaceJsonExists) {
    const payload = JSON.stringify({
      workspaceId,
      ownerUid: identity.uid,
      ownerUsername: identity.username,
      label: ctx.workspaces.get(workspaceId)?.label ?? null,
      kind,
      createdAt: Date.now(),
    }, null, 2);
    await backend.writeFile(workspaceJsonPath, payload);
  }

  const summaryExists = await backend.exists(summaryPath);
  if (!summaryExists) {
    await backend.writeFile(summaryPath, "");
  }
}

async function ensureWorkspaceProcessFiles(
  ctx: KernelContext,
  workspaceId: string,
  pid: string,
  identity: ProcessIdentity,
): Promise<void> {
  const backend = requireWorkspaceBackend(ctx, identity);
  const chatPath = `${workspaceRootPath(workspaceId)}/.gsv/processes/${pid}/chat.jsonl`;
  const exists = await backend.exists(chatPath);
  if (exists) return;
  await backend.writeFile(chatPath, "");
}

function requireWorkspaceBackend(ctx: KernelContext, identity: ProcessIdentity) {
  const backend = createWorkspaceBackend(ctx.env, identity, ctx.workspaces);
  if (!backend) {
    throw new Error("Workspace backend is not configured");
  }
  return backend;
}
