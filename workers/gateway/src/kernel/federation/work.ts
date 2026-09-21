import { z } from "zod/mini";
import {
  jsonValueSchema, mergeWorkStream, workActionSchema, workOperationSchema,
  type ContactRequestActArgs, type ContactRequestUpdateResult,
  type FederationWorkDelivery, type WorkParticipant,
} from "@humansandmachines/gsv/protocol";
import type { KernelContext } from "../context";
import { FederationRequestIdentityConflictError, isReadyFederationOutbox, type FederationContactRecord, type FederationInboxRecord } from "../federation-store";
import { stableOpaqueId } from "../../shared/stable-id";
import { canonicalJson } from "../federation-crypto";
import { requireContactCaller, requireOwnedActiveContact, requireOwnedActiveContactGeneration } from "./authority";
import { assertDeliveryReplay, federationInputFingerprint, rearmPendingDelivery } from "./delivery";
import { assertOutboundCapacity, assertRequestCapacity, consumeOutboundDeliveryRate, pruneFederationState } from "./limits";
import { PublicFederationError } from "./errors";
import { syncFederationRequestResponsibility } from "./requests";

const actionArgsSchema = z.strictObject({
  requestId: z.string().check(z.minLength(1), z.maxLength(256)),
  expectedRevision: z.int().check(z.minimum(1)),
  action: z.union([workActionSchema, z.literal("reconcile")]),
  note: z.optional(z.string().check(z.maxLength(1024))),
  idempotencyKey: z.optional(z.string().check(z.maxLength(256))),
}) satisfies z.ZodMiniType<ContactRequestActArgs>;

export async function handleContactRequestAct(raw: ContactRequestActArgs, ctx: KernelContext): Promise<ContactRequestUpdateResult> {
  const ownerUid = requireContactCaller(ctx, false);
  const args = actionArgsSchema.parse(raw);
  if (args.action === "reconcile" && args.note) throw new Error("Sync does not add a new statement");
  const idempotencyKey = args.idempotencyKey?.trim() || crypto.randomUUID();
  const fingerprint = await federationInputFingerprint(jsonValueSchema.parse({
    operation: "contact.request.act", requestId: args.requestId, expectedRevision: args.expectedRevision,
    action: args.action, note: args.note ?? null,
  }));
  const current = ctx.federation.request(args.requestId);
  if (!current?.work) throw new Error("This request uses legacy work updates");
  const contact = requireOwnedActiveContact(current.contactId, ownerUid, ctx);
  if (contact.generation !== current.contactGeneration) throw new Error("Work request belongs to a retired connection");
  const existing = ctx.federation.outboxByIdempotency(ownerUid, idempotencyKey);
  if (existing) {
    assertDeliveryReplay(existing, contact.id, contact.generation, fingerprint);
    if (!isReadyFederationOutbox(existing) || existing.payload.kind !== "work") throw new Error("Work intent was used for another delivery");
    await rearmPendingDelivery(existing, ctx);
    return { request: current, deliveryId: existing.deliveryId };
  }
  if (current.revision !== args.expectedRevision) throw new Error("Work request changed; review the latest statements");
  const participant: WorkParticipant = current.direction === "outgoing" ? "requester" : "performer";
  const peer: WorkParticipant = participant === "requester" ? "performer" : "requester";
  const operations = args.action === "reconcile" ? current.work[participant] : [...current.work[participant], workOperationSchema.parse({
    id: `work-operation:${crypto.randomUUID()}`, revision: current.work[participant].length + 1,
    action: args.action, observedPeerRevision: current.work[peer].length,
    ...(args.note?.trim() ? { note: args.note.trim() } : undefined),
  })];
  const work = mergeWorkStream(current.work, participant, operations);
  const now = Date.now();
  pruneFederationState(ctx, now);
  const deliveryId = `delivery:${crypto.randomUUID()}`;
  const request = ctx.federation.transaction(() => {
    requireOwnedActiveContactGeneration(contact, ownerUid, ctx);
    assertOutboundCapacity(ownerUid, contact.id, ctx, now);
    consumeOutboundDeliveryRate(ownerUid, contact.id, ctx, now);
    const updated = ctx.federation.writeWork(current.id, work, now, { state: "pending", source: "local", deliveryId });
    syncFederationRequestResponsibility({ request: updated, contact, conversationId: contact.conversationId,
      deliveryId, remoteInput: false, createAllowed: args.action === "accept" || args.action === "start", now }, ctx);
    ctx.federation.enqueue({ deliveryId, ownerUid, contactId: contact.id, contactGeneration: contact.generation,
      idempotencyKey, fingerprint, wireVersion: 2,
      payload: { kind: "work", offer: work.offer, participant, operations }, now });
    return updated;
  });
  ctx.broadcastToUserUid(ownerUid, "contact.request.changed", { contactId: contact.id });
  await ctx.scheduleFederationDelivery(deliveryId, now, true);
  await ctx.reconcileResponsibilityWake(ownerUid);
  return { request, deliveryId };
}

