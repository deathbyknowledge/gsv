import { z } from "zod";
import type { AdapterMessageDestination } from "@humansandmachines/gsv/protocol";
import { shipConsumer } from "./events/consumers";
import type { EventDefinition } from "./events/registry";
import type { EventInput, LoggedEvent } from "./events/store";

/** A person who came back to their Ship from a work process with /ship in a messenger's private chat. */
export const WORK_RETURNED = "work.returned";

const bodySchema = z.strictObject({
  workPid: z.string(),
  /** The private chat the /ship came from, and that message's id there. */
  adapter: z.string(),
  accountId: z.string(),
  actorId: z.string(),
  surfaceId: z.string(),
  threadId: z.string().optional(),
  messageId: z.string(),
});

/** The private chat a return came from, as a messenger destination. */
function returnedFrom(event: LoggedEvent) {
  const { workPid, adapter, accountId, actorId, surfaceId, threadId, messageId } = bodySchema.parse(event.body);
  const destination: AdapterMessageDestination = {
    kind: "adapter", adapter, accountId, actorId, surface: { kind: "dm", id: surfaceId, ...(threadId ? { threadId } : undefined) },
  };
  return { workPid, destination, messageId };
}

/** The return one /ship made, keyed by its ingress receipt, so a retried command finds it. */
export function workReturned(input: {
  ownerUid: number;
  workPid: string;
  receiptId: string;
  destination: AdapterMessageDestination;
  messageId: string;
}): EventInput {
  const { destination } = input;
  return {
    type: WORK_RETURNED,
    ownerUid: input.ownerUid,
    subject: `proc:${input.workPid}`,
    actor: { kind: "person", uid: input.ownerUid },
    key: input.receiptId,
    body: {
      workPid: input.workPid,
      adapter: destination.adapter,
      accountId: destination.accountId,
      actorId: destination.actorId,
      surfaceId: destination.surface.id,
      ...(destination.surface.threadId ? { threadId: destination.surface.threadId } : undefined),
      messageId: input.messageId,
    },
  };
}

/** Ship hears that the person is back, unless they have written in that chat again since. */
export const workReturnedEvent: EventDefinition = {
  routes: (event) => [{ consumer: shipConsumer(event.ownerUid), lane: "person" }],
  withdrawal(event, ctx) {
    const { destination, messageId } = returnedFrom(event);
    return ctx.adapters.ingressReceipts.isLatestPrivateMessage(destination, messageId)
      ? null
      : "a newer private message followed the return";
  },
  admit(event) {
    return {
      event: {
        kind: "adapter.work.returned", severity: "info", audience: "model",
        payload: { eventId: event.id, workPid: returnedFrom(event).workPid },
      },
      admission: { idle: "start", busy: "after" },
    };
  },
};
