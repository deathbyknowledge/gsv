import { z } from "zod";
import {
  procHistoryEventSchema, procHistoryTargetEventRegistry, type ProcHistoryEvent,
} from "@humansandmachines/gsv/protocol";
import type { ProcessEventDeliverArgs, ProcessEventDeliverResult } from "../../protocol/process-frames";
import type { Process } from "../do";
import { renderHistoryEvent } from "../history/event-renderer";
import { PROCESS_RESET_AT_KEY, RUNTIME_EVENT_TOMBSTONE_LIMIT } from "../internal/lifecycle";

const NOTICE_RECEIPTS_KEY = "eventNoticeReceipts";
const noticeReceiptsSchema = z.array(z.strictObject({
  eventId: z.string(), messageId: z.number().int().positive(), generation: z.number().int().nonnegative(),
}));

/** Internal Kernel admission preserves notice durability without allocating a model run. */
export async function deliverProcessEvent(
  host: Process,
  args: ProcessEventDeliverArgs,
): Promise<ProcessEventDeliverResult> {
  if (!host.isInitialized()) throw new Error("Process no longer exists");
  const eventId = z.string().regex(/^[a-zA-Z0-9._:-]{1,200}$/).parse(args.eventId);
  const event = procHistoryEventSchema.parse(args.event);
  if (event.kind === "owner.notified") {
    if (event.severity !== "info" || event.audience !== "both") {
      throw new Error("Process event is not registered for this delivery path");
    }
    // A notice joins an active run like any runtime event; otherwise it waits, without
    // starting a run, for the owner's reply that needs it.
    if (host.runs.active) return admitRuntimeEvent(host, eventId, event);
    return appendNotice(host, eventId, event);
  }
  const definition = procHistoryTargetEventRegistry["target.status"];
  if (event.kind !== definition.kind || event.severity !== definition.severity ||
      !definition.allowedAudiences.includes(event.audience)) {
    throw new Error("Process event is not registered for this delivery path");
  }
  const resetAt = Number(host.store.state.getValue(PROCESS_RESET_AT_KEY) ?? 0);
  if (event.payload.observedAt <= resetAt) {
    return { eventId, runId: null, queued: false, ignored: true };
  }
  if (event.audience !== "person") return admitRuntimeEvent(host, eventId, event);
  return appendNotice(host, eventId, event);
}

async function admitRuntimeEvent(
  host: Process,
  eventId: string,
  event: ProcHistoryEvent,
): Promise<ProcessEventDeliverResult> {
  const admitted = await host.controller.handleRuntimeEvent(renderHistoryEvent(event), event.kind, {
    runId: eventId,
    dedupeId: eventId,
    kind: event.kind,
    provenance: JSON.stringify({ source: "kernel", eventId, eventType: event.kind }),
    event,
  });
  if (!admitted.ok) throw new Error(admitted.error);
  return { eventId, runId: admitted.runId, queued: admitted.queued };
}

/** Appends a history event outside any run, once per history generation. */
async function appendNotice(
  host: Process,
  eventId: string,
  event: ProcHistoryEvent,
): Promise<ProcessEventDeliverResult> {
  const content = renderHistoryEvent(event);
  const timestamp = Date.now();
  const messageId = host.ctx.storage.transactionSync(() => {
    const generation = host.store.state.getHistoryGeneration();
    const receipts = noticeReceiptsSchema.parse(JSON.parse(host.store.state.getValue(NOTICE_RECEIPTS_KEY) ?? "[]"));
    const existing = receipts.find((receipt) => receipt.eventId === eventId && receipt.generation === generation);
    if (existing) return existing.messageId;
    const id = host.store.messages.appendMessage("system", content, {
      createdAt: timestamp, record: { kind: "event", payload: event },
    });
    receipts.push({ eventId, messageId: id, generation });
    host.store.state.setValue(NOTICE_RECEIPTS_KEY, JSON.stringify(receipts.slice(-RUNTIME_EVENT_TOMBSTONE_LIMIT)));
    return id;
  });
  await host.signals.changed(["messages"], { messageId, timestamp, recordKind: "event", audience: event.audience });
  return { eventId, runId: null, queued: false, messageId };
}
