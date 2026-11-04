import { z } from "zod";
import type { InteractionOrigin, ProcHistoryEventPayload, ProcMediaInput, ResourceBlock } from "@humansandmachines/gsv/protocol";
import { errorMessageFromUnknown } from "../../inference/errors";
import type { ProcessEventDeliverArgs, ProcessEventDeliverResult } from "../../protocol/process-frames";
import { MAX_MESSAGE_MEDIA_TOTAL_BYTES } from "../../shared/message-media-limits";
import type { Process } from "../do";
import { renderHistoryEvent } from "../history/event-renderer";
import { PROCESS_RESET_AT_KEY, RUNTIME_EVENT_TOMBSTONE_LIMIT } from "../internal/lifecycle";
import { stringifyStoredProcessMedia } from "../media";

const NOTICE_RECEIPTS_KEY = "eventNoticeReceipts";
const noticeReceiptsSchema = z.array(z.strictObject({
  eventId: z.string(), messageId: z.number().int().positive(), generation: z.number().int().nonnegative(),
}));

type EventDelivery = Extract<ProcessEventDeliverArgs, { event: unknown }>;
type DeliveredEvent = EventDelivery["event"];

/**
 * Records a Kernel event, or admits it to a run as its declared admission says. The Kernel
 * decides what each event is and does; the Process decides only what its own state settles.
 */
export async function deliverProcessEvent(
  host: Process,
  args: ProcessEventDeliverArgs,
): Promise<ProcessEventDeliverResult> {
  if (!host.isInitialized()) throw new Error("Process no longer exists");
  const { eventId } = args;
  if ("message" in args) return { eventId, ...await host.controller.admitIpcMessage(eventId, args.message) };
  if ("input" in args) {
    const admitted = await host.controller.admitInput(args.input, args.input.runId ?? eventId, args.admission.busy);
    if (!admitted.ok) return { eventId, runId: null, queued: false, refused: admitted.error };
    return { eventId, runId: admitted.runId, queued: admitted.queued === true };
  }
  const { event, admission: { idle, busy, joinRun } } = args;
  if (event.kind === "delivery.failed") {
    // Noted under the run that wrote it; a failed approval request only while that request is pending.
    const { runId } = event.payload;
    if (args.approvalRequestId !== undefined && host.store.tools.getPendingHil(args.approvalRequestId)?.runId !== runId) {
      return { eventId, runId: null, queued: false, ignored: true };
    }
    return await appendNotice(host, eventId, event, runId);
  }
  if (outlived(host, event)) return { eventId, runId: null, queued: false, ignored: true };
  // An event only the person sees gives a run nothing to read; one for a given run waits for its own run during another.
  const active = host.runs.active;
  const action = event.audience === "person"
    ? "record"
    : !active ? idle : busy === "join" && joinRun !== undefined && active.runId !== joinRun ? "after" : busy;
  return action === "record" ? appendNotice(host, eventId, event) : admitRuntimeEvent(host, eventId, args, action === "after");
}

/** A call's end or check-in for a run that was aborted, or what was observed before this process last reset. */
function outlived(host: Process, event: DeliveredEvent): boolean {
  const resetAt = Number(host.store.state.getValue(PROCESS_RESET_AT_KEY) ?? 0);
  if (event.kind === "target.connection") return event.payload.observedAt <= resetAt;
  if (event.kind !== "ipc.reply" && event.kind !== "ipc.overdue" && event.kind !== "ipc.timeout") return false;
  const { createdAt, sourceRunId } = event.payload;
  return (createdAt !== undefined && createdAt <= resetAt) || (sourceRunId !== undefined && host.controller.isAbortedRun(sourceRunId));
}

/** A scheduled run answers to its schedule and, when it has one, its reply destination. */
function scheduleOrigin({ scheduleId, replyTo }: ProcHistoryEventPayload<"schedule.fired">): InteractionOrigin {
  return { kind: "scheduler", scheduleId, ...(replyTo ? { replyTo } : undefined) };
}

