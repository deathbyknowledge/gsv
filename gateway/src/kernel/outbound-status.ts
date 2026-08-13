import type {
  MailOutboundStatus,
  MailStatusArgs,
  MailStatusResult,
} from "@humansandmachines/gsv/protocol";
import { resolveCallerOwnerUid, type KernelContext } from "./context";
import type { MailOutboundRecord } from "./mailbox-store";

const MAX_OUTBOUND_IDENTIFIER_BYTES = 256;
const TEXT_ENCODER = new TextEncoder();

export function handleMailStatus(
  value: MailStatusArgs,
  ctx: KernelContext,
): MailStatusResult {
  const deliveryId = normalizeDeliveryId(value);
  const ownerUid = resolveCallerOwnerUid(ctx);
  const outbound = ctx.mailboxes.getOutboundForDelivery(ownerUid, deliveryId);
  return { outbound: outbound ? publicOutboundStatus(outbound) : null };
}

function normalizeDeliveryId(value: MailStatusArgs): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("mail.status requires an object argument");
  }
  if (typeof value.deliveryId !== "string") {
    throw new Error("deliveryId is required");
  }
  const deliveryId = value.deliveryId.trim();
  if (
    !deliveryId
    || TEXT_ENCODER.encode(deliveryId).byteLength > MAX_OUTBOUND_IDENTIFIER_BYTES
    || /[\u0000-\u001f\u007f]/.test(deliveryId)
  ) {
    throw new Error("deliveryId is invalid");
  }
  return deliveryId;
}

function publicOutboundStatus(outbound: MailOutboundRecord): MailOutboundStatus {
  return {
    deliveryId: outbound.deliveryId,
    outboundId: outbound.outboundId,
    state: outbound.state,
    from: outbound.from,
    to: outbound.to,
    subject: outbound.subject,
    createdAt: outbound.createdAt,
    queuedAt: outbound.queuedAt,
    completedAt: outbound.completedAt,
    ...(outbound.providerMessageId
      ? { providerMessageId: outbound.providerMessageId }
      : {}),
    ...(outbound.errorCode ? { errorCode: outbound.errorCode } : {}),
  };
}
