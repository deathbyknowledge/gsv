import type {
  ApproachClaim, ApproachClaimReceipt, ApproachConfirmation, ApproachConnectedReceipt, ApproachWithdrawal,
} from "@humansandmachines/gsv/protocol";
import { approachClaimReceiptSchema, approachConnectedReceiptSchema, jsonObjectSchema } from "@humansandmachines/gsv/protocol";
import type { KernelContext } from "../context";
import type { ApproachRecord } from "../approach-store";
import { deriveContactSecret, randomBase64Url, sha256Base64Url } from "../federation-crypto";
import { activateFederationContact } from "../federation/pairing";
import { assertContactCapacity } from "../federation/limits";
import { localShipDocumentV2 } from "../federation/protocol";
import { fetchFederationJson } from "../federation/http";
import { PublicFederationError } from "../federation/errors";
import { getConversationById } from "../../shared/utils";
import {
  APPROACH_CLAIM_PATH, APPROACH_CONFIRM_PATH, approachLock, authenticateApproachPeer,
  requireApproachAvailable, sameActor, sameApproach, signApproachValue, verifyApproachValue,
} from "./shared";

export async function claimApproach(input: ApproachClaim, ctx: KernelContext): Promise<ApproachClaimReceipt> {
  const tokenHash = await sha256Base64Url(input.token);
  const invitation = ctx.federation.inviteByTokenHash(tokenHash);
  const record = invitation ? ctx.approaches.boundInvitation(invitation.inviteId) : null;
  if (!record || invitation?.purpose !== "approach" || record.summary.direction !== "outgoing"
    || !sameApproach(record.summary.reference, input.reference) || !sameActor(record.metadata.recipient, input.recipient)) {
    throw new PublicFederationError(404, "Message request is unavailable");
  }
  await authenticateApproachPeer(input, input.recipient, ctx, record);
  const sharedSecret = await deriveContactSecret(input.token, input.reference.actor.shipId, input.recipient.shipId);
  const generation = `generation:${randomBase64Url(24)}`;
  const proposed = await signApproachValue({
    version: 2, domain: "gsv-federation/2/approach-claimed", reference: input.reference, recipient: input.recipient,
    attemptId: input.attemptId, generation, threadId: record.threadId,
  } satisfies Omit<ApproachClaimReceipt, "signature">, ctx);
  const result = await ctx.coordinateFederationContact(approachLock(record), () => ctx.federation.transaction(() => {
    const current = requireApproachAvailable(record, ctx);
    if (current.generation) {
      if (current.pairingAttemptId !== input.attemptId || !current.claimReceipt) throw new PublicFederationError(409, "Message request acceptance changed");
      requireApproachContact(current, ctx);
      return approachClaimReceiptSchema.parse(current.claimReceipt);
    }
    const invite = ctx.federation.inviteByTokenHash(tokenHash);
    if (!invite || invite.state !== "issued" || invite.expiresAtMs <= Date.now()) throw new PublicFederationError(410, "Message request is no longer available");
    assertContactCapacity(current.ownerUid, current.summary.peer.shipId, current.summary.peer.subjectId, ctx, true);
    const existing = ctx.federation.getByRemote(current.ownerUid, current.summary.peer.shipId, current.summary.peer.subjectId);
    if (existing?.state === "active") throw new PublicFederationError(409, "A newer connection is already active");
    const contact = activateFederationContact({
      ownerUid: current.ownerUid, remoteShipId: current.summary.peer.shipId,
      remoteSubject: { id: current.summary.peer.subjectId, displayName: current.summary.displayName },
      remoteOrigin: current.remoteOrigin, remotePublicKey: current.remotePublicKey,
      sharedSecret, generation, threadId: current.threadId,
      preferredContactId: current.contactId, preferredConversationId: current.summary.conversationId, saved: false,
    }, ctx);
    if (contact.id !== current.contactId || contact.conversationId !== current.summary.conversationId) throw new PublicFederationError(409, "Message request conversation changed");
    const receipt = jsonObjectSchema.parse(proposed);
    if (!ctx.federation.acceptInvite({ tokenHash, remoteShipId: input.recipient.shipId, remoteSubjectId: input.recipient.subjectId,
      contactId: contact.id, generation, threadId: current.threadId, response: receipt })) throw new PublicFederationError(409, "Message request was already decided");
    ctx.federation.setProtocol(contact.id, generation, { version: 2, features: input.document.features, checkedAtMs: Date.now() });
    ctx.approaches.commitClaim(current.summary.id, input.attemptId, generation, receipt);
    return proposed;
  }));
  await promoteApproachConversation(record, ctx);
  ctx.broadcastToUserUid(record.ownerUid, "contact.changed");
  ctx.broadcastToUserUid(record.ownerUid, "approach.changed");
  return result;
}

