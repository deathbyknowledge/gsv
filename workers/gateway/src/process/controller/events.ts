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

/** Records a Kernel event, or admits it to a run when its declared admission says so. */
export async function deliverProcessEvent(
  host: Process,
  args: ProcessEventDeliverArgs,
): Promise<ProcessEventDeliverResult> {
  if (!host.isInitialized()) throw new Error("Process no longer exists");
  const eventId = z.string().regex(/^[a-zA-Z0-9._:-]{1,200}$/).parse(args.eventId);
  const event = procHistoryEventSchema.parse(args.event);
  if (event.kind === "owner.notified") {
    // The person sees a notice they were sent; one recorded only for Ship stays out of their chat.
    const expected = event.payload.shownInClient ? ["person", "both"] : [event.payload.adapter ? "both" : "model"];
    if (event.severity !== "info" || !expected.includes(event.audience)) {
      throw new Error("Process event is not registered for this delivery path");
    }
  } else {
    const definition = procHistoryTargetEventRegistry["target.status"];
    if (event.kind !== definition.kind || event.severity !== definition.severity ||
        !definition.allowedAudiences.includes(event.audience)) {
      throw new Error("Process event is not registered for this delivery path");
    }
    const resetAt = Number(host.store.state.getValue(PROCESS_RESET_AT_KEY) ?? 0);
    if (event.payload.observedAt <= resetAt) {
      return { eventId, runId: null, queued: false, ignored: true };
    }
  }
  // An event only the person sees gives a run nothing to read.
  const action = event.audience === "person" ? "record" : host.runs.active ? args.admission.busy : args.admission.idle;
  return action === "record" ? appendNotice(host, eventId, event) : admitRuntimeEvent(host, eventId, event);
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
