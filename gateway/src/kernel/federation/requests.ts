import type {
  ContactRequestRecord,
  ContactRequestState,
  FederationRequestDelivery,
  JsonObject,
} from "@humansandmachines/gsv/protocol";
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
  const state = responsibilityState(input.request);
  const blocker = state === "waiting" ? "Awaiting the contact's response" : undefined;
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
    createdAtMs: request.createdAtMs,
    updatedAtMs: request.updatedAtMs,
  };
}

export function assertRequestTransition(
  from: ContactRequestState,
  to: ContactRequestState,
): void {
  if (!isRequestTransitionAllowed(from, to)) {
    throw new Error(`Contact request cannot change from ${from} to ${to}`);
  }
}

export function isRequestTransitionAllowed(
  from: ContactRequestState,
  to: ContactRequestState,
): boolean {
  const allowed = {
    offered: ["accepted", "rejected", "cancelled"],
    accepted: ["active", "completed", "cancelled"],
    active: ["completed", "cancelled"],
    rejected: [],
    completed: [],
    cancelled: [],
  } as const satisfies Record<ContactRequestState, readonly ContactRequestState[]>;
  return allowed[from].some((candidate) => candidate === to);
}

function responsibilityState(request: ContactRequestRecord) {
  if (request.state === "offered") {
    return request.direction === "outgoing" ? "waiting" : "open";
  }
  if (request.state === "accepted" || request.state === "active") return "active";
  if (request.state === "cancelled") return "cancelled";
  return "resolved";
}