async function admitRuntimeEvent(
  host: Process,
  eventId: string,
  { event, responsibilities, attachments }: EventDelivery,
  /** Queue the event as its own run after the active one, instead of joining it. */
  distinctRun: boolean,
): Promise<ProcessEventDeliverResult> {
  // A redelivery answers with its first admission before any attachment is fetched again.
  const existing = host.controller.runtimeEventAdmission(eventId);
  if (existing) return { eventId, runId: existing.runId, queued: existing.queued };
  let recorded: DeliveredEvent = event;
  let media: string | undefined;
  if (attachments?.length) {
    const retained = await retainAttachments(host, attachments);
    // A call's file is its whole answer, so its delivery tries again until the file is kept.
    if (recorded.kind !== "contact.message" && retained.media === undefined) throw new Error(retained.errors.join("; "));
    media = retained.media;
    // A contact's message goes without what it couldn't fetch, and says so.
    if (recorded.kind === "contact.message" && retained.errors.length > 0) {
      recorded = { ...recorded, payload: { ...recorded.payload, attachmentErrors: retained.errors } };
    }
  }
  const admitted = await host.controller.handleRuntimeEvent(renderHistoryEvent(recorded), recorded.kind, {
    runId: eventId,
    dedupeId: eventId,
    kind: recorded.kind,
    ...(distinctRun ? { distinctRun } : undefined),
    ...(recorded.kind === "schedule.fired" ? { origin: scheduleOrigin(recorded.payload) } : undefined),
    provenance: JSON.stringify({
      source: "kernel", eventId, eventType: recorded.kind,
      ...(recorded.kind === "contact.message" ? { contactId: recorded.payload.contactId } : undefined),
      ...(recorded.kind === "responsibility.ready" ? { ledgerRevision: recorded.payload.ledgerRevision } : undefined),
    }),
    event: recorded,
    ...(responsibilities
      ? { responsibilityBatch: { batchId: eventId, ledgerRevision: responsibilities.ledgerRevision, responsibilityIds: responsibilities.ids } }
      : undefined),
    ...(media === undefined ? undefined : { media }),
  });
  if (!admitted.ok) throw new Error(admitted.error);
  // A schedule's message names its work, as a first prompt does.
  if (recorded.kind === "schedule.fired") host.maybeStartTaskTitleGeneration(recorded.payload.message);
  return { eventId, runId: admitted.runId, queued: admitted.queued };
}

/** Files the Kernel hands with an event become this Process's own media, as messenger attachments do. */
async function retainAttachments(host: Process, blocks: ResourceBlock[]): Promise<{ media?: string; errors: string[] }> {
  const media: ProcMediaInput[] = [];
  const errors: string[] = [];
  // The message's byte budget is checked against declared sizes before any bytes are fetched.
  let remainingBytes = MAX_MESSAGE_MEDIA_TOTAL_BYTES;
  for (const block of blocks) {
    if (block.ref.size > remainingBytes) {
      errors.push(`${block.filename ?? "an attachment"} exceeds the message attachment byte limit`);
      continue;
    }
    try {
      media.push(...await host.resources.resolveIncomingMedia([block]));
      remainingBytes -= block.ref.size;
    } catch (error) {
      errors.push(errorMessageFromUnknown(error));
    }
  }
  if (media.length === 0) return { errors };
  try {
    return { media: await host.resources.prepareEventMedia(media) ?? undefined, errors };
  } catch (error) {
    // Only enrichment failed: keep the retained attachments themselves.
    errors.push(`attachments could not be prepared: ${errorMessageFromUnknown(error)}`);
    return { media: stringifyStoredProcessMedia(media) ?? undefined, errors };
  }
}

/** Appends a history event without admitting it to a run, once per history generation; one about a run is filed under it. */
async function appendNotice(
  host: Process,
  eventId: string,
  event: DeliveredEvent,
  runId?: string,
): Promise<ProcessEventDeliverResult> {
  const content = renderHistoryEvent(event);
  const timestamp = Date.now();
  const messageId = host.ctx.storage.transactionSync(() => {
    const generation = host.store.state.getHistoryGeneration();
    const receipts = noticeReceiptsSchema.parse(JSON.parse(host.store.state.getValue(NOTICE_RECEIPTS_KEY) ?? "[]"));
    const existing = receipts.find((receipt) => receipt.eventId === eventId && receipt.generation === generation);
    if (existing) return existing.messageId;
    const id = host.store.messages.appendMessage("system", content, {
      createdAt: timestamp, record: { kind: "event", payload: event }, ...(runId === undefined ? undefined : { runId }),
    });
    receipts.push({ eventId, messageId: id, generation });
    host.store.state.setValue(NOTICE_RECEIPTS_KEY, JSON.stringify(receipts.slice(-RUNTIME_EVENT_TOMBSTONE_LIMIT)));
    return id;
  });
  await host.signals.changed(["messages"], {
    messageId, timestamp, recordKind: "event", audience: event.audience, ...(runId === undefined ? undefined : { runId }),
  });
  return { eventId, runId: null, queued: false, messageId };
}
