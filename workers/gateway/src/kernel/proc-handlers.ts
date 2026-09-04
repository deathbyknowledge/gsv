/**
 * Kernel-side proc.* syscall handlers.
 *
 * proc.list — answered entirely by the kernel ProcessRegistry.
 * proc.spawn — registers in ProcessRegistry, DO is lazily instantiated.
 * proc.send/kill/history/reset — forwarded to the Process DO via recvFrame.
 */

import type { FrameBody, RequestFrame, ResponseFrame } from "../protocol/frames";
import { resolveEffectiveAiModelStack } from "./ai";
import type { ArgsOf, ResultOf, SyscallName } from "../syscalls";
import type { KernelContext } from "./context";
import { principalOf, requirePrincipal } from "./context";
import { resolveCallerOwnerUid } from "./context";
import type {
  InteractionOrigin,
  JsonObject,
  ProcessIdentity,
  ProcListArgs,
  ProcListResult,
  ProcListEntry,
  ProcAiConfigSetArgs,
  ProcForkArgs,
  ProcForkResult,
  ProcHistoryExportResult,
  ProcIpcCallArgs,
  ProcIpcCallResult,
  ProcIpcDeliverArgs,
  ProcIpcDeliverResult,
  ProcIpcSendArgs,
  ProcIpcSendResult,
  ProcSpawnArgs,
  ProcSpawnResult,
  ProcSendArgs,
} from "@humansandmachines/gsv/protocol";
import { REQUEST_CANCEL_SIGNAL } from "@humansandmachines/gsv/protocol";
import { sendFrameToProcess } from "../shared/utils";
import { raceWithAbort } from "../shared/abort";
import { resolveUserPath } from "../fs";
import { ensurePersonalAgent } from "./agents";
import { accountIdentity } from "./accounts";
import { canOwnerDelegateRunAs } from "./account-access";
import { invalidatePersonalControllerReadiness } from "./personal-controller";

const DEFAULT_IPC_CALL_TIMEOUT_MS = 60_000;
const MIN_IPC_CALL_TIMEOUT_MS = 1_000;
const MAX_IPC_CALL_TIMEOUT_MS = 10 * 60 * 1000;

type ForwardedProcessResult = {
  data?: ResultOf<SyscallName>;
  body?: FrameBody;
};

