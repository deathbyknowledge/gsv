import type { SysFeedbackArgs, SysFeedbackResult } from "@humansandmachines/gsv/protocol";
import { feedbackArgsSchema } from "@humansandmachines/gsv/services/feedback";
import { raceWithAbort } from "../../shared/abort";
import { resolveCallerOwnerUid, type KernelContext } from "../context";
import { authorizeNestedOperation } from "../tool-approval";

export async function handleSysFeedback(args: SysFeedbackArgs, ctx: KernelContext): Promise<SysFeedbackResult> {
  const input = feedbackArgsSchema.safeParse(args);
  if (!input.success) throw new Error("Invalid feedback report");
  if (!ctx.env.FEEDBACK) throw new Error("Feedback is not available for this space");
  await authorizeNestedOperation(ctx, "sys.feedback", input.data);
  ctx.requestSignal?.throwIfAborted();
  const id = input.data.id ?? crypto.randomUUID();
  const pending = ctx.env.FEEDBACK.submitFeedback({
    ...input.data,
    id,
    installationId: ctx.installationId,
    space: ctx.installationIdentity?.canonicalOrigin ?? null,
    ownerUid: resolveCallerOwnerUid(ctx),
    source: ctx.processId ? "agent" : "client",
    serverVersion: ctx.serverVersion,
  });
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new Error("Feedback delivery timed out")), 10_000);
  const signal = ctx.requestSignal ? AbortSignal.any([ctx.requestSignal, deadline.signal]) : deadline.signal;
  try {
    const receipt = await raceWithAbort(pending, signal, { onAbort: () => {
      // SAFETY: Workers RPC promises expose disposal to cancel the remote call.
      const rpc = pending as typeof pending & Partial<Disposable>;
      try { rpc[Symbol.dispose]?.(); } catch { /* Cancellation remains terminal. */ }
    } });
    if (!receipt || receipt.id !== id) throw new Error("Invalid feedback receipt");
    return { id };
  } finally {
    clearTimeout(timer);
  }
}
