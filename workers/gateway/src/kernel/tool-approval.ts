import { REQUEST_CANCEL_SIGNAL, type JsonObject } from "@humansandmachines/gsv/protocol";
import type { KernelContext } from "./context";
import type { SyscallName } from "../syscalls";
import type { ProcessToolOwner } from "../protocol/process-frames";
import { sendFrameToProcess } from "../shared/utils";
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
  defaultAction?: "ask",
  send: typeof sendFrameToProcess = sendFrameToProcess,
): Promise<void> {
  if (!ctx.toolOwner) return;
  if (!ctx.processId) throw new Error("Agent operation has no owning process");
  const signal = ctx.requestSignal;
  signal?.throwIfAborted();
  const id = `approval:${crypto.randomUUID()}`;
  let cancellation: Promise<unknown> | undefined;
  try {
    const response = await raceWithAbort(send(ctx.installationId, ctx.processId, {
      type: "req", id, call: "proc.tool.authorize", args: { ...ctx.toolOwner, syscall, args, defaultAction },
    }), signal, {
      onAbort: () => {
        cancellation = send(ctx.installationId, ctx.processId!, {
          type: "sig", signal: REQUEST_CANCEL_SIGNAL,
          payload: { id, reason: "Owning operation was cancelled" },
        });
      },
    });
    signal?.throwIfAborted();
    if (!response?.ok) throw new Error(response?.error.message ?? "Approval owner is unavailable");
    if (!response.data.approved) throw new Error(`Tool execution was not approved: ${syscall}`);
  } finally {
    await cancellation?.catch(() => {});
  }
}
