import type { ProcessMemoryReview } from "../protocol/process-frames";
import type { KernelContext } from "./context";
import reviewInstructions from "../prompts/tasks/memory-review.md";

/** Admit one ordinary review at a time; the responsibility is its durable receipt. */
export async function admitMemoryReview(
  processId: string,
  review: ProcessMemoryReview,
  ctx: Pick<KernelContext, "procs" | "auth" | "responsibilities" | "responsibilitySources" | "reconcileResponsibilityWake">,
): Promise<boolean> {
  const process = ctx.procs.get(processId);
  if (!process?.isPersonalController || ctx.auth.isAccountDisabled(process.ownerUid)
    || !ctx.responsibilitySources.isEnabled(process.ownerUid, "memory.review")) return true;
  const dedupeKey = `memory.review:${processId}:${review.segmentId}`;
  const existing = ctx.responsibilities.getByDedupeKey(process.ownerUid, dedupeKey);
  if (!existing) {
    if (ctx.responsibilities.listActiveByDedupeKeyPrefix(process.ownerUid, "memory.review:").length) return false;
    ctx.responsibilities.create({
      ownerUid: process.ownerUid,
      title: "Preserve useful personal memory",
      details: {
        instructions: reviewInstructions,
        sourceProcessId: processId,
        ...review,
      },
      source: { kind: "system", component: "memory-review" },
      assignee: { kind: "ship" },
      state: "open",
      priority: "low",
      dedupeKey,
      actor: { kind: "system", component: "memory-review" },
      observedByShip: false,
      now: Date.now(),
    });
  }
  await ctx.reconcileResponsibilityWake?.(process.ownerUid);
  return true;
}