export function handleProcList(
  args: ProcListArgs,
  ctx: KernelContext,
): ProcListResult {
  // Visibility is keyed on the owning human (owner_uid), not the run-as
  // account. A personal agent listing its human's processes must resolve to the
  // human owner, otherwise it filters on the agent's uid and sees nothing.
  const callerOwnerUid = resolveCallerOwnerUid(ctx);
  const isRoot = callerOwnerUid === 0;
  if (!isRoot && args.uid !== undefined && args.uid !== callerOwnerUid) {
    throw new Error(`Permission denied: cannot list processes for uid=${args.uid}`);
  }
  const uid = isRoot ? args.uid : callerOwnerUid;

  const records = ctx.procs.list(uid);

  const processes: ProcListEntry[] = records.map((r) => ({
    pid: r.processId,
    uid: r.ownerUid,
    username: r.username,
    interactive: r.interactive,
    personal: r.isPersonalController,
    parentPid: r.parentPid,
    state: r.state,
    activeRunId: r.activeRunId,
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
  const identity = principalOf(ctx)!;
  const pid = `proc:${crypto.randomUUID()}`;
  const runAs = args.runAs?.trim();
  const explicitRunAs = Boolean(runAs);
  const label = args.label?.trim() || undefined;
  const interactive = args.interactive ?? true;

  const callerOwnerUid = resolveCallerOwnerUid(ctx);
  const parentPid = args.parentPid ?? ctx.processId;
  const parent = parentPid ? ctx.procs.get(parentPid) : null;
  const parentIsCurrentCaller = !!parentPid && parentPid === ctx.processId;
  const parentRunsAsCaller = !!parent && parent.uid === identity.account.uid;

  if (parentPid) {
    if (!parent || parent.ownerUid !== callerOwnerUid) {
      if (identity.account.uid !== 0) {
        return { ok: false, error: `Cannot spawn under foreign process: ${parentPid}` };
      }
    }
    if (
      parent &&
      args.parentPid &&
      !parentIsCurrentCaller &&
      !parentRunsAsCaller &&
      !explicitRunAs &&
      identity.account.uid !== 0
    ) {
      return { ok: false, error: `Cannot inherit run-as identity from unrelated parent process: ${parentPid}` };
    }
  }

  // The spawning human owns the process. The run-as identity is, in order of
  // precedence: an explicit `runAs` account, the parent's identity (so children
  // of an agent also run as that agent), or — for a parentless spawn — the
  // caller's personal agent. A delegated child inherits this identity unless
  // a specialized agent is selected explicitly.
  const ownerUid = parent ? parent.ownerUid : callerOwnerUid;
  const inheritParentIdentity = parent && (
    parentIsCurrentCaller ||
    parentRunsAsCaller ||
    !args.parentPid ||
    identity.account.uid === 0
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
    : identity.account;

  if (runAs) {
    const resolved = resolveRunAsIdentity(ctx, runAs, ownerUid);
    if (!resolved.ok) {
      return { ok: false, error: resolved.error };
    }
    baseIdentity = resolved.identity;
  } else if (!parent) {
    const owner = ctx.auth.getPasswdByUid(ownerUid);
    if (!owner) {
      return { ok: false, error: `Process owner does not exist: uid=${ownerUid}` };
    }
    const ownerIdentity = accountIdentity(ctx.auth, owner);
    const provision = await ensurePersonalAgent(ctx, ownerIdentity);
    baseIdentity = provision.identity;
  }

  const spawnIdentity: ProcessIdentity = {
    ...baseIdentity,
    cwd: resolveSpawnCwd(args.cwd, baseIdentity),
  };

  let registered = false;
  try {
    ctx.procs.spawn(pid, spawnIdentity, {
      parentPid: parentPid ?? undefined,
      ownerUid,
      interactive,
      label,
      cwd: spawnIdentity.cwd,
    });
    registered = true;

    const requestId = crypto.randomUUID();
    const identityArgs: ArgsOf<"proc.setidentity"> = {
      identity: spawnIdentity,
      interactive,
      autoTitle: label === undefined,
    };
    if (label) identityArgs.title = label;
    const response = await sendFrameToProcess(ctx.installationId, pid, {
      type: "req",
      id: requestId,
      call: "proc.setidentity",
      args: identityArgs,
    });
    if (!response || response.type !== "res" || response.id !== requestId) {
      throw new Error("proc.setidentity returned no valid response");
    }
    if (!response.ok) {
      throw new Error(response.error.message);
    }
    // SAFETY: this response corresponds to the proc.setidentity request above.
    const initialized = response.data as ResultOf<"proc.setidentity"> | undefined;
    if (initialized?.ok !== true) {
      throw new Error("proc.setidentity rejected initialization");
    }
    if (ctx.processId || ctx.connection) {
      ctx.runRoutes.inheritProcessApprovalRoute({
        processId: pid,
        uid: ownerUid,
        ...(ctx.processId ? { sourceProcessId: ctx.processId } : undefined),
        ...(ctx.processRunId ? { sourceRunId: ctx.processRunId } : undefined),
        ...(!ctx.processId
          && ctx.connection
          && principalOf(ctx)?.kind === "human"
          && callerOwnerUid === ownerUid
          ? { connectionId: ctx.connection.id }
          : undefined),
      });
    }
  } catch (error) {
    if (!registered) {
      return {
        ok: false,
        error: `Failed to register process: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    try {
      await rollbackSpawn(ctx, pid);
    } catch (rollbackError) {
      return {
        ok: false,
        error: `Failed to initialize process: ${error instanceof Error ? error.message : String(error)}; `
          + `rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
      };
    }
    return {
      ok: false,
      error: `Failed to initialize process: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (args.prompt) {
    const origin = interactionOriginForContext(ctx);
    const sendArgs: ProcSendArgs = {
      pid,
      message: args.prompt,
    };
    if (origin) sendArgs.origin = origin;
    await sendFrameToProcess(ctx.installationId, pid, {
      type: "req",
      id: crypto.randomUUID(),
      call: "proc.send",
      args: sendArgs,
    });
  }

  return {
    ok: true,
    pid,
    label,
    cwd: spawnIdentity.cwd,
  };
}

export async function handleProcFork(
  args: ProcForkArgs,
  ctx: KernelContext,
): Promise<ProcForkResult> {
  const identity = principalOf(ctx)!;
  const sourcePid = args.pid ?? ctx.processId;
  if (!sourcePid) {
    return { ok: false, error: "proc.fork requires pid outside a process" };
  }
  const source = ctx.procs.get(sourcePid);
  if (!source) {
    return { ok: false, error: `Process not found: ${sourcePid}` };
  }
  const callerOwnerUid = resolveCallerOwnerUid(ctx);
  if (source.ownerUid !== callerOwnerUid && identity.account.uid !== 0) {
    return { ok: false, error: `Permission denied: cannot access process ${sourcePid}` };
  }

  let exported: Extract<ProcHistoryExportResult, { ok: true }> | null = null;
  let targetPid: string | null = null;
  try {
    const exportArgs: ArgsOf<"proc.history.export"> = {};
    if (args.segmentId !== undefined) exportArgs.segmentId = args.segmentId;
    if (args.throughMessageId !== undefined) {
      exportArgs.throughMessageId = args.throughMessageId;
    }
    if (args.throughRunId !== undefined) exportArgs.throughRunId = args.throughRunId;
    if (args.includeLiveSuffix !== undefined) {
      exportArgs.includeLiveSuffix = args.includeLiveSuffix;
    }
    const exportResult = await requestProcessSyscall(
      ctx.installationId,
      sourcePid,
      "proc.history.export",
      exportArgs,
      ctx.requestSignal,
    );
    if (!exportResult.ok) {
      return exportResult;
    }
    exported = exportResult;
    ctx.requestSignal?.throwIfAborted();

    const requestedLabel = normalizeRequiredString(args.label);
    const label = requestedLabel ?? `Branch of ${source.label ?? source.username}`;
    const spawned = await handleProcSpawn({
      runAs: source.username,
      interactive: source.interactive,
      label,
      parentPid: sourcePid,
      cwd: source.cwd,
    }, ctx);
    if (!spawned.ok) {
      return spawned;
    }
    targetPid = spawned.pid;
    ctx.requestSignal?.throwIfAborted();

    const imported = await requestProcessSyscall(
      ctx.installationId,
      targetPid,
      "proc.history.import",
      { archivePaths: exported.archivePaths },
      ctx.requestSignal,
    );
    if (!imported.ok) {
      throw new Error(imported.error);
    }

    const result: Extract<ProcForkResult, { ok: true }> = {
      ok: true,
      pid: targetPid,
      label: spawned.label ?? label,
      sourcePid,
      restoredMessages: imported.restoredMessages,
      includedLiveSuffix: exported.includedLiveSuffix,
    };
    if (exported.segment) result.segment = exported.segment;
    if (exported.throughMessageId !== undefined) {
      result.throughMessageId = exported.throughMessageId;
    }
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!targetPid) {
      return { ok: false, error: message };
    }
    try {
      await rollbackSpawn(ctx, targetPid);
      targetPid = null;
      return { ok: false, error: message };
    } catch (rollbackError) {
      const rollbackMessage = rollbackError instanceof Error
        ? rollbackError.message
        : String(rollbackError);
      return {
        ok: false,
        error: `${message}; rollback failed: ${rollbackMessage}`,
      };
    }
  } finally {
    if (exported?.temporaryArchivePaths.length) {
      const keys = exported.temporaryArchivePaths.map((path) => path.replace(/^\/+/, ""));
      try {
        await ctx.env.STORAGE.delete(keys);
      } catch (error) {
        console.warn("[proc] Failed to delete temporary fork history:", error);
      }
    }
  }
}

async function requestProcessSyscall<
  S extends "proc.history.export" | "proc.history.import",
>(
  installationId: KernelContext["installationId"],
  pid: string,
  call: S,
  args: ArgsOf<S>,
  signal?: AbortSignal,
): Promise<ResultOf<S>> {
  const id = crypto.randomUUID();
  let cancellation: Promise<unknown> | undefined;
  // SAFETY: `call` and `args` share the same syscall-map key through S.
  const frame = {
    type: "req",
    id,
    call,
    args,
  } as RequestFrame<S>;
  const responsePromise = sendFrameToProcess(installationId, pid, frame);
  let response: Awaited<typeof responsePromise>;
  try {
    response = await raceWithAbort(responsePromise, signal, {
      abortReason: () => signal?.reason ?? new Error("Request cancelled"),
      onAbort: () => {
        cancellation = sendFrameToProcess(installationId, pid, {
          type: "sig",
          signal: REQUEST_CANCEL_SIGNAL,
          payload: { id, reason: "Request cancelled" },
        });
      },
    });
  } catch (error) {
    await cancellation?.catch(() => {});
    throw error;
  }
  if (!response || response.type !== "res" || response.id !== id) {
    throw new Error(`${call} returned no valid response`);
  }
  if (!response.ok) {
    throw new Error(response.error.message);
  }
  if (response.data === undefined) {
    throw new Error(`${call} returned no data`);
  }
  // SAFETY: the response id matches the request whose syscall is S.
  return response.data as ResultOf<S>;
}

async function rollbackSpawn(
  ctx: KernelContext,
  pid: string,
): Promise<void> {
  const requestId = crypto.randomUUID();
  const response = await sendFrameToProcess(ctx.installationId, pid, {
    type: "req",
    id: requestId,
    call: "proc.kill",
    args: { pid, archive: false },
  });
  if (!response || response.type !== "res" || response.id !== requestId) {
    throw new Error("proc.kill returned no valid response");
  }
  if (!response.ok) {
    if (response.error.code === 410) {
      const proc = ctx.procs.get(pid);
      if (proc) reconcileKilledProcess(proc.ownerUid, pid, ctx);
      return;
    }
    throw new Error(response.error.message);
  }
  // SAFETY: this response corresponds to the proc.kill request above.
  const killed = response.data as ResultOf<"proc.kill"> | undefined;
  if (killed?.ok !== true) {
    throw new Error("proc.kill rejected rollback");
  }
  const proc = ctx.procs.get(pid);
  if (proc) reconcileKilledProcess(proc.ownerUid, pid, ctx);
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
  const isRoot = requirePrincipal(ctx).account.uid === 0;

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
  const isSelf = entry.uid === requirePrincipal(ctx).account.uid;
  const canDelegate = canOwnerDelegateRunAs(auth, ownerUid, entry);

  if (!isRoot && !isSelf && !canDelegate) {
    return { ok: false, error: `Permission denied: cannot run as ${entry.username}` };
  }

  return { ok: true, identity: accountIdentity(auth, entry) };
}

function withProcSendOrigin(
  frame: RequestFrame<"proc.send">,
  ctx: KernelContext,
): RequestFrame<"proc.send"> {
  const nextArgs: ProcSendArgs = { ...frame.args };
  const origin = interactionOriginForContext(ctx);
  if (origin) {
    nextArgs.origin = origin;
  } else {
    delete nextArgs.origin;
  }
  delete nextArgs.interaction;
  const nextFrame: RequestFrame<"proc.send"> = {
    type: "req",
    id: frame.id,
    call: "proc.send",
    args: nextArgs,
  };
  if (frame.runId !== undefined) nextFrame.runId = frame.runId;
  if (frame.body !== undefined) nextFrame.body = frame.body;
  return nextFrame;
}

function interactionOriginForContext(ctx: KernelContext): InteractionOrigin | undefined {
  if (ctx.processId) {
    return processInteractionOrigin(ctx.processId, principalOf(ctx)?.account.uid);
  }

  const identity = principalOf(ctx);
  if (!identity) return undefined;

  if (identity.kind === "machine") {
    const origin: Extract<InteractionOrigin, { kind: "device" }> = {
      kind: "device",
      deviceId: identity.peerId,
    };
    if (identity.account.cwd) origin.cwd = identity.account.cwd;
    return origin;
  }

  if (identity.kind === "human") {
    const connection = ctx.connection;
    if (!connection) return undefined;
    const clientId = connection.state.clientId?.trim() || undefined;
    const platform = connection.state.clientPlatform?.trim() || undefined;
    const origin: Extract<InteractionOrigin, { kind: "client" }> = {
      kind: "client",
      connectionId: connection.id,
    };
    if (clientId) origin.clientId = clientId;
    if (platform) origin.platform = platform;
    return origin;
  }

  return undefined;
}

function processInteractionOrigin(sourcePid: string, uid?: number): InteractionOrigin {
  const origin: Extract<InteractionOrigin, { kind: "process" }> = {
    kind: "process",
    sourcePid,
  };
  if (uid !== undefined && Number.isFinite(uid)) origin.uid = uid;
  return origin;
}

export async function handleProcIpcSend(
  args: ProcIpcSendArgs,
  ctx: KernelContext,
): Promise<ProcIpcSendResult> {
  const resolved = resolveSameOwnerIpc(args, ctx, "proc.ipc.send");
  if (!resolved.ok) return resolved;
  const runId = crypto.randomUUID();

  const response = await sendFrameToProcess(ctx.installationId, resolved.args.pid, {
    type: "req",
    id: crypto.randomUUID(),
    call: "proc.ipc.deliver",
    args: {
      runId,
      sourcePid: resolved.sourcePid,
      source: requirePrincipal(ctx).account,
      message: resolved.args.message,
      metadata: resolved.args.metadata,
      origin: processInteractionOrigin(resolved.sourcePid, resolved.source.uid),
      sentAt: Date.now(),
    },
  });

  if (response && response.type === "res") {
    if (!response.ok) {
      return { ok: false, error: response.error.message };
    }
    // SAFETY: this response corresponds to the proc.ipc.deliver request above.
    const delivered = response.data as ProcIpcDeliverResult | undefined;
    if (!delivered) {
      return { ok: false, error: "proc.ipc.deliver returned no data" };
    }
    if (delivered.ok && delivered.runId !== runId) {
      return { ok: false, error: "proc.ipc.deliver returned an unexpected runId" };
    }
    return delivered;
  }

  return { ok: false, error: "proc.ipc.deliver did not return a response" };
}

export async function handleProcIpcCall(
  args: ProcIpcCallArgs,
  ctx: KernelContext,
  options: {
    superviseAfterTimeout?: boolean;
    responsibilityId?: string;
    onSupervisionScheduled?: (deadlineAt: number) => Promise<void>;
  } = {},
): Promise<ProcIpcCallResult> {
  const resolved = resolveSameOwnerIpc(args, ctx, "proc.ipc.call");
  if (!resolved.ok) return resolved;
  const timeoutMs = resolveIpcCallTimeoutMs(args.timeoutMs);
  const deadlineAt = Date.now() + timeoutMs;
  const callId = crypto.randomUUID();
  const runId = crypto.randomUUID();

  ctx.ipcCalls.create({
    callId,
    uid: resolved.source.ownerUid,
    sourcePid: resolved.sourcePid,
    sourceRunId: ctx.processRunId ?? null,
    targetPid: resolved.args.pid,
    targetRunId: runId,
    deadlineAt,
    supervised: options.superviseAfterTimeout === true,
    responsibilityId: options.responsibilityId,
  });

  try {
    if (options.superviseAfterTimeout) {
      await ctx.scheduleIpcCallTimeout(callId, deadlineAt, {
        mode: "supervise",
        intervalMs: timeoutMs,
        checkInCount: 0,
      });
      await options.onSupervisionScheduled?.(deadlineAt);
    } else {
      await ctx.scheduleIpcCallTimeout(callId, deadlineAt);
    }
  } catch (error) {
    ctx.ipcCalls.remove(callId);
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const deliverCall: NonNullable<ProcIpcDeliverArgs["call"]> = {
    callId,
    deadlineAt,
  };
  if (options.superviseAfterTimeout) deliverCall.supervised = true;

  let response: Awaited<ReturnType<typeof sendFrameToProcess>>;
  try {
    response = await sendFrameToProcess(ctx.installationId, resolved.args.pid, {
      type: "req",
      id: crypto.randomUUID(),
      call: "proc.ipc.deliver",
      args: {
        runId,
        sourcePid: resolved.sourcePid,
        source: requirePrincipal(ctx).account,
        message: resolved.args.message,
        metadata: resolved.args.metadata,
        origin: processInteractionOrigin(resolved.sourcePid, resolved.source.uid),
        sentAt: Date.now(),
        call: deliverCall,
      },
    });
  } catch (error) {
    ctx.ipcCalls.remove(callId);
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  if (!response || response.type !== "res") {
    ctx.ipcCalls.remove(callId);
    return { ok: false, error: "proc.ipc.deliver did not return a response" };
  }
  if (!response.ok) {
    ctx.ipcCalls.remove(callId);
    return { ok: false, error: response.error.message };
  }

  // SAFETY: this response corresponds to the proc.ipc.deliver request above.
  const delivered = response.data as ProcIpcDeliverResult | undefined;
  if (!delivered) {
    ctx.ipcCalls.remove(callId);
    return { ok: false, error: "proc.ipc.deliver returned no data" };
  }
  if (!delivered.ok) {
    ctx.ipcCalls.remove(callId);
    return delivered;
  }
  if (delivered.runId !== runId) {
    ctx.ipcCalls.remove(callId);
    return { ok: false, error: "proc.ipc.deliver returned an unexpected runId" };
  }

  const call = ctx.ipcCalls.get(callId);
  if (
    call?.status === "timed_out"
    || (!options.superviseAfterTimeout && Date.now() >= deadlineAt)
  ) {
    return {
      ok: false,
      error: call?.error ?? "IPC call timed out",
    };
  }

  const result: Extract<ProcIpcCallResult, { ok: true }> = {
    ok: true,
    status: "started",
    callId,
    pid: delivered.pid,
    sourcePid: resolved.sourcePid,
    runId,
    deadlineAt,
  };
  if (delivered.queued) result.queued = true;
  return result;
}

/**
 * Forward a proc.* request to the target Process DO.
 *
 * Resolves the target pid (defaults to the calling process),
 * verifies ownership, and delivers via recvFrame RPC.
 */
export async function forwardToProcess(
  frame: RequestFrame,
  ctx: KernelContext,
): Promise<ForwardedProcessResult> {
  const identity = principalOf(ctx)!;
  const callerOwnerUid = resolveCallerOwnerUid(ctx);
  // SAFETY: dispatch routes only Process-targeting calls here, whose syscall
  // arguments all use the shared optional `pid` target field.
  const args = frame.args as { pid?: string };
  // A process can omit its own pid. External callers must select one explicitly.
  const pid = args.pid ?? ctx.processId;
  if (!pid) {
    throw new Error(`${frame.call} requires pid outside a process`);
  }

  const proc = ctx.procs.get(pid);
  if (!proc) {
    throw new Error(`Process not found: ${pid}`);
  }

  if (proc.ownerUid !== callerOwnerUid && identity.account.uid !== 0) {
    throw new Error(`Permission denied: cannot access process ${pid}`);
  }

  const processFrame = frame.call === "proc.send"
    ? withProcSendOrigin(frame, ctx)
    : frame.call === "proc.ai.config.set"
      ? withValidatedProcAiConfig(frame, ctx, proc.ownerUid)
      : frame;
  if (frame.call === "proc.kill" && proc.isPersonalController) {
    invalidatePersonalControllerReadiness(proc.ownerUid, pid, ctx.procs);
  }
  const responsePromise = sendFrameToProcess(ctx.installationId, pid, processFrame);
  let cancellation: Promise<unknown> | undefined;
  const signal = frame.call === "codemode.run" || frame.call === "proc.history.compact"
    ? ctx.requestSignal
    : undefined;
  let response: Awaited<ReturnType<typeof sendFrameToProcess>>;
  try {
    response = await raceWithAbort(responsePromise, signal, {
      abortReason: () => signal?.reason ?? new Error("Request cancelled"),
      onAbort: () => {
        const reason = signal?.reason instanceof Error
          ? signal.reason.message
          : "Request cancelled";
        cancellation = sendFrameToProcess(ctx.installationId, pid, {
          type: "sig",
          signal: REQUEST_CANCEL_SIGNAL,
          payload: { id: frame.id, reason },
        });
      },
      onLateResolve: (late) => {
        if (late?.type === "res" && late.ok && late.body && !late.body.stream.locked) {
          void late.body.stream.cancel("Request was cancelled");
        }
      },
    });
  } catch (error) {
    await cancellation?.catch(() => {});
    throw error;
  }

  if (response && response.type === "res") {
    if (response.ok) {
      if (frame.call === "proc.reset" || frame.call === "proc.kill") {
        ctx.ipcCalls.cancelBySourcePid({ uid: proc.ownerUid, sourcePid: pid });
      }
      if (frame.call === "proc.reset") {
        ctx.runRoutes.clearForProcess(pid);
        ctx.failIpcCallsByTarget(
          proc.ownerUid,
          pid,
          "Target process was reset",
        );
      } else if (frame.call === "proc.kill") {
        reconcileKilledProcess(proc.ownerUid, pid, ctx);
      }
      const responseData = response.data;
      // SAFETY: the Process response preserves the request syscall; this branch
      // reads proc.send data only when the originating call is proc.send.
      const runData = responseData as ResultOf<"proc.send"> | undefined;
      if (
        frame.call === "proc.send"
        && identity.kind === "human"
        && ctx.connection
        && runData?.ok
      ) {
        ctx.runRoutes.setConnectionRoute({
          runId: runData.runId,
          processId: pid,
          uid: proc.ownerUid,
          connectionId: ctx.connection.id,
        });
      }
      const result: ForwardedProcessResult = {
        data: responseData,
      };
      if (response.body !== undefined) result.body = response.body;
      return result;
    } else {
      if (frame.call === "proc.kill" && response.error.code === 410) {
        ctx.ipcCalls.cancelBySourcePid({ uid: proc.ownerUid, sourcePid: pid });
        reconcileKilledProcess(proc.ownerUid, pid, ctx);
      }
      throw new Error(response.error.message);
    }
  }

  // SAFETY: non-response delivery acknowledgements use the common successful
  // syscall result prefix and carry no syscall-specific fields.
  return {
    data: { ok: true, status: "delivered" } as ResultOf<SyscallName>,
  };
}

function reconcileKilledProcess(
  ownerUid: number,
  pid: string,
  ctx: KernelContext,
): void {
  ctx.failIpcCallsByTarget(ownerUid, pid, "Target process was killed");
  const reclaimed = ctx.responsibilities.reclaimProcessAssignments({
    ownerUid,
    processId: pid,
    now: Date.now(),
  });
  ctx.runRoutes.clearForProcess(pid);
  ctx.procs.kill(pid);
  if (reclaimed.length > 0) {
    ctx.defer(ctx.reconcileResponsibilityWake(ownerUid).catch((error) => {
      console.warn(
        `[Kernel] Failed to schedule responsibility recovery after killing ${pid}:`,
        error,
      );
    }));
  }
}

function withValidatedProcAiConfig(
  frame: RequestFrame<"proc.ai.config.set">,
  ctx: KernelContext,
  ownerUid: number,
): RequestFrame<"proc.ai.config.set"> {
  const args: ProcAiConfigSetArgs = frame.args;
  if ("clear" in args || args.modelId === undefined || args.modelId === null) {
    return frame;
  }

  const modelId = normalizeText(args.modelId).toLowerCase();
  if (!modelId) {
    return frame;
  }
  // Validate against the same layered stack generation and ai.models use, so
  // shared and base models are as selectable for a process as personal ones.
  const storedModel = resolveEffectiveAiModelStack(ctx, ownerUid)
    .find((item) => item.entry.id.toLowerCase() === modelId)?.entry;
  if (!storedModel) {
    throw new Error(`AI model not found: ${modelId}`);
  }

  return {
    ...frame,
    args: {
      ...args,
      modelId: storedModel.id,
    },
  };
}

function normalizeText(value: string | undefined): string {
  return value?.trim() ?? "";
}

type NormalizedIpcSendArgs =
  | {
      ok: true;
      pid: string;
      message: string;
      metadata?: JsonObject;
    }
  | { ok: false; error: string };

type ResolvedSameOwnerIpc =
  | {
      ok: true;
      sourcePid: string;
      source: { uid: number; ownerUid: number };
      target: { uid: number; ownerUid: number };
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

  if (source.uid !== requirePrincipal(ctx).account.uid) {
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
  const pid = normalizeRequiredString(args.pid);
  if (!pid) {
    return { ok: false, error: `${syscall} requires pid` };
  }

  const message = normalizeRequiredString(args.message);
  if (!message) {
    return { ok: false, error: `${syscall} requires message` };
  }

  const normalized: Extract<NormalizedIpcSendArgs, { ok: true }> = {
    ok: true,
    pid,
    message,
  };
  if (args.metadata !== undefined) normalized.metadata = args.metadata;
  return normalized;
}

export function resolveIpcCallTimeoutMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_IPC_CALL_TIMEOUT_MS;
  }
  return Math.max(
    MIN_IPC_CALL_TIMEOUT_MS,
    Math.min(MAX_IPC_CALL_TIMEOUT_MS, Math.trunc(value)),
  );
}

function normalizeRequiredString(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized || null;
}

function resolveSpawnCwd(
  cwd: string | undefined,
  baseIdentity: ProcessIdentity,
): string {
  const normalized = cwd?.trim();
  if (normalized) {
    return resolveUserPath(normalized, baseIdentity.home, baseIdentity.cwd);
  }
  return baseIdentity.cwd;
}

/** Toggles raw Process observation for the connected peer that admitted the request. */
export function handleProcObserve(
  frame: RequestFrame<"proc.observe" | "proc.unobserve">,
  ctx: KernelContext,
): ResponseFrame<"proc.observe" | "proc.unobserve"> {
  const connection = ctx.connection;
  const state = connection?.state;
  if (!connection || state?.step !== "connected" || !state.peer) {
    return {
      type: "res",
      id: frame.id,
      ok: false,
      error: { code: 400, message: "Process observation requires a connected peer" },
    };
  }
  const pid = frame.args.pid.trim();
  const process = pid ? ctx.procs.get(pid) : null;
  if (!process || process.ownerUid !== state.peer.principal.account.uid) {
    return {
      type: "res",
      id: frame.id,
      ok: false,
      error: { code: 404, message: `Process not found: ${pid || "(missing)"}` },
    };
  }
  const observing = frame.call === "proc.observe";
  const observed = new Set(state.observedProcessIds ?? []);
  if (observing) observed.add(pid);
  else observed.delete(pid);
  connection.setState({ ...state, observedProcessIds: [...observed] });
  return { type: "res", id: frame.id, ok: true, data: { ok: true, pid, observing } };
}
