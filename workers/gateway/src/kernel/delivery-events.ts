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
  /** Set when the failure starts the process's run, or joins the one it is in, instead of only being noted. */
  wake: z.literal(true).optional(),
  /** When a waking failure's message was written, so a process reset since then only notes it. */
  writtenAt: z.number().int().nonnegative().optional(),
});

/** One delivery's failure, keyed by the delivery that failed, so it appends once. */
export function deliveryFailed(input: {
  ownerUid: number;
  pid: string;
  runId: string;
  noticeId: string;
  requestId?: string;
  message: string;
  wake?: boolean;
  writtenAt?: number;
}): EventInput {
  const { ownerUid, pid, runId, noticeId, requestId, message, wake, writtenAt } = input;
  return {
    type: DELIVERY_FAILED,
    ownerUid,
    subject: `proc:${pid}`,
    actor: { kind: "kernel" },
    key: noticeId,
    body: {
      pid,
      runId,
      ...(requestId === undefined ? undefined : { requestId }),
      message,
      ...(wake ? { wake: true } : undefined),
      ...(writtenAt === undefined ? undefined : { writtenAt }),
    },
  };
}

/**
 * The run's process notes the failure for the person and the model in its history. One that
 * wakes it also starts a run, or joins the active one, so the process can try another way.
 */
export const deliveryFailedEvent: EventDefinition = {
  routes: (event) => [{ consumer: processConsumer(bodySchema.parse(event.body).pid), lane: "background" }],
  admit(event) {
    const { runId, requestId, message, wake, writtenAt } = bodySchema.parse(event.body);
    return {
      event: {
        kind: "delivery.failed", severity: "error", audience: "both",
        payload: { phase: "message", noticeId: event.key, runId, error: message },
      },
      admission: wake ? { idle: "start", busy: "join" } : { idle: "record", busy: "record" },
      ...(requestId === undefined ? undefined : { approvalRequestId: requestId }),
      ...(writtenAt === undefined ? undefined : { writtenAt }),
    };
  },
};
