import type { ProcAbortResult, ProcScopeGetArgs, ProcScopeGetResult, ProcScopeRevokeArgs, ProcScopeRevokeResult } from "@humansandmachines/gsv/protocol";
import { principalOf, resolveCallerOwnerUid, type KernelContext } from "./context";
import { assertScopedProcess } from "./process-scope";
import { sendFrameToProcess } from "../shared/utils";
import { notifyProcessChanged } from "./process-notifications";

export function handleProcScopeGet(args: ProcScopeGetArgs, ctx: KernelContext): ProcScopeGetResult {
  const process = ctx.procs.get(args.pid);
  if (!process || process.ownerUid !== resolveCallerOwnerUid(ctx)) throw new Error("Process not found");
  assertScopedProcess(ctx, args.pid);
  return { scope: ctx.procs.scopes.forProcess(args.pid) };
}

export async function handleProcScopeRevoke(args: ProcScopeRevokeArgs, ctx: KernelContext): Promise<ProcScopeRevokeResult> {
  if (ctx.processId || principalOf(ctx)?.kind !== "human" || ctx.peer?.provenance.kind !== "credential") throw new Error("Revoking a helper requires a signed-in human");
  const current = handleProcScopeGet({ pid: args.pid }, ctx).scope;
  if (!current) throw new Error("Process has no scope");
  const scope = ctx.federation.transaction(() => ctx.procs.scopes.revoke(current.id, resolveCallerOwnerUid(ctx), args.expectedRevision));
  await ctx.scheduleProcessScopeExpiry(scope.id, Date.now());
  await stopScopedProcesses(scope.id, ctx);
  return { scope };
}

export async function stopScopedProcesses(scopeId: string, ctx: KernelContext): Promise<void> {
  const scope = ctx.procs.scopes.get(scopeId);
  if (!scope || scope.state === "active") return;
  const members = ctx.procs.scopes.members(scopeId);
  const stopped = await Promise.allSettled(members.map(async (pid) => {
    const response = await sendFrameToProcess(ctx.installationId, pid, { type: "req", id: crypto.randomUUID(), call: "proc.abort", args: { pid } });
    if (!ctx.procs.get(pid)) return;
    if (!response || response.type !== "res" || !response.ok) throw new Error("Helper cancellation did not complete");
    // SAFETY: this is the result of the proc.abort request sent immediately above.
    const result = response.data as ProcAbortResult | undefined;
    if (!result?.ok) throw new Error("Helper cancellation did not complete");
    notifyProcessChanged(ctx, pid, ["state"]);
  }));
  if (stopped.some((result) => result.status === "rejected")) throw new Error("Helper access is revoked; cancellation will retry");
}
