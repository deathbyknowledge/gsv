import { z } from "zod";
import { processConsumer } from "./events/consumers";
import type { EventDefinition } from "./events/registry";
import type { EventInput } from "./events/store";

/** A reply or approval request a run wrote that its messenger could not deliver. */
export const DELIVERY_FAILED = "delivery.failed";

const bodySchema = z.strictObject({
  pid: z.string(),
  runId: z.string(),
  /** Set when an approval request failed, which matters only while that request is pending. */
  requestId: z.string().optional(),
  message: z.string(),
});

/** One delivery's failure, keyed by its run, its kind, what it carried and how it failed, so it appends once. */
export function deliveryFailed(input: {
  ownerUid: number;
  pid: string;
  runId: string;
  noticeId: string;
  requestId?: string;
  message: string;
}): EventInput {
  const { ownerUid, pid, runId, noticeId, requestId, message } = input;
  return {
    type: DELIVERY_FAILED,
    ownerUid,
    subject: `proc:${pid}`,
    actor: { kind: "kernel" },
    key: noticeId,
    body: { pid, runId, ...(requestId === undefined ? undefined : { requestId }), message },
  };
}

/** The run's process notes the failure for the person and the model in its history; it starts no run. */
export const deliveryFailedEvent: EventDefinition = {
  routes: (event) => [{ consumer: processConsumer(bodySchema.parse(event.body).pid), lane: "background" }],
  admit(event) {
    const { runId, requestId, message } = bodySchema.parse(event.body);
    return {
      event: {
        kind: "delivery.failed", severity: "error", audience: "both",
        payload: { phase: "message", noticeId: event.key, runId, error: message },
      },
      admission: { idle: "record", busy: "record" },
      ...(requestId === undefined ? undefined : { approvalRequestId: requestId }),
    };
  },
};
