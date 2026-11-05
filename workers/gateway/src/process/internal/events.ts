/** Internal Process events primitives. */

import {
  type ResponsibilityRecord, responsibilityRequiresAction,
} from "@humansandmachines/gsv/protocol";
import type { ResponsibilityBatchState, RunState } from "../run/state";
import type { TerminalResponsibilitySnapshot } from "./contracts";

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
