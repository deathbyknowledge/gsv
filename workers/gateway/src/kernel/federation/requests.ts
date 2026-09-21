import type {
  ContactRequestRecord,
  ContactRequestState,
  FederationRequestDelivery,
  JsonObject,
} from "@humansandmachines/gsv/protocol";
import { contactRequestTransitions, projectWork } from "@humansandmachines/gsv/protocol";
import type { KernelContext } from "../context";
import type { FederationContactRecord } from "../federation-store";

export function syncFederationRequestResponsibility(input: {
  request: ContactRequestRecord;
  contact: FederationContactRecord;
  conversationId: string;
  deliveryId?: string;
  remoteInput: boolean;
  createAllowed: boolean;
  now: number;
}, ctx: KernelContext): void {
  const dedupeKey = `federation.request:${input.contact.id}:${input.request.id}`;
  const existing = ctx.responsibilities.getByDedupeKey(input.contact.ownerUid, dedupeKey);
  if (!existing && !input.createAllowed) return;
  const work = input.request.work ? projectWork(input.request.work) : null;
  const state = responsibilityState(input.request);
  const blocker = state === "waiting"
    ? input.request.exchange?.state === "failed"
      ? "The request update was not confirmed by the contact; the exchange is unsettled"
      : input.request.exchange?.state === "pending"
        ? "Awaiting delivery confirmation from the contact"
        : work?.status === "withdrawn" || work?.status === "stop_requested"
          ? "A stop was requested; awaiting the performer's cancellation or result report"
          : work?.outcome === "disputed" ? "The requester disputed the reported result"
            : work?.state === "completed" && input.request.direction === "outgoing" ? "The requester needs to review the reported result"
              : "Awaiting the contact's response"
    : undefined;
  const resolution = state === "resolved" || state === "cancelled"
    ? {
        requestState: input.request.state,
        contactId: input.contact.id,
        requestId: input.request.id,
      }
    : undefined;
  const details: JsonObject = {
    eventType: "federation.request",
    contactId: input.contact.id,
    contactGeneration: input.request.contactGeneration,
    conversationId: input.conversationId,
    requestId: input.request.id,
    direction: input.request.direction,
    requestKind: input.request.kind,
    requestTitle: input.request.title,
    state: input.request.state,
    revision: input.request.revision,
    exchangeState: input.request.exchange?.state ?? "unconfirmed",
    ...(work ? { workStatus: work.status, outcomeReview: work.outcome } : undefined),
    remoteDisplayName: input.contact.remoteSubject.displayName,
    contentTrust: input.remoteInput ? "untrusted" : "local",
    ...(input.deliveryId ? { latestDeliveryId: input.deliveryId } : undefined),
  };
  if (!existing) {
    ctx.responsibilities.create({
      ownerUid: input.contact.ownerUid,
      title: `Track contact request ${input.request.id}`,
      details,
      source: input.remoteInput && input.deliveryId
        ? { kind: "event", eventType: "federation.request", eventId: input.deliveryId }
        : { kind: "system", component: "federation.request" },
      audience: { conversationIds: [input.conversationId] },
      assignee: { kind: "ship" },
      state,
      priority: "normal",
      ...(blocker ? { blocker } : undefined),
      dedupeKey,
      actor: { kind: "system", component: "federation.request" },
      observedByShip: false,
      now: input.now,
    });
    return;
  }
  ctx.responsibilities.update({
    ownerUid: existing.ownerUid,
    id: existing.id,
    expectedRevision: existing.revision,
    patch: {
      details,
      state,
      blocker: blocker ?? null,
      resolution: resolution ?? null,
    },
    actor: { kind: "system", component: "federation.request" },
    observedByShip: false,
    now: input.now,
  });
}

export function cancelRequestResponsibilities(
  ownerUid: number,
  requests: ContactRequestRecord[],
  reason: "contact-generation-changed" | "contact-revoked",
  now: number,
  ctx: KernelContext,
): number {
  let cancelled = 0;
  for (const request of requests) {
    const responsibility = ctx.responsibilities.getByDedupeKey(
      ownerUid,
      `federation.request:${request.contactId}:${request.id}`,
    );
    if (
      !responsibility
      || responsibility.state === "resolved"
      || responsibility.state === "cancelled"
    ) {
      continue;
    }
    ctx.responsibilities.update({
      ownerUid: responsibility.ownerUid,
      id: responsibility.id,
      expectedRevision: responsibility.revision,
      patch: {
        state: "cancelled",
        resolution: {
          reason,
          contactId: request.contactId,
          requestId: request.id,
        },
      },
      actor: { kind: "system", component: "federation.lifecycle" },
      observedByShip: false,
      now,
    });
    cancelled += 1;
  }
  return cancelled;
}

export function requestWireRecord(
  request: ContactRequestRecord,
): FederationRequestDelivery["request"] {
  if (request.state !== "offered" || request.revision !== 1) {
    throw new Error("Only a new contact request offer can be delivered");
  }
  return {
    id: request.id,
    kind: request.kind,
    title: request.title,
    ...(request.details ? { details: request.details } : undefined),
    state: "offered",
    revision: 1,
  };
}

export function assertRequestTransition(
  request: ContactRequestRecord,
  to: ContactRequestState,
): void {
  if (!isRequestTransitionAllowed(request, to, "local")) {
    throw new Error(`This participant cannot change a contact request from ${request.state} to ${to}`);
  }
  if (request.exchange?.state === "pending" || request.exchange?.state === "failed") {
    throw new Error("The previous contact request update has not been confirmed");
  }
}

export function isRequestTransitionAllowed(
  request: Pick<ContactRequestRecord, "direction" | "state">,
  to: ContactRequestState,
  source: "local" | "remote",
): boolean {
  const requester = (request.direction === "outgoing") === (source === "local");
  return contactRequestTransitions(request.state, requester ? "requester" : "performer")
    .some((candidate) => candidate === to);
}

function responsibilityState(request: ContactRequestRecord) {
  if (request.work) {
    const work = projectWork(request.work);
    if (work.status === "withdrawn" || work.status === "stop_requested"
      || work.state === "completed" && work.outcome !== "acknowledged") return "waiting";
  }
  if (request.exchange?.state === "failed") return "waiting";
  if (request.exchange?.state === "pending"
    && ["rejected", "completed", "cancelled"].includes(request.state)) return "waiting";
  if (request.state === "offered") {
    return request.direction === "outgoing" ? "waiting" : "open";
  }
  if (request.state === "accepted" || request.state === "active") return "active";
  if (request.state === "cancelled") return "cancelled";
  return "resolved";
}
