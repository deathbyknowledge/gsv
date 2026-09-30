import type { SysFeedbackArgs, SysFeedbackResult } from "@humansandmachines/gsv/protocol";
import { feedbackArgsSchema } from "@humansandmachines/gsv/services/feedback";
import { resolveCallerOwnerUid, type KernelContext } from "../context";
import { authorizeNestedOperation } from "../tool-approval";

export async function handleSysFeedback(args: SysFeedbackArgs, ctx: KernelContext): Promise<SysFeedbackResult> {
  const input = feedbackArgsSchema.safeParse(args);
  if (!input.success) throw new Error("Invalid feedback report");
  if (!ctx.env.FEEDBACK) throw new Error("Feedback is not available for this space");
  await authorizeNestedOperation(ctx, "sys.feedback", input.data);
  ctx.requestSignal?.throwIfAborted();
  return ctx.env.FEEDBACK.submitFeedback({
    ...input.data,
    id: input.data.id ?? crypto.randomUUID(),
    installationId: ctx.installationId,
    space: ctx.installationIdentity?.canonicalOrigin ?? null,
    ownerUid: resolveCallerOwnerUid(ctx),
    source: ctx.processId ? "agent" : "client",
    serverVersion: ctx.serverVersion,
  });
}