export async function acceptApproach(record: ApproachRecord, ctx: KernelContext): Promise<void> {
  const current = requireApproachAvailable(record, ctx);
  if (current.summary.direction !== "incoming" || current.summary.state !== "accepting" || !current.setupToken || !current.pairingAttemptId) return;
  const document = await localShipDocumentV2(ctx);
  const claim: ApproachClaim = await signApproachValue({
    version: 2, domain: "gsv-federation/2/approach-claim", document, reference: current.summary.reference,
    recipient: current.metadata.recipient, attemptId: current.pairingAttemptId, token: current.setupToken,
  } satisfies Omit<ApproachClaim, "signature">, ctx);
  const response = approachClaimReceiptSchema.parse(await fetchFederationJson(`${current.remoteOrigin}${APPROACH_CLAIM_PATH}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(claim),
  }, ctx));
  await verifyApproachValue(response, current.remotePublicKey);
  if (!sameApproach(response.reference, current.summary.reference) || !sameActor(response.recipient, current.metadata.recipient)
    || response.attemptId !== current.pairingAttemptId || response.threadId !== current.threadId) throw new Error("Message request acceptance does not match your decision");
  const secret = await deriveContactSecret(current.setupToken, response.reference.actor.shipId, response.recipient.shipId);
  ctx.federation.transaction(() => {
    const owned = requireApproachAvailable(current, ctx);
    if (owned.generation) {
      if (owned.generation !== response.generation) throw new Error("Message request acceptance changed");
      requireApproachContact(owned, ctx);
      return;
    }
    if (owned.summary.state !== "accepting" || owned.pairingAttemptId !== response.attemptId) throw new Error("Message request decision changed");
    assertContactCapacity(owned.ownerUid, owned.summary.peer.shipId, owned.summary.peer.subjectId, ctx);
    const existing = ctx.federation.getByRemote(owned.ownerUid, owned.summary.peer.shipId, owned.summary.peer.subjectId);
    if (existing?.state === "active") throw new Error("A newer connection is already active");
    const contact = activateFederationContact({
      ownerUid: owned.ownerUid, remoteShipId: owned.summary.peer.shipId,
      remoteSubject: { id: owned.summary.peer.subjectId, displayName: owned.summary.displayName },
      remoteOrigin: owned.remoteOrigin, remotePublicKey: owned.remotePublicKey, sharedSecret: secret,
      generation: response.generation, threadId: owned.threadId,
      preferredContactId: owned.contactId, preferredConversationId: owned.summary.conversationId, saved: false,
    }, ctx);
    if (contact.id !== owned.contactId || contact.conversationId !== owned.summary.conversationId) throw new Error("Message request conversation changed");
    ctx.federation.setProtocol(contact.id, contact.generation, { version: 2, features: ["messages", "approaches"], checkedAtMs: Date.now() });
    ctx.approaches.commitClaim(owned.summary.id, response.attemptId, response.generation, jsonObjectSchema.parse(response));
  });
  ctx.broadcastToUserUid(current.ownerUid, "contact.changed");
  ctx.broadcastToUserUid(current.ownerUid, "approach.changed");
}

export async function confirmApproach(input: ApproachConfirmation, ctx: KernelContext): Promise<ApproachConnectedReceipt> {
  const ownerUid = ctx.federation.subjectOwner(input.reference.actor.subjectId);
  const record = ownerUid === null ? null : ctx.approaches.byReference(ownerUid, input.reference);
  if (!record || record.summary.direction !== "outgoing" || !sameActor(record.metadata.recipient, input.recipient)) throw new PublicFederationError(404, "Message request is unavailable");
  await authenticateApproachPeer(input, input.recipient, ctx, record);
  await ctx.coordinateFederationContact(approachLock(record), () => ctx.federation.transaction(() => {
    const current = requireApproachAvailable(record, ctx);
    if (current.generation !== input.generation || current.pairingAttemptId !== input.attemptId) throw new PublicFederationError(409, "Message request acceptance changed");
    requireApproachContact(current, ctx);
    ctx.approaches.confirmed(current.summary.id, input.generation);
  }));
  ctx.broadcastToUserUid(record.ownerUid, "approach.changed");
  await ctx.scheduleApproachMaintenance();
  return await signApproachValue({ version: 2, domain: "gsv-federation/2/approach-connected", reference: input.reference,
    recipient: input.recipient, attemptId: input.attemptId, generation: input.generation } satisfies Omit<ApproachConnectedReceipt, "signature">, ctx);
}

export async function deliverApproachConfirmation(record: ApproachRecord, ctx: KernelContext): Promise<void> {
  const current = requireApproachAvailable(record, ctx);
  if (current.summary.direction !== "incoming" || current.summary.state !== "accepted" || !current.generation || !current.pairingAttemptId) return;
  requireApproachContact(current, ctx);
  await promoteApproachConversation(current, ctx);
  const document = await localShipDocumentV2(ctx);
  const packet: ApproachConfirmation = await signApproachValue({
    version: 2, domain: "gsv-federation/2/approach-confirmation", document, reference: current.summary.reference,
    recipient: current.metadata.recipient, generation: current.generation, attemptId: current.pairingAttemptId,
  } satisfies Omit<ApproachConfirmation, "signature">, ctx);
  const receipt = approachConnectedReceiptSchema.parse(await fetchFederationJson(`${current.remoteOrigin}${APPROACH_CONFIRM_PATH}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(packet),
  }, ctx));
  await verifyApproachValue(receipt, current.remotePublicKey);
  if (!sameApproach(receipt.reference, current.summary.reference) || !sameActor(receipt.recipient, current.metadata.recipient)
    || receipt.generation !== current.generation || receipt.attemptId !== current.pairingAttemptId) throw new Error("Message request confirmation changed");
  requireApproachContact(requireApproachAvailable(current, ctx), ctx);
  ctx.approaches.confirmed(current.summary.id, current.generation);
  ctx.broadcastToUserUid(current.ownerUid, "approach.changed");
}

