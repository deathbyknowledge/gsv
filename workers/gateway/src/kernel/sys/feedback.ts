import { bodyToText, cancelBinaryBody, type BinaryBody, type SysFeedbackArgs, type SysFeedbackResult } from "@humansandmachines/gsv/protocol";
import { feedbackArgsSchema, feedbackContentSchema, FEEDBACK_MAX_BODY_BYTES, type FeedbackContent } from "@humansandmachines/gsv/services/feedback";
import { raceWithAbort } from "../../shared/abort";
import { resolveCallerOwnerUid, type KernelContext } from "../context";
import { authorizeNestedOperation } from "../tool-approval";

export async function handleSysFeedback(args: SysFeedbackArgs, ctx: KernelContext, body?: BinaryBody): Promise<SysFeedbackResult> {
  try {
    const input = feedbackArgsSchema.safeParse(args);
    if (!input.success) throw new Error("Invalid feedback report");
    if (!ctx.env.FEEDBACK) throw new Error("Feedback is not available for this space");
    if (!body) throw new Error("Feedback requires a report body");
    await authorizeNestedOperation(ctx, "sys.feedback", input.data);
    ctx.requestSignal?.throwIfAborted();
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new Error("Feedback delivery timed out")), 10_000);
    const signal = ctx.requestSignal ? AbortSignal.any([ctx.requestSignal, deadline.signal]) : deadline.signal;
    try {
      const text = await bodyToText(body, FEEDBACK_MAX_BODY_BYTES, signal);
      let content: FeedbackContent;
      try { content = feedbackContentSchema.parse(JSON.parse(text)); }
      catch { throw new Error("Invalid feedback report"); }
      signal.throwIfAborted();
      const id = input.data.id ?? crypto.randomUUID();
      let receiptId: unknown;
      try {
        const pending = ctx.env.FEEDBACK.submitFeedback({
          ...input.data, ...content, id,
          installationId: ctx.installationId,
          space: ctx.installationIdentity?.canonicalOrigin ?? null,
          ownerUid: resolveCallerOwnerUid(ctx),
          source: ctx.processId ? "agent" : "client",
          serverVersion: ctx.serverVersion,
        });
        const receipt = await raceWithAbort(pending, signal, { onAbort: () => {
          // SAFETY: Workers RPC promises expose disposal to cancel the remote call.
          const rpc = pending as typeof pending & Partial<Disposable>;
          try { rpc[Symbol.dispose]?.(); } catch { /* Cancellation remains terminal. */ }
        } });
        receiptId = receipt?.id;
      } catch {
        signal.throwIfAborted();
        throw new Error("Feedback delivery failed");
      }
      if (receiptId !== id) throw new Error("Invalid feedback receipt");
      return { id };
    } finally {
      clearTimeout(timer);
    }
  } finally {
    await cancelBinaryBody(body, "Feedback request finished");
  }
}
