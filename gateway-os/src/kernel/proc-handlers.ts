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
  ProcSpawnArgs,
  ProcSpawnResult,
} from "../syscalls/proc";
import { sendFrameToProcess } from "../shared/utils";

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
    parentPid: r.parentPid,
    state: r.state,
    label: r.label,
    createdAt: r.createdAt,
  }));

  return { processes };
}

export async function handleProcSpawn(
  args: ProcSpawnArgs,
  ctx: KernelContext,
): Promise<ProcSpawnResult> {
  const identity = ctx.identity!;
  const pid = crypto.randomUUID();

  const parentPid = args.parentPid ?? `init:${identity.process.uid}`;

  if (parentPid !== `init:${identity.process.uid}`) {
    const parent = ctx.procs.get(parentPid);
    if (!parent || parent.uid !== identity.process.uid) {
      if (identity.process.uid !== 0) {
        return { ok: false, error: `Cannot spawn under foreign process: ${parentPid}` };
      }
    }
  }

  ctx.procs.spawn(pid, identity.process, {
    parentPid,
    label: args.label,
  });

  await sendFrameToProcess(pid, {
    type: "req",
    id: crypto.randomUUID(),
    call: "proc.setidentity",
    args: { pid, identity: identity.process },
  });

  if (args.prompt) {
    await sendFrameToProcess(pid, {
      type: "req",
      id: crypto.randomUUID(),
      call: "proc.send",
      args: { pid, message: args.prompt },
    });
  }

  return { ok: true, pid, label: args.label };
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
