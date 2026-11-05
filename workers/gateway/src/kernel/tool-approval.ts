import type { JsonObject } from "@humansandmachines/gsv/protocol";
import type { KernelContext } from "./context";
import type { SyscallName } from "../syscalls";
import { processResult, type ProcessApprovalTarget, type ProcessToolOwner } from "../protocol/process-frames";
import { authorizeProcessTool, cancelProcessCall } from "../shared/utils";
import { raceWithAbort } from "../shared/abort";

export function nestedToolOwner(ctx: KernelContext): ProcessToolOwner | undefined {
  if (ctx.toolOwner) return ctx.toolOwner;
  if (!ctx.processId || !ctx.processRunId) return undefined;
  if (!ctx.requestId) throw new Error("Agent operation has no owning request");
  return { runId: ctx.processRunId, requestId: ctx.requestId };
}

/** The Process retains its run policy and approval lifecycle; the Kernel owns actual dispatch. */
export async function authorizeNestedOperation(
  ctx: KernelContext,
  syscall: SyscallName,
  args: JsonObject,
  target?: ProcessApprovalTarget,
): Promise<void> {
  if (!ctx.toolOwner) return;
  if (!ctx.processId) throw new Error("Agent operation has no owning process");
  const signal = ctx.requestSignal;
  signal?.throwIfAborted();
  const cancelId = `approval:${crypto.randomUUID()}`;
  const releaseDeadlines = ctx.executionDeadlines?.hold();
  let response;
  try {
    response = await raceWithAbort(authorizeProcessTool(ctx.installationId, ctx.processId, cancelId, {
      ...ctx.toolOwner, syscall, args, target,
    }), signal, {
      onAbort: () => {
        ctx.defer(cancelProcessCall(ctx.installationId, ctx.processId!, cancelId, "Owning operation was cancelled").catch(() => {}));
      },
    });
  } finally {
    releaseDeadlines?.();
  }
  signal?.throwIfAborted();
  if (!processResult(response).approved) throw new Error(`Tool execution was not approved: ${syscall}`);
}
