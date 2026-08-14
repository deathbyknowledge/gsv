import type { ProcessIdentity } from "@humansandmachines/gsv/protocol";
import type { RequestFrame, ResponseFrame } from "../protocol/frames";
import { sendFrameToProcess } from "../shared/utils";
import { accountIdentity } from "./accounts";
import { ensurePersonalAgent } from "./agents";
import type { KernelContext } from "./context";
import type { ProcessRecord, ProcessRegistry } from "./processes";

type ControllerState = {
  readyByOwner: Map<number, string>;
  pendingByOwner: Map<number, Promise<string>>;
};

const controllerStates = new WeakMap<ProcessRegistry, ControllerState>();

class DeadControllerError extends Error {}

export function ensurePersonalController(
  ownerUid: number,
  ctx: KernelContext,
  preferredAgentName?: string,
): Promise<string> {
  const state = stateFor(ctx.procs);
  const readyPid = state.readyByOwner.get(ownerUid);
  if (readyPid) {
    const current = ctx.procs.getPersonalController(ownerUid);
    if (current?.processId === readyPid) {
      return Promise.resolve(readyPid);
    }
    state.readyByOwner.delete(ownerUid);
  }

  const pending = state.pendingByOwner.get(ownerUid);
  if (pending) {
    return pending;
  }

  const task = ensureColdPersonalController(
    ownerUid,
    ctx,
    state,
    preferredAgentName,
  ).finally(() => {
    if (state.pendingByOwner.get(ownerUid) === task) {
      state.pendingByOwner.delete(ownerUid);
    }
  });
  state.pendingByOwner.set(ownerUid, task);
  return task;
}

export function invalidatePersonalControllerReadiness(
  ownerUid: number,
  processId: string,
  procs: ProcessRegistry,
): void {
  const state = controllerStates.get(procs);
  if (state?.readyByOwner.get(ownerUid) === processId) {
    state.readyByOwner.delete(ownerUid);
  }
}

async function ensureColdPersonalController(
  ownerUid: number,
  ctx: KernelContext,
  state: ControllerState,
  preferredAgentName?: string,
): Promise<string> {
  const owner = ctx.auth.getPasswdByUid(ownerUid);
  if (!owner || owner.uid < 1000 || ctx.auth.isPersonalAgentUid(owner.uid)) {
    throw new Error(`Personal controller owner does not exist: uid=${ownerUid}`);
  }

  const humanIdentity = accountIdentity(ctx.auth, owner);
  const controllerIdentity = (
    await ensurePersonalAgent(ctx, humanIdentity, preferredAgentName)
  ).identity;
  let current = ctx.procs.getPersonalController(ownerUid);

  if (current && (!current.interactive || current.parentPid !== null)) {
    ctx.procs.clearPersonalController(current.processId);
    current = null;
  }

  if (current) {
    const identity = recoveredIdentity(current, controllerIdentity);
    try {
      await initializePersonalController(current.processId, identity);
      ctx.procs.updateIdentity(current.processId, identity);
      state.readyByOwner.set(ownerUid, current.processId);
      return current.processId;
    } catch (error) {
      if (!(error instanceof DeadControllerError)) {
        throw error;
      }
      await rollbackPersonalController(current.processId, ctx);
    }
  }

  return spawnPersonalController(ownerUid, controllerIdentity, ctx, state);
}

function recoveredIdentity(
  current: ProcessRecord,
  identity: ProcessIdentity,
): ProcessIdentity {
  if (current.cwd === current.home) {
    return { ...identity, cwd: identity.home };
  }
  const currentPrefix = current.home.endsWith("/")
    ? current.home
    : `${current.home}/`;
  if (!current.cwd.startsWith(currentPrefix)) {
    return { ...identity, cwd: current.cwd };
  }
  const nextPrefix = identity.home.endsWith("/")
    ? identity.home
    : `${identity.home}/`;
  return {
    ...identity,
    cwd: `${nextPrefix}${current.cwd.slice(currentPrefix.length)}`.replace(/\/+$/, ""),
  };
}

async function spawnPersonalController(
  ownerUid: number,
  identity: ProcessIdentity,
  ctx: KernelContext,
  state: ControllerState,
): Promise<string> {
  const pid = `proc:${crypto.randomUUID()}`;
  ctx.procs.spawn(pid, identity, {
    ownerUid,
    interactive: true,
    isPersonalController: true,
    cwd: identity.cwd,
  });

  try {
    await initializePersonalController(pid, identity);
  } catch (error) {
    try {
      await rollbackPersonalController(pid, ctx);
    } catch (rollbackError) {
      throw new Error(
        `Failed to initialize personal controller: ${formatError(error)}; `
        + `rollback failed: ${formatError(rollbackError)}`,
      );
    }
    throw new Error(`Failed to initialize personal controller: ${formatError(error)}`);
  }

  state.readyByOwner.set(ownerUid, pid);
  return pid;
}

async function initializePersonalController(
  pid: string,
  identity: ProcessIdentity,
): Promise<void> {
  const request: RequestFrame<"proc.setidentity"> = {
    type: "req",
    id: crypto.randomUUID(),
    call: "proc.setidentity",
    args: {
      pid,
      identity,
      interactive: true,
      autoTitle: false,
    },
  };
  const response = await sendFrameToProcess(pid, request) as ResponseFrame<"proc.setidentity"> | null;
  if (!response || response.type !== "res" || response.id !== request.id) {
    throw new Error("Personal controller initialization returned no valid response");
  }
  if (!response.ok) {
    if (response.error.code === 410) {
      throw new DeadControllerError(response.error.message);
    }
    throw new Error(response.error.message);
  }
  if (response.data?.ok !== true) {
    throw new Error("Personal controller rejected initialization");
  }
}

async function rollbackPersonalController(
  pid: string,
  ctx: KernelContext,
): Promise<void> {
  const request: RequestFrame<"proc.kill"> = {
    type: "req",
    id: crypto.randomUUID(),
    call: "proc.kill",
    args: { pid, archive: false },
  };
  const response = await sendFrameToProcess(pid, request) as ResponseFrame<"proc.kill"> | null;
  if (!response || response.type !== "res" || response.id !== request.id) {
    throw new Error("proc.kill returned no valid response");
  }
  if (!response.ok) {
    if (response.error.code === 410) {
      ctx.procs.kill(pid);
      return;
    }
    throw new Error(response.error.message);
  }
  if (response.data?.ok !== true) {
    throw new Error("proc.kill rejected rollback");
  }
  ctx.procs.kill(pid);
}

function stateFor(procs: ProcessRegistry): ControllerState {
  let state = controllerStates.get(procs);
  if (!state) {
    state = {
      readyByOwner: new Map(),
      pendingByOwner: new Map(),
    };
    controllerStates.set(procs, state);
  }
  return state;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
