import type { ApproachEnvelope, ApproachWithdrawal } from "@humansandmachines/gsv/protocol";
import { approachReceiptSchema } from "@humansandmachines/gsv/protocol";
import type { KernelContext } from "../context";
import type { ApproachRecord } from "../approach-store";
import { APPROACH_RECEIPT_MS } from "../approach-store";
import { localShipDocumentV2 } from "../federation/protocol";
import { fetchFederationJson } from "../federation/http";
import { FederationHttpError, PublicFederationError } from "../federation/errors";
import { getConversationById } from "../../shared/utils";
import { appendApproachMessage } from "./admission";
import { acceptApproach, deliverApproachConfirmation } from "./pairing";
import { APPROACH_PATH, APPROACH_WITHDRAW_PATH, approachLock, requireApproachAvailable, sameActor, sameApproach, signApproachValue, verifyApproachValue } from "./shared";

export async function processApproachMaintenance(ctx: KernelContext): Promise<void> {
  for (const scheduled of ctx.approaches.due()) {
    await ctx.coordinateFederationContact(approachLock(scheduled), async () => {
      let record = ctx.approaches.get(scheduled.summary.id);
      if (!record) return;
      try {
        if (record.cleanupAt !== null && record.cleanupAt <= Date.now()) {
          await collectApproach(record, ctx);
          return;
        }
        const expiry = record.summary.expiresAtMs + (record.summary.state === "accepting" ? APPROACH_RECEIPT_MS : 0);
        if (!record.summary.acceptedAtMs && expiry <= Date.now()) {
          record = ctx.federation.transaction(() => {
            const expired = ctx.approaches.expire(scheduled.summary.id)!;
            retireInvitation(expired, ctx);
            return expired;
          });
          ctx.broadcastToUserUid(record.ownerUid, "approach.changed");
          return;
        }
        if (record.nextAttemptAt === null || record.nextAttemptAt > Date.now()) return;
        if (record.summary.state === "preparing") {
          requireApproachAvailable(record, ctx);
          await appendApproachMessage(record.summary.id, ctx);
          record = ctx.approaches.get(record.summary.id)!;
        }
        if (record.summary.direction === "outgoing") {
          if (record.summary.state === "pending" && record.summary.delivery !== "received") await deliverApproach(record, ctx);
          else if (record.summary.state === "withdrawn") await deliverWithdrawal(record, ctx);
        } else if (record.summary.state === "accepting") {
          await acceptApproach(record, ctx);
        } else if (record.summary.state === "accepted") {
          await deliverApproachConfirmation(record, ctx);
        }
      } catch (error) {
        const terminal = (error instanceof FederationHttpError || error instanceof PublicFederationError)
          && [400, 401, 403, 404, 410, 413].includes(error.status);
        ctx.approaches.defer(record.summary.id, record.summary.revision, terminal);
        ctx.broadcastToUserUid(record.ownerUid, "approach.changed");
      }
    });
  }
}

async function deliverApproach(record: ApproachRecord, ctx: KernelContext): Promise<void> {
  const current = requireApproachAvailable(record, ctx);
  if (!current.pendingText || !current.setupToken) throw new Error("Message request delivery payload is unavailable");
  const document = await localShipDocumentV2(ctx);
  const packet: ApproachEnvelope = await signApproachValue({
    version: 2, domain: "gsv-federation/2/approach", document,
    content: { ...current.metadata, text: current.pendingText }, setup: { token: current.setupToken },
  } satisfies Omit<ApproachEnvelope, "signature">, ctx);
  requireApproachAvailable(current, ctx);
  const receipt = approachReceiptSchema.parse(await fetchFederationJson(`${current.remoteOrigin}${APPROACH_PATH}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(packet),
  }, ctx));
  await verifyApproachValue(receipt, current.remotePublicKey);
  if (!sameApproach(receipt.reference, current.summary.reference) || !sameActor(receipt.recipient, current.metadata.recipient)
    || receipt.fingerprint !== current.fingerprint) throw new Error("Message request receipt does not match the send");
  ctx.approaches.deliveryReceived(current.summary.id, current.summary.revision);
  ctx.broadcastToUserUid(current.ownerUid, "approach.changed");
}

async function deliverWithdrawal(record: ApproachRecord, ctx: KernelContext): Promise<void> {
  const document = await localShipDocumentV2(ctx);
  const packet: ApproachWithdrawal = await signApproachValue({
    version: 2, domain: "gsv-federation/2/approach-withdrawal", document,
    reference: record.summary.reference, recipient: record.metadata.recipient,
  } satisfies Omit<ApproachWithdrawal, "signature">, ctx);
  try {
    await fetchFederationJson(`${record.remoteOrigin}${APPROACH_WITHDRAW_PATH}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(packet),
    }, ctx);
  } catch (error) {
    if (!(error instanceof FederationHttpError) || ![404, 410].includes(error.status)) throw error;
  }
  ctx.approaches.deliveryReceived(record.summary.id, record.summary.revision);
}

function retireInvitation(record: ApproachRecord, ctx: KernelContext): void {
  if (!record.setupInviteId) return;
  const invitation = ctx.federation.invite(record.setupInviteId);
  if (invitation?.state === "issued" && invitation.expiresAtMs > Date.now()) ctx.federation.cancelInvite(invitation.inviteId, record.ownerUid);
}

async function collectApproach(record: ApproachRecord, ctx: KernelContext): Promise<void> {
  if (!record.summary.acceptedAtMs && !ctx.federation.get(record.contactId)) {
    const conversation = ctx.conversations.get(record.summary.conversationId);
    if (conversation) {
      const stub = getConversationById(ctx.installationId, conversation.id);
      await stub.discardIntake({ id: record.summary.id, ownerUid: record.ownerUid });
      ctx.conversations.discardContactIntake(conversation.id, record.ownerUid);
      ctx.broadcastToUserUid(record.ownerUid, "conversation.changed", { conversationId: conversation.id });
    }
  }
  ctx.approaches.removeSettled(record.summary.id);
  ctx.broadcastToUserUid(record.ownerUid, "approach.changed");
}
