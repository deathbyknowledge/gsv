import { z } from "zod";
import type { ResponsibilityRecord } from "@humansandmachines/gsv/protocol";
import { emitTelemetry } from "@humansandmachines/gsv/telemetry";
import { processMemoryReviewSchema, type ProcessMemoryReview } from "../protocol/process-frames";
import type { Kernel } from "./do";
import reviewInstructions from "../prompts/tasks/memory-review.md";

const memoryReviewSourceSchema = processMemoryReviewSchema.extend({
  sourceProcessId: z.string(),
});
type MemoryReviewSource = z.infer<typeof memoryReviewSourceSchema>;

/** What memory reviews reach on their Kernel. */
type MemoryReviewHost = Pick<
  Kernel,
  "ctx" | "bindings" | "installationId" | "procs" | "auth" | "responsibilities" | "responsibilitySources" | "responsibilityRuntime"
>;

/** Each review's responsibility is keyed by its slice; one with this prefix is active at a time. */
const REVIEW_KEY_PREFIX = "memory.review:";
/** An owner's waiting slices, oldest first. */
const QUEUE_KEY_PREFIX = "memory-reviews:";

function reviewKey(source: MemoryReviewSource): string {
  return `${REVIEW_KEY_PREFIX}${source.sourceProcessId}:${source.segmentId}`;
}

function queuedReviews(host: MemoryReviewHost, ownerUid: number): MemoryReviewSource[] {
  return z.array(memoryReviewSourceSchema).parse(host.ctx.storage.kv.get(`${QUEUE_KEY_PREFIX}${ownerUid}`) ?? []);
}

/**
 * Accepts a slice of the owner's archived Ship history and admits it at once while no review
 * is active. The Kernel owns accepted slices independently of the replaceable Ship pid.
 */
export async function queueMemoryReview(host: MemoryReviewHost, processId: string, review: ProcessMemoryReview): Promise<void> {
  const process = host.procs.get(processId);
  if (!process?.isPersonalController || host.auth.isAccountDisabled(process.ownerUid)
    || !host.responsibilitySources.isEnabled(process.ownerUid, "memory.review")) return;
  const { ownerUid } = process;
  const source = { ...review, sourceProcessId: processId };
  const admitted = host.ctx.storage.transactionSync(() => {
    const queued = queuedReviews(host, ownerUid);
    if (!queued.some((item) => reviewKey(item) === reviewKey(source))
      && !host.responsibilities.getByDedupeKey(ownerUid, reviewKey(source))) {
      host.ctx.storage.kv.put(`${QUEUE_KEY_PREFIX}${ownerUid}`, [...queued, source]);
    }
    return admitWaitingReview(host, ownerUid);
  });
  if (admitted) await host.responsibilityRuntime.reconcileResponsibilityWake(ownerUid);
}

/** Settling a review admits the owner's next waiting one in the same transaction; its wake is armed once that commits. */
export function memoryReviewSettled(host: MemoryReviewHost, record: ResponsibilityRecord): void {
  if (!record.dedupeKey?.startsWith(REVIEW_KEY_PREFIX) || !admitWaitingReview(host, record.ownerUid)) return;
  host.ctx.waitUntil(Promise.resolve()
    .then(() => host.responsibilityRuntime.reconcileResponsibilityWake(record.ownerUid))
    .catch((error) => {
      console.warn("[Kernel] Failed to arm the next memory review:", error instanceof Error ? error.message : String(error));
    }));
}

/** Admits each owner's first waiting review when the Kernel starts, such as one an older Kernel left for its poll. */
export async function recoverMemoryReviews(host: MemoryReviewHost): Promise<void> {
  for (const [key] of host.ctx.storage.kv.list({ prefix: QUEUE_KEY_PREFIX })) {
    const ownerUid = Number(key.slice(QUEUE_KEY_PREFIX.length));
    if (host.ctx.storage.transactionSync(() => admitWaitingReview(host, ownerUid))) {
      await host.responsibilityRuntime.reconcileResponsibilityWake(ownerUid);
    }
  }
}

/**
 * Admits the owner's first waiting review while none is active: one ordinary review at a
 * time, with its responsibility as the durable receipt. Call inside a transaction. An owner
 * who opted out or was removed takes none, and what waited goes. A failed admission rolls
 * back alone and leaves a diagnostic; its slice waits for the next settle, slice or start.
 */
function admitWaitingReview(host: MemoryReviewHost, ownerUid: number): boolean {
  if (host.responsibilities.listActiveByDedupeKeyPrefix(ownerUid, REVIEW_KEY_PREFIX).length) return false;
  const queued = queuedReviews(host, ownerUid);
  const [head] = queued;
  if (!head) return false;
  if (host.auth.isAccountDisabled(ownerUid) || !host.responsibilitySources.isEnabled(ownerUid, "memory.review")) {
    host.ctx.storage.kv.delete(`${QUEUE_KEY_PREFIX}${ownerUid}`);
    return false;
  }
  try {
    return host.ctx.storage.transactionSync(() => {
      for (const [index, source] of queued.entries()) {
        const { record } = host.responsibilities.create({
          ownerUid,
          title: "Update personal memory",
          details: { instructions: reviewInstructions, ...source },
          source: { kind: "system", component: "memory-review" },
          assignee: { kind: "ship" },
          state: "open",
          priority: "low",
          dedupeKey: reviewKey(source),
          actor: { kind: "system", component: "memory-review" },
          observedByShip: false,
          now: Date.now(),
        });
        // An older Kernel took a slice off its queue only after admitting it, so one may already be reviewed.
        if (record.state === "resolved" || record.state === "cancelled") continue;
        host.ctx.storage.kv.put(`${QUEUE_KEY_PREFIX}${ownerUid}`, queued.slice(index + 1));
        return true;
      }
      host.ctx.storage.kv.delete(`${QUEUE_KEY_PREFIX}${ownerUid}`);
      return false;
    });
  } catch (error) {
    recordAdmissionFailure(host, ownerUid, head, error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error));
    return false;
  }
}

/** One diagnostic per slice whose admission failed; its cause stays in Kernel storage for authorized inspection. */
function recordAdmissionFailure(host: MemoryReviewHost, ownerUid: number, source: MemoryReviewSource, error: string): void {
  const key = `memory-review-failure:${source.segmentId}`;
  if (host.ctx.storage.kv.get(key)) return;
  const diagnosticId = crypto.randomUUID();
  host.ctx.storage.kv.put(key, { diagnosticId, source, ownerUid, failedAt: Date.now(), error });
  emitTelemetry(host.bindings, {
    installationId: host.installationId, component: "gateway",
    event: { stream: "operational", name: "memory.review.admission.failed", properties: { diagnosticId } },
  });
}