export async function withdrawApproach(input: ApproachWithdrawal, ctx: KernelContext): Promise<{ received: true }> {
  const ownerUid = ctx.federation.subjectOwner(input.recipient.subjectId);
  const record = ownerUid === null ? null : ctx.approaches.byReference(ownerUid, input.reference);
  if (!record || record.summary.direction !== "incoming" || !sameActor(record.metadata.recipient, input.recipient)) throw new PublicFederationError(404, "Message request is unavailable");
  await authenticateApproachPeer(input, input.reference.actor, ctx, record);
  await ctx.coordinateFederationContact(approachLock(record), () => ctx.approaches.withdrawnRemotely(record.summary.id));
  ctx.broadcastToUserUid(record.ownerUid, "approach.changed");
  await ctx.scheduleApproachMaintenance();
  return { received: true };
}

function requireApproachContact(record: ApproachRecord, ctx: KernelContext) {
  const contact = ctx.federation.get(record.contactId);
  if (!contact || contact.ownerUid !== record.ownerUid || contact.state !== "active" || contact.generation !== record.generation
    || contact.conversationId !== record.summary.conversationId || contact.threadId !== record.threadId) {
    throw new PublicFederationError(410, "This connection has been replaced or removed");
  }
  return contact;
}

async function promoteApproachConversation(record: ApproachRecord, ctx: KernelContext): Promise<void> {
  requireApproachContact(requireApproachAvailable(record, ctx), ctx);
  await getConversationById(ctx.installationId, record.summary.conversationId).initialize({ ownerUid: record.ownerUid, kind: "contact" });
  requireApproachContact(requireApproachAvailable(record, ctx), ctx);
}
