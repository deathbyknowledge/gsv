import { z } from "zod";
import { emitTelemetry } from "@humansandmachines/gsv/telemetry";
import { processMemoryReviewSchema, type ProcessMemoryReview } from "../protocol/process-frames";
import { errorMessageFromUnknown } from "../inference/errors";
import type { Process } from "./do";

const PENDING_KEY = "pendingMemoryReviews";
const BOUNDARY_KEY = "memoryReviewBoundary";
const pendingSchema = z.array(processMemoryReviewSchema.extend({ diagnosticId: z.string().optional() }));
const boundarySchema = z.object({ generation: z.number(), throughMessageId: z.number() });
const reviewTask = { callback: "onMemoryReview" as const, payload: null };

function pendingReviews(host: Process) {
  return pendingSchema.parse(JSON.parse(host.store.state.getValue(PENDING_KEY) ?? "[]"));
}

async function transferMemoryReview(host: Process, review: z.infer<typeof pendingSchema>[number]): Promise<void> {
  const { diagnosticId: _diagnosticId, ...source } = review;
  await host.kernel.queueMemoryReview(source);
  if (!host.killed) {
    host.store.state.setValue(PENDING_KEY, JSON.stringify(pendingReviews(host).filter((item) => item.segmentId !== review.segmentId)));
  }
}

/** Teardown must transfer every archived source before deleting Process state. */
export async function handOffMemoryReviews(host: Process): Promise<void> {
  while (true) {
    const review = pendingReviews(host)[0];
    if (!review) return;
    await transferMemoryReview(host, review);
  }
}

/** Called in the archive installation transaction. No inference or Kernel I/O. */
export function enqueueMemoryReview(host: Process, review: Omit<ProcessMemoryReview, "afterMessageId">): void {
  if (!host.settings.interactive) return;
  const previous = host.store.state.getValue(BOUNDARY_KEY);
  const boundary = previous ? boundarySchema.parse(JSON.parse(previous)) : null;
  const afterMessageId = boundary?.generation === review.generation ? boundary.throughMessageId : 0;
  if (review.throughMessageId <= afterMessageId) return;
  host.store.state.setValue(PENDING_KEY, JSON.stringify([...pendingReviews(host), { ...review, afterMessageId }]));
  host.store.state.setValue(BOUNDARY_KEY, JSON.stringify({ generation: review.generation, throughMessageId: review.throughMessageId }));
  host.tasks.enqueue(1, reviewTask, { idempotent: true });
}

/** A persisted successor survives an interrupted or ambiguous Kernel admission. */
export async function deliverMemoryReview(host: Process, taskId: string): Promise<void> {
  if (host.killed) return;
  const review = pendingReviews(host)[0];
  if (!review) return;
  const successor = host.tasks.enqueue(60, reviewTask, { idempotent: true, excludeTaskId: taskId });
  await host.tasks.arm();
  try {
    await transferMemoryReview(host, review);
  } catch (error) {
    if (host.killed) return;
    const pending = pendingReviews(host);
    const current = pending.find((item) => item.segmentId === review.segmentId);
    if (current && !current.diagnosticId) {
      current.diagnosticId = crypto.randomUUID();
      host.store.state.setValue(PENDING_KEY, JSON.stringify(pending));
      const traceId = host.trace.start({
        id: current.diagnosticId, runId: `memory-review:${review.segmentId}`,
        kind: "delivery", name: "Memory review admission",
      });
      host.trace.finish(traceId, "error", { attributes: { error: errorMessageFromUnknown(error) } });
      emitTelemetry(host.env, {
        installationId: host.installationId, component: "gateway",
        event: { stream: "operational", name: "memory.review.admission.failed", properties: { diagnosticId: current.diagnosticId } },
      });
    }
    return;
  }
  if (host.killed) return;
  if (pendingReviews(host).length === 0) await host.tasks.cancel(successor.id);
}

export async function recoverMemoryReviews(host: Process): Promise<void> {
  if (pendingReviews(host).length) await host.tasks.schedule(1, reviewTask, { idempotent: true });
}
