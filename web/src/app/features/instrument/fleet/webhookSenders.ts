import type { EventSource, WebhookHmac } from "@humansandmachines/gsv/protocol";

/**
 * Senders whose signatures are known, each as the hmac scheme it uses. Only these presets name
 * a sender; a source stores the scheme, so any other sender that signs the same way works too.
 */
export const WEBHOOK_SENDERS = [
  {
    id: "github",
    name: "GitHub",
    hmac: { header: "x-hub-signature-256", encoding: "hex", prefix: "sha256=", idHeader: "x-github-delivery", typeHeader: "x-github-event" },
    senderSecret: false,
  },
  {
    id: "stripe",
    name: "Stripe",
    hmac: { header: "stripe-signature", encoding: "hex", pairs: { timestamp: "t", signature: "v1" } },
    senderSecret: true,
  },
  {
    id: "shopify",
    name: "Shopify",
    hmac: { header: "x-shopify-hmac-sha256", encoding: "base64", idHeader: "x-shopify-webhook-id", typeHeader: "x-shopify-topic" },
    senderSecret: true,
  },
  {
    id: "linear",
    name: "Linear",
    hmac: { header: "linear-signature", encoding: "hex", idHeader: "linear-delivery", typeHeader: "linear-event" },
    senderSecret: true,
  },
] as const satisfies ReadonlyArray<{ id: string; name: string; hmac: WebhookHmac; senderSecret: boolean }>;

export type WebhookSender = (typeof WEBHOOK_SENDERS)[number];

const sameHmac = (left: WebhookHmac, right: WebhookHmac) =>
  left.header === right.header && left.encoding === right.encoding && (left.prefix ?? "") === (right.prefix ?? "")
  && left.pairs?.timestamp === right.pairs?.timestamp && left.pairs?.signature === right.pairs?.signature
  && left.idHeader === right.idHeader && left.typeHeader === right.typeHeader;

/** The preset a source was made from, when its scheme is exactly one of theirs. */
export function senderOf(source: EventSource): WebhookSender | undefined {
  const { hmac } = source;
  return hmac ? WEBHOOK_SENDERS.find((sender) => sameHmac(sender.hmac, hmac)) : undefined;
}
