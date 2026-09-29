import type { KernelContext } from "./context";

type ProcessNotifications = Pick<KernelContext, "procs" | "broadcastToUserUid">;

/** Publish only committed registry state, independently of raw Process observation. */
export function notifyProcessChanged(ctx: ProcessNotifications, pid: string, changes: string[]): void {
  const process = ctx.procs.get(pid);
  if (!process) return;
  ctx.broadcastToUserUid(process.ownerUid, "proc.changed", {
    pid,
    changes,
    runtime: {
      state: process.state,
      activeRunId: process.activeRunId,
      queuedCount: process.queuedCount,
      lastActiveAt: process.lastActiveAt,
    },
  });
}

/** Remove an already-terminated Process from the registry and the owner's live lists. */
export function unregisterProcess(ctx: ProcessNotifications, pid: string): void {
  const process = ctx.procs.get(pid);
  const removed = ctx.procs.kill(pid);
  if (removed && process) ctx.broadcastToUserUid(process.ownerUid, "process.exit", { pid });
}
