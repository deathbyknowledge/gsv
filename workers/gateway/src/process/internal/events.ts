/** Internal Process events primitives. */

import {
  type ResponsibilityRecord, responsibilityRequiresAction,
} from "@humansandmachines/gsv/protocol";
import type { ProcHistoryEvent } from "@humansandmachines/gsv/protocol";
import type { ProcessPhoneRuntimeEvent, ProcessRuntimeEvent } from "../../protocol/process-frames";
import type { ResponsibilityBatchState, RunState } from "../run/state";
import type { TerminalResponsibilitySnapshot } from "./contracts";
import {
  contactMessageRuntimeEventSchema, phoneAskedRuntimeEventSchema, phoneEndedRuntimeEventSchema,
  processRuntimeEventSchema, responsibilityReadyRuntimeEventSchema, workReturnedRuntimeEventSchema,
} from "./schemas";
import { z } from "zod";

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
  if (discriminator.data.type === "contact.message") {
    const result = contactMessageRuntimeEventSchema.safeParse(value);
    if (!result.success) throw new Error("contact.message fields are invalid");
    return result.data;
  }
  if (discriminator.data.type === "phone.asked" || discriminator.data.type === "phone.ended") {
    const result = (discriminator.data.type === "phone.asked" ? phoneAskedRuntimeEventSchema : phoneEndedRuntimeEventSchema)
      .safeParse(value);
    if (!result.success) throw new Error(`${discriminator.data.type} fields are invalid`);
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

/** The history record of a call event; the ledger revision stays with the admission. */
export function phoneHistoryEvent(event: ProcessPhoneRuntimeEvent): ProcHistoryEvent {
  const base = { severity: "info", audience: "model", link: { kind: "phone", callId: event.callId } } as const;
  const common = { callId: event.callId, to: event.to, responsibilityId: event.responsibilityId,
    ...(event.business === undefined ? {} : { business: event.business }) };
  if (event.type === "phone.asked") {
    return { ...base, kind: "phone.asked", payload: {
      ...common, questionId: event.questionId, question: event.question, deadlineAt: event.deadlineAt,
    } };
  }
  return { ...base, kind: "phone.ended", payload: {
    ...common, outcome: event.outcome,
    ...(event.summary === undefined ? {} : { summary: event.summary }),
    ...(event.reason === undefined ? {} : { reason: event.reason }),
    ...(event.transcriptPath === undefined ? {} : { transcriptPath: event.transcriptPath }),
  } };
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
