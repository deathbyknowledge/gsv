import type { AcceptMessageRequestOutput, JsonValue, MessageRequestOutput } from "@humansandmachines/gsv/protocol";
import {
  ACCEPT_MESSAGE_REQUEST, acceptMessageRequestInputSchema, acceptMessageRequestOutputSchema, withdrawMessageRequestInputSchema,
} from "@humansandmachines/gsv/protocol";
import type { KernelContext } from "../context";
import type { ApproachRecord } from "../approach-store";
import { ensureContactConversation } from "../federation";
import { randomBase64Url } from "../federation-crypto";
import { activateFederationContact } from "../federation/pairing";
import { assertContactCapacity } from "../federation/limits";
import { PublicFederationError } from "../federation/errors";
import { isCurrentFederationContact } from "../federation/resources";
import { personName } from "../profiles";
import { callShipProcedure, type ShipCall } from "../ships/xrpc";
import { consumeRequestIngress } from "./admission";
import { approachLock, requireApproachAvailable, requireApproachContact } from "./shared";

const UNAVAILABLE = "Message request is unavailable";

/**
 * `space.ship.acceptMessageRequest`: the person a request went to accepts it.
 * Only the DID the request went to finds it; this Ship, its sender's, makes
 * the connection and answers with it, and a repeated acceptance hears the same.
 */
export async function acceptMessageRequest(call: ShipCall, ctx: KernelContext): Promise<JsonValue> {
  consumeRequestIngress(ctx);
  const input = acceptMessageRequestInputSchema.parse(call.input);
  const record = ctx.approaches.byRequest("outgoing", call.caller, input.requestId);
  if (!record) throw new PublicFederationError(404, UNAVAILABLE);
  const generation = `generation:${randomBase64Url(24)}`;
  const { contact, changed } = await ctx.coordinateFederationContact(approachLock(record), () => ctx.federation.transaction(() => {
    const current = requireApproachAvailable(record, ctx);
    if (current.generation) return { contact: requireApproachContact(current, ctx), changed: false };
    if (current.summary.state !== "pending" || current.summary.expiresAtMs <= Date.now()) {
      throw new PublicFederationError(410, "Message request is no longer available");
    }
    assertContactCapacity(current.ownerUid, current.summary.peerDid, ctx, true);
    if (ctx.federation.getByRemote(current.ownerUid, current.summary.peerDid)?.state === "active") {
      throw new PublicFederationError(409, "A newer connection is already active");
    }
    const contact = activateFederationContact({
      ownerUid: current.ownerUid, remoteDid: current.summary.peerDid, remoteName: input.name,
      ...(current.summary.peerHandle ? { remoteHandle: current.summary.peerHandle } : undefined),
      generation, threadId: current.threadId,
      preferredContactId: current.contactId, preferredConversationId: current.summary.conversationId, saved: false,
      shipHandlesMessages: current.shipHandlesMessages,
    }, ctx);
    if (contact.id !== current.contactId || contact.conversationId !== current.summary.conversationId) {
      throw new PublicFederationError(409, "Message request conversation changed");
    }
    ctx.approaches.accept(current.summary.id, generation);
    return { contact, changed: true };
  }));
  if (changed) {
    ctx.broadcastToUserUid(contact.ownerUid, "contact.changed");
    ctx.broadcastToUserUid(contact.ownerUid, "approach.changed");
  }
  await ensureContactConversation(contact, ctx);
  await ctx.reconcileResponsibilityWake(contact.ownerUid);
  if (!isCurrentFederationContact(contact.id, contact.generation, ctx)) {
    throw new PublicFederationError(410, "This connection has been replaced or removed");
  }
  const output: AcceptMessageRequestOutput = { generation: contact.generation, threadId: contact.threadId };
  return output;
}

/**
 * Makes the connection a person accepted: the sender's Ship names its
 * generation, and this Ship records it. The caller holds the request's lock.
 */
export async function acceptApproach(record: ApproachRecord, ctx: KernelContext): Promise<void> {
  const current = requireApproachAvailable(record, ctx);
  if (current.summary.direction !== "incoming" || current.summary.state !== "accepting") return;
  assertContactCapacity(current.ownerUid, current.summary.peerDid, ctx);
  const accepted = acceptMessageRequestOutputSchema.parse(await callShipProcedure(
    current.summary.peerDid,
    ACCEPT_MESSAGE_REQUEST,
    { requestId: current.summary.requestId, name: personName(current.ownerUid, ctx) },
    ctx,
  ));
  if (accepted.threadId !== current.threadId) throw new Error("Message request acceptance does not match your decision");
  const contact = ctx.federation.transaction(() => {
    const owned = requireApproachAvailable(current, ctx);
    if (owned.generation) {
      if (owned.generation !== accepted.generation) throw new Error("Message request acceptance changed");
      return requireApproachContact(owned, ctx);
    }
    if (owned.summary.state !== "accepting") throw new Error("Message request decision changed");
    assertContactCapacity(owned.ownerUid, owned.summary.peerDid, ctx);
    if (ctx.federation.getByRemote(owned.ownerUid, owned.summary.peerDid)?.state === "active") {
      throw new Error("A newer connection is already active");
    }
    const activated = activateFederationContact({
      ownerUid: owned.ownerUid, remoteDid: owned.summary.peerDid, remoteName: owned.summary.displayName,
      ...(owned.summary.peerHandle ? { remoteHandle: owned.summary.peerHandle } : undefined),
      generation: accepted.generation, threadId: owned.threadId,
      preferredContactId: owned.contactId, preferredConversationId: owned.summary.conversationId, saved: false,
      shipHandlesMessages: owned.shipHandlesMessages,
    }, ctx);
    if (activated.id !== owned.contactId || activated.conversationId !== owned.summary.conversationId) {
      throw new Error("Message request conversation changed");
    }
    ctx.approaches.accept(owned.summary.id, accepted.generation);
    return activated;
  });
  ctx.broadcastToUserUid(current.ownerUid, "contact.changed");
  ctx.broadcastToUserUid(current.ownerUid, "approach.changed");
  await ensureContactConversation(contact, ctx);
  await ctx.reconcileResponsibilityWake(contact.ownerUid);
}

/** `space.ship.withdrawMessageRequest`: the sender takes back a request; only its DID finds it. */
export async function withdrawMessageRequest(call: ShipCall, ctx: KernelContext): Promise<JsonValue> {
  consumeRequestIngress(ctx);
  const input = withdrawMessageRequestInputSchema.parse(call.input);
  const record = ctx.approaches.byRequest("incoming", call.caller, input.requestId);
  if (!record) throw new PublicFederationError(404, UNAVAILABLE);
  await ctx.coordinateFederationContact(approachLock(record), () => ctx.approaches.withdrawnRemotely(record.summary.id));
  ctx.broadcastToUserUid(record.ownerUid, "approach.changed");
  await ctx.scheduleApproachMaintenance();
  const output: MessageRequestOutput = { state: "received" };
  return output;
}
