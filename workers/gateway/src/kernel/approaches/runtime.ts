import type { SendMessageRequestInput } from "@humansandmachines/gsv/protocol";
import { SEND_MESSAGE_REQUEST, sendMessageRequestOutputSchema, WITHDRAW_MESSAGE_REQUEST } from "@humansandmachines/gsv/protocol";
import type { KernelContext } from "../context";
import type { ApproachRecord } from "../approach-store";
import { APPROACH_RECEIPT_MS } from "../approach-store";
import { FederationHttpError, PublicFederationError } from "../federation/errors";
import { callShipProcedure } from "../ships/xrpc";
import { getConversationById } from "../../shared/utils";
import { appendApproachMessage } from "./admission";
import { acceptApproach } from "./pairing";
import { approachLock, requireApproachAvailable } from "./shared";

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
        if (approachOverdue(record)) {
          expireApproach(record, ctx);
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
  if (!current.pendingText || !current.profileCid) throw new Error("Message request delivery payload is unavailable");
  const input: SendMessageRequestInput = {
    requestId: current.summary.requestId, profileCid: current.profileCid, name: current.localDisplayName,
    messageId: current.messageId, text: current.pendingText, createdAtMs: current.sentAtMs, expiresAtMs: current.summary.expiresAtMs,
  };
  sendMessageRequestOutputSchema.parse(await callShipProcedure(current.summary.peerDid, SEND_MESSAGE_REQUEST, input, ctx));
  requireApproachAvailable(current, ctx);
  ctx.approaches.deliveryReceived(current.summary.id, current.summary.revision);
  ctx.broadcastToUserUid(current.ownerUid, "approach.changed");
}

async function deliverWithdrawal(record: ApproachRecord, ctx: KernelContext): Promise<void> {
  try {
    await callShipProcedure(record.summary.peerDid, WITHDRAW_MESSAGE_REQUEST, { requestId: record.summary.requestId }, ctx);
  } catch (error) {
    // A request the other Ship no longer holds needs no withdrawal.
    if (!(error instanceof FederationHttpError) || ![404, 410].includes(error.status)) throw error;
  }
  ctx.approaches.deliveryReceived(record.summary.id, record.summary.revision);
}

function approachOverdue(record: ApproachRecord, now = Date.now()): boolean {
  const expiry = record.summary.expiresAtMs + (record.summary.state === "accepting" ? APPROACH_RECEIPT_MS : 0);
  return !record.summary.acceptedAtMs && expiry <= now;
}

/** Expires one overdue request; the caller holds the request's lock. */
function expireApproach(record: ApproachRecord, ctx: KernelContext): void {
  const expired = ctx.approaches.expire(record.summary.id)!;
  ctx.broadcastToUserUid(expired.ownerUid, "approach.changed");
}

/** Expires this exact request if its deadline has passed, under its own lock, without waiting for maintenance. */
export async function expireOverdueApproach(record: ApproachRecord, ctx: KernelContext): Promise<void> {
  await ctx.coordinateFederationContact(approachLock(record), async () => {
    const current = ctx.approaches.get(record.summary.id);
    if (current && approachOverdue(current)) expireApproach(current, ctx);
  });
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
