import type {
  MailOutboundStatus,
  MailSentArgs,
  MailSentResult,
  MailStatusArgs,
  MailStatusResult,
} from "@humansandmachines/gsv/protocol";
import { resolveCallerOwnerUid, type CallerOwnerContext } from "./context";
import { parseMailPageArgs } from "./inbound-mail-read";
import type { MailboxStore, MailOutboundRecord } from "./mailbox-store";
import * as z from "zod/mini";

const MAX_OUTBOUND_IDENTIFIER_BYTES = 256;
const TEXT_ENCODER = new TextEncoder();
const mailStatusArgsSchema = z.object({ deliveryId: z.string() });

export type MailStatusContext = CallerOwnerContext & {
  mailboxes: MailboxStore;
};

export function handleMailStatus(
  value: MailStatusArgs,
  ctx: MailStatusContext,
): MailStatusResult {
  const deliveryId = normalizeDeliveryId(value);
  const ownerUid = resolveCallerOwnerUid(ctx);
  const outbound = ctx.mailboxes.getOutboundForDelivery(ownerUid, deliveryId);
  return { outbound: outbound ? publicOutboundStatus(outbound) : null };
}

export function handleMailSent(value: MailSentArgs, ctx: MailStatusContext): MailSentResult {
  const ownerUid = resolveCallerOwnerUid(ctx);
  const page = ctx.mailboxes.listOutbound(ownerUid, parseMailPageArgs(value, "mail.sent"));
  const outbound = page.outbound.map(publicOutboundStatus);
  return page.next === undefined ? { outbound } : { outbound, next: page.next };
}

function normalizeDeliveryId(value: MailStatusArgs): string {
  const parsed = mailStatusArgsSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("mail.status requires an object with a deliveryId");
  }
  const deliveryId = parsed.data.deliveryId.trim();
  if (
    !deliveryId
    || TEXT_ENCODER.encode(deliveryId).byteLength > MAX_OUTBOUND_IDENTIFIER_BYTES
    || [...deliveryId].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    throw new Error("deliveryId is invalid");
  }
  return deliveryId;
}

function publicOutboundStatus(outbound: MailOutboundRecord): MailOutboundStatus {
  const result: MailOutboundStatus = {
    deliveryId: outbound.deliveryId,
    outboundId: outbound.outboundId,
    state: outbound.state,
    from: outbound.from,
    to: outbound.to.join(", "),
    subject: outbound.subject,
    textPath: outbound.bodyPath,
    createdAt: outbound.createdAt,
    queuedAt: outbound.queuedAt,
    completedAt: outbound.completedAt,
  };
  if (outbound.cc.length > 0) result.cc = outbound.cc.join(", ");
  if (outbound.providerMessageId) result.providerMessageId = outbound.providerMessageId;
  if (outbound.errorCode) result.errorCode = outbound.errorCode;
  return result;
}