export async function commitInboundWork(payload: FederationWorkDelivery, inbox: FederationInboxRecord, contact: FederationContactRecord, ctx: KernelContext): Promise<void> {
  const direction = payload.participant === "requester" ? "incoming" : "outgoing";
  const canonicalOrigin = ctx.installationIdentity?.canonicalOrigin;
  if (!canonicalOrigin) throw new Error("Installation has no canonical origin");
  const identity = direction === "outgoing" ? await ctx.federationIdentity.ensure(canonicalOrigin) : null;
  const subject = ctx.federation.subject(contact.ownerUid);
  const origin = direction === "incoming" ? { shipId: contact.remoteShipId, subjectId: contact.remoteSubject.id }
    : identity && subject ? { shipId: identity.shipId, subjectId: subject.id } : null;
  if (!origin || payload.offer.reference.actor.shipId !== origin.shipId || payload.offer.reference.actor.subjectId !== origin.subjectId) {
    throw new PublicFederationError(403, "Work offer origin does not match the participant");
  }
  const localId = direction === "incoming" ? await stableOpaqueId("request", [contact.id, contact.generation, origin.shipId, origin.subjectId, payload.offer.reference.id]) : payload.offer.reference.id;
  const now = inbox.receivedAtMs;
  ctx.federation.transaction(() => {
    requireOwnedActiveContactGeneration(contact, contact.ownerUid, ctx);
    let request = ctx.federation.requestForWork(contact.id, contact.generation, payload.offer.reference.id, direction);
    if (!request) {
      if (direction === "outgoing") throw new PublicFederationError(404, "Work offer not found");
      assertRequestCapacity(contact.id, ctx, true, Date.now());
      request = ctx.federation.createRequest({ id: localId, remoteId: payload.offer.reference.id, contactId: contact.id,
        contactGeneration: contact.generation, direction, kind: payload.offer.kind, title: payload.offer.title,
        ...(payload.offer.details ? { details: payload.offer.details } : undefined), state: "offered",
        work: { offer: payload.offer, requester: [], performer: [] },
        exchange: { state: "acknowledged", source: "remote", deliveryId: inbox.deliveryId }, createdAtMs: now, updatedAtMs: now });
    }
    if (!request.work || canonicalJson(jsonValueSchema.parse(request.work.offer)) !== canonicalJson(jsonValueSchema.parse(payload.offer))) {
      throw new PublicFederationError(409, new FederationRequestIdentityConflictError().message);
    }
    let next;
    try {
      next = mergeWorkStream(request.work, payload.participant, payload.operations);
    } catch (error) {
      throw new PublicFederationError(409, error instanceof Error ? error.message : "Invalid work stream");
    }
    const changed = next !== request.work;
    const updated = changed ? ctx.federation.writeWork(request.id, next, now) : request;
    if (changed) syncFederationRequestResponsibility({ request: updated, contact, conversationId: contact.conversationId,
      deliveryId: inbox.deliveryId, remoteInput: true, createAllowed: false, now }, ctx);
    return updated;
  });
  ctx.broadcastToUserUid(contact.ownerUid, "contact.request.changed", { contactId: contact.id });
  await ctx.reconcileResponsibilityWake(contact.ownerUid);
}
