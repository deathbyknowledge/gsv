import { z } from "zod";
import {
  procHistoryEventSchema, procHistoryTargetEventRegistry, resourceBlockSchema,
  type ProcHistoryEvent, type ProcMediaInput, type ResourceBlock,
} from "@humansandmachines/gsv/protocol";
import { errorMessageFromUnknown } from "../../inference/errors";
import type { ProcessEventDeliverArgs, ProcessEventDeliverResult } from "../../protocol/process-frames";
import { MAX_MESSAGE_MEDIA_ITEMS, MAX_MESSAGE_MEDIA_TOTAL_BYTES } from "../../shared/message-media-limits";
import type { Process } from "../do";
import { renderHistoryEvent } from "../history/event-renderer";
import { PROCESS_RESET_AT_KEY, RUNTIME_EVENT_TOMBSTONE_LIMIT } from "../internal/lifecycle";
import { stringifyStoredProcessMedia } from "../media";

const NOTICE_RECEIPTS_KEY = "eventNoticeReceipts";
const noticeReceiptsSchema = z.array(z.strictObject({
  eventId: z.string(), messageId: z.number().int().positive(), generation: z.number().int().nonnegative(),
}));

const responsibilitiesSchema = z.strictObject({
  ledgerRevision: z.number().int().nonnegative().safe(),
  ids: z.array(z.string().trim().regex(/^r12y:[0-9a-f-]{36}$/u)).min(1).max(100),
});
const attachmentsSchema = z.array(z.custom<ResourceBlock>((value) => resourceBlockSchema.safeParse(value).success))
  .max(MAX_MESSAGE_MEDIA_ITEMS);

type Carried = {
  responsibilities?: z.infer<typeof responsibilitiesSchema>;
  attachments?: ResourceBlock[];
};

/** Records a Kernel event, or admits it to a run when its declared admission says so. */
export async function deliverProcessEvent(
  host: Process,
  args: ProcessEventDeliverArgs,
): Promise<ProcessEventDeliverResult> {
  if (!host.isInitialized()) throw new Error("Process no longer exists");
  const eventId = z.string().regex(/^[a-zA-Z0-9._:-]{1,200}$/).parse(args.eventId);
  const event = procHistoryEventSchema.parse(args.event);
  const carried: Carried = {
    ...(args.responsibilities === undefined ? undefined : { responsibilities: responsibilitiesSchema.parse(args.responsibilities) }),
    ...(args.attachments === undefined ? undefined : { attachments: attachmentsSchema.parse(args.attachments) }),
  };
  if (event.kind === "contact.message") {
    // Ship handles a contact's message as the work it was handed; the person reads it in People.
    if (event.severity !== "info" || event.audience !== "model" || !carried.responsibilities) {
      throw new Error("Process event is not registered for this delivery path");
    }
  } else if (event.kind === "responsibility.ready") {
    // Work that came due is handed to Ship alone; the person sees it on the ledger.
    if (event.severity !== "info" || event.audience !== "model" || !carried.responsibilities || carried.attachments) {
      throw new Error("Process event is not registered for this delivery path");
    }
  } else if (carried.responsibilities || carried.attachments) {
    throw new Error("Process event is not registered for this delivery path");
  } else if (event.kind === "owner.notified") {
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
  return action === "record" ? appendNotice(host, eventId, event) : admitRuntimeEvent(host, eventId, event, carried);
}

async function admitRuntimeEvent(
  host: Process,
  eventId: string,
  event: ProcHistoryEvent,
  { responsibilities, attachments }: Carried,
): Promise<ProcessEventDeliverResult> {
  // A redelivery answers with its first admission before any attachment is fetched again.
  const existing = host.controller.runtimeEventAdmission(eventId);
  if (existing) return { eventId, runId: existing.runId, queued: existing.queued };
  let recorded = event;
  let media: string | undefined;
  if (attachments?.length && recorded.kind === "contact.message") {
    const retained = await retainAttachments(host, attachments);
    media = retained.media;
    if (retained.errors.length > 0) recorded = { ...recorded, payload: { ...recorded.payload, attachmentErrors: retained.errors } };
  }
  const admitted = await host.controller.handleRuntimeEvent(renderHistoryEvent(recorded), recorded.kind, {
    runId: eventId,
    dedupeId: eventId,
    kind: recorded.kind,
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
  return { eventId, runId: admitted.runId, queued: admitted.queued };
}

/** Contact attachments become this Process's own media, as messenger attachments do. */
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
