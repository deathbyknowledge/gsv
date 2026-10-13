import { z } from "zod";
import { emitTelemetry } from "@humansandmachines/gsv/telemetry";
import { processMemoryReviewSchema, type ProcessMemoryReview } from "../protocol/process-frames";
import type { Kernel } from "./do";
import type { KernelContext } from "./context";
import reviewInstructions from "../prompts/tasks/memory-review.md";

const memoryReviewSourceSchema = processMemoryReviewSchema.extend({
  sourceProcessId: z.string(),
});
type MemoryReviewSource = z.infer<typeof memoryReviewSourceSchema>;

function queuedReviews(host: Kernel, ownerUid: number): MemoryReviewSource[] {
  return z.array(memoryReviewSourceSchema).parse(host.ctx.storage.kv.get(`memory-reviews:${ownerUid}`) ?? []);
}

export async function queueMemoryReview(host: Kernel, processId: string, review: ProcessMemoryReview): Promise<void> {
  const process = host.procs.get(processId);
  if (!process?.isPersonalController || host.auth.isAccountDisabled(process.ownerUid)
    || !host.responsibilitySources.isEnabled(process.ownerUid, "memory.review")) return;
  const ownerUid = process.ownerUid;
  host.ctx.storage.transactionSync(() => {
    const queued = queuedReviews(host, ownerUid);
    if (!queued.some((item) => item.segmentId === review.segmentId && item.sourceProcessId === processId)
      && !host.responsibilities.getByDedupeKey(ownerUid, `memory.review:${processId}:${review.segmentId}`)) {
      host.ctx.storage.kv.put(`memory-reviews:${ownerUid}`, [...queued, { ...review, sourceProcessId: processId }]);
    }
    host.tasks.enqueue(1, { callback: "onMemoryReview", payload: ownerUid }, { idempotent: true });
  });
  await host.tasks.arm();
}

/** The Kernel owns accepted sources independently of the replaceable Ship pid. */
export async function runMemoryReview(
  host: Kernel,
  ownerUid: number,
  runningTaskId: string,
): Promise<void> {
  const source = queuedReviews(host, ownerUid)[0];
  if (!source) return;
  const successor = await host.schedule(60, "onMemoryReview", ownerUid, { idempotent: true, excludeTaskId: runningTaskId });
  try {
    const gate = await host.onboarding.managedWorkGate();
    if (!gate.allowed) return;
    if (!await admitMemoryReview({ ...source, ownerUid }, host.buildKernelContext({}))) return;
  } catch (error) {
    const key = `memory-review-failure:${source.segmentId}`;
    if (!host.ctx.storage.kv.get(key)) {
      const diagnosticId = crypto.randomUUID();
      host.ctx.storage.kv.put(key, {
        diagnosticId, source, ownerUid, failedAt: Date.now(),
        error: error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error),
      });
      emitTelemetry(host.bindings, {
        installationId: host.installationId, component: "gateway",
        event: { stream: "operational", name: "memory.review.admission.failed", properties: { diagnosticId } },
      });
    }
    return;
  }
  const remaining = queuedReviews(host, ownerUid).filter((item) => item.segmentId !== source.segmentId || item.sourceProcessId !== source.sourceProcessId);
  host.ctx.storage.kv.put(`memory-reviews:${ownerUid}`, remaining);
  if (remaining.length === 0) await host.cancelSchedule(successor.id);
}

/** Admit one ordinary review at a time; the responsibility is its durable receipt. */
export async function admitMemoryReview(
  job: MemoryReviewSource & { ownerUid: number },
  ctx: Pick<KernelContext, "auth" | "responsibilities" | "responsibilitySources" | "reconcileResponsibilityWake">,
): Promise<boolean> {
  const { ownerUid, ...source } = job;
  if (ctx.auth.isAccountDisabled(ownerUid) || !ctx.responsibilitySources.isEnabled(ownerUid, "memory.review")) return true;
  const dedupeKey = `memory.review:${source.sourceProcessId}:${source.segmentId}`;
  const existing = ctx.responsibilities.getByDedupeKey(ownerUid, dedupeKey);
  if (!existing) {
    if (ctx.responsibilities.listActiveByDedupeKeyPrefix(ownerUid, "memory.review:").length) return false;
    ctx.responsibilities.create({
      ownerUid,
      title: "Preserve useful personal memory",
      details: {
        instructions: reviewInstructions,
        ...source,
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
  await ctx.reconcileResponsibilityWake?.(ownerUid);
  return true;
}
