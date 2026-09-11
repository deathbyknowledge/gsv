/** Internal Process events primitives. */

import {
  type ResponsibilityListResult, type ResponsibilityRecord, responsibilityRequiresAction,
} from "@humansandmachines/gsv/protocol";
import type { ProcessRuntimeEvent } from "../../protocol/process-frames";
import type { ResponsibilityBatchState, RunState } from "../run/state";
import type { TerminalResponsibilitySnapshot } from "./contracts";
import {
  processRuntimeEventSchema, responsibilityReadyRuntimeEventSchema, workReturnedRuntimeEventSchema,
} from "./schemas";
import { z } from "zod";
import { formatResponsibilityLine } from "../history/event-renderer";

export function normalizeProcessRuntimeEvent(
  value: Parameters<typeof processRuntimeEventSchema.safeParse>[0],
): ProcessRuntimeEvent {
  const discriminator = z.object({ type: z.string() }).safeParse(value);
  if (!discriminator.success) {
    throw new Error("proc.runtime.event.deliver requires an event");
  }
  if (discriminator.data.type === "r12y.ready") {
    const result = responsibilityReadyRuntimeEventSchema.safeParse(value);
    if (!result.success) throw new Error("r12y.ready fields are invalid");
    return result.data;
  }
  if (discriminator.data.type !== "adapter.work.returned") {
    throw new Error("Unsupported process runtime event type");
  }
  const result = workReturnedRuntimeEventSchema.safeParse(value);
  if (!result.success) {
    throw new Error("adapter.work.returned fields are invalid");
  }
  return result.data;
}

export function formatResponsibilityBaseline(ledger: ResponsibilityListResult): string {
  const lines = [`Ledger revision ${ledger.revision}.`];
  if (ledger.responsibilities.length === 0) {
    lines.push("", "No unresolved responsibilities.");
    return lines.join("\n");
  }
  lines.push("");
  for (const responsibility of ledger.responsibilities) {
    lines.push(formatResponsibilityLine(responsibility));
    if (responsibility.blocker) {
      lines.push(`  Blocker: ${JSON.stringify(responsibility.blocker)}.`);
    }
  }
  if (ledger.count > ledger.responsibilities.length) {
    lines.push(
      "",
      `${ledger.count - ledger.responsibilities.length} additional unresolved responsibilities are omitted from this compact baseline; use \`r12y list\` to inspect them.`,
    );
  }
  return lines.join("\n");
}

export function appendResponsibilityBatch(
  run: RunState,
  batch: ResponsibilityBatchState,
): void {
  const batches = run.responsibilityBatches ?? [];
  const existing = batches.find(({ batchId }) => batchId === batch.batchId);
  if (existing) {
    existing.ledgerRevision = Math.max(
      existing.ledgerRevision ?? 0,
      batch.ledgerRevision ?? 0,
    );
    existing.responsibilityIds = Array.from(new Set([
      ...existing.responsibilityIds,
      ...batch.responsibilityIds,
    ]));
  } else {
    batches.push(batch);
  }
  run.responsibilityBatches = batches;
}

export function terminalResponsibilityAdmissionKey(run: RunState): string {
  const batches = (run.responsibilityBatches ?? []).map((batch) => ({
    batchId: batch.batchId,
    ledgerRevision: batch.ledgerRevision ?? 0,
    responsibilityIds: [...new Set(batch.responsibilityIds)].sort(),
  }));
  batches.sort((left, right) => left.batchId.localeCompare(right.batchId));
  return JSON.stringify(batches);
}

export function terminalResponsibilitySnapshot(
  run: RunState,
): TerminalResponsibilitySnapshot {
  return {
    admissionKey: terminalResponsibilityAdmissionKey(run),
    responsibilityIds: Array.from(new Set(
      (run.responsibilityBatches ?? []).flatMap(
        ({ responsibilityIds }) => responsibilityIds,
      ),
    )),
  };
}

export function unhandledTerminalResponsibilityIds(
  responsibilityIds: string[],
  records: ReadonlyMap<string, ResponsibilityRecord>,
): string[] {
  const now = Date.now();
  return responsibilityIds.filter((id) => {
    const responsibility = records.get(id);
    if (!responsibility) return true;
    if (responsibility.state === "resolved" || responsibility.state === "cancelled") {
      return false;
    }
    return responsibilityRequiresAction(responsibility, now);
  });
}
