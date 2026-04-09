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
  ProcSpawnMountSpec,
  ProcSpawnArgs,
  ProcSpawnResult,
  ProcWorkspaceKind,
  ProcWorkspaceSpec,
} from "../syscalls/proc";
import type { AiContextProfile } from "../syscalls/ai";
import { sendFrameToProcess } from "../shared/utils";
import type { ProcessIdentity } from "../syscalls/system";
import type { ProcessMount } from "./processes";
import {
  createWorkspaceBackend,
  normalizePath,
  workspaceRootPath,
} from "../fs";
import { resolveInstalledPackage } from "./pkg";

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

export async function handleProcSpawn(
  args: ProcSpawnArgs,
  ctx: KernelContext,
): Promise<ProcSpawnResult> {
  const identity = ctx.identity!;
  const pid = crypto.randomUUID();
  const profile = args.profile;

  if (!isProcessProfile(profile)) {
    return { ok: false, error: `Invalid process profile: ${String(profile)}` };
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
  });

  if (materialized.workspaceId) {
    await ensureWorkspaceProcessFiles(ctx, materialized.workspaceId, pid, spawnIdentity);
  }

  await sendFrameToProcess(pid, {
    type: "req",
    id: crypto.randomUUID(),
    call: "proc.setidentity",
    args: { pid, identity: spawnIdentity, profile },
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
      const workspaceRecord = ctx.workspaces.create(baseIdentity.uid, {
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

function isProcessProfile(value: unknown): value is AiContextProfile {
  return value === "init" || value === "task" || value === "review" || value === "cron" || value === "mcp" || value === "app";
}
