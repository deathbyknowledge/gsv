import { REQUEST_CANCEL_SIGNAL, type JsonObject } from "@humansandmachines/gsv/protocol";
import type { KernelContext } from "./context";
import type { SyscallName } from "../syscalls";
import { processResult, type ProcessApprovalTarget, type ProcessToolOwner } from "../protocol/process-frames";
import { authorizeProcessTool, sendFrameToProcess } from "../shared/utils";
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
  authorize: typeof authorizeProcessTool = authorizeProcessTool,
  target?: ProcessApprovalTarget,
): Promise<void> {
  if (!ctx.toolOwner) return;
  if (!ctx.processId) throw new Error("Agent operation has no owning process");
  const signal = ctx.requestSignal;
  signal?.throwIfAborted();
  const id = `approval:${crypto.randomUUID()}`;
  const releaseDeadlines = ctx.executionDeadlines?.hold();
  let response;
  try {
    response = await raceWithAbort(authorize(ctx.installationId, ctx.processId, id, {
      ...ctx.toolOwner, syscall, args, target,
    }), signal, {
      onAbort: () => {
        ctx.defer(sendFrameToProcess(ctx.installationId, ctx.processId!, {
          type: "sig", signal: REQUEST_CANCEL_SIGNAL,
          payload: { id, reason: "Owning operation was cancelled" },
        }).catch(() => {}));
      },
    });
  } finally {
    releaseDeadlines?.();
  }
  signal?.throwIfAborted();
  if (!processResult(response).approved) throw new Error(`Tool execution was not approved: ${syscall}`);
}
