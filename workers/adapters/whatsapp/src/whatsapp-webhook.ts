import {
  extractWhatsAppInboundContent,
  type WhatsAppInboundMediaSource,
} from "./whatsapp-inbound-media";
import { maskWhatsAppNumber } from "./managed-config";
import { WHATSAPP_TEMPLATE_RELEASE_PAYLOAD } from "./whatsapp-template";
import { z } from "zod";

const MAX_TEXT_LENGTH = 16_384;
const MAX_DISPLAY_NAME_LENGTH = 160;
const WA_ID_PATTERN = /^[1-9][0-9]{4,14}$/;
const WAMID_PATTERN = /^[A-Za-z0-9+/=._-]{1,180}$/;
const SIGNATURE_PATTERN = /^sha256=[0-9a-f]{64}$/;
const APPROVAL_REPLY_PREFIX = "gsvh:";

const whatsAppMessageSchema = z.object({
  id: z.string(),
  from: z.string(),
  timestamp: z.string().optional(),
  type: z.string(),
  group_id: z.string().optional(),
  text: z.object({ body: z.string().optional() }).passthrough().optional(),
  location: z.object({
    latitude: z.number(),
    longitude: z.number(),
    name: z.string().optional(),
    address: z.string().optional(),
  }).passthrough().optional(),
  interactive: z.object({
    type: z.string(),
    button_reply: z.object({ id: z.string(), title: z.string().optional() }).passthrough().optional(),
  }).passthrough().optional(),
  /** A quick-reply tap on a template message arrives as its own message type. */
  button: z.object({
    payload: z.string().optional(),
    text: z.string().optional(),
  }).passthrough().optional(),
  context: z.object({
    from: z.string().optional(),
    id: z.string().optional(),
    group_id: z.string().optional(),
  }).passthrough().optional(),
}).passthrough();
const whatsAppContactSchema = z.object({
  wa_id: z.string(),
  profile: z.object({ name: z.string().optional() }).passthrough().optional(),
}).passthrough();
const whatsAppMessagesValueSchema = z.object({
  metadata: z.object({ phone_number_id: z.string() }).passthrough(),
  group_id: z.string().optional(),
  contacts: z.array(whatsAppContactSchema).optional(),
  messages: z.array(z.unknown()).optional(),
  statuses: z.array(z.unknown()).optional(),
}).passthrough();
const whatsAppChangeSchema = z.object({
  field: z.string(),
  value: z.unknown(),
}).passthrough();
const whatsAppWebhookSchema = z.object({
  object: z.literal("whatsapp_business_account"),
  entry: z.array(z.object({
    id: z.string(),
    changes: z.array(whatsAppChangeSchema),
  }).passthrough()),
}).passthrough();

/** Message types the Cloud API delivers that GSV neither relays nor answers. */
const SILENT_MESSAGE_TYPES = new Set(["request_welcome"]);
/** Media message types relayed as attachments. */
const MEDIA_MESSAGE_TYPES = new Set(["image", "video", "audio", "document", "sticker"]);

export type ManagedWhatsAppInbound = {
  deliveryId: string;
  messageId: string;
  actorId: string;
  surfaceId: string;
  actorName?: string;
  actorHandle?: string;
  text: string;
  media?: WhatsAppInboundMediaSource[];
  replyToId?: string;
  timestamp?: number;
  unsupportedContent: boolean;
};

/** A reply button pressed on an approval prompt this adapter sent. */
export type WhatsAppApprovalReply = {
  /** The reply message's own id; it identifies one interaction. */
  interactionId: string;
  actorId: string;
  surfaceId: string;
  /** The id of the interactive prompt the person answered. */
  providerMessageId: string;
  data: string;
  timestamp?: number;
};

/**
 * A quick-reply tap on the template GSV sent outside the customer service
 * window. It reopens the window and releases the held messages; it is not
 * relayed to the Process.
 */
export type WhatsAppTemplateTap = {
  /** The tap message's own id; it identifies one interaction. */
  interactionId: string;
  actorId: string;
  surfaceId: string;
  /** The id of the template message the person tapped, when Meta relays it. */
  providerMessageId?: string;
  timestamp?: number;
};

export type ManagedWhatsAppPeerEvent =
  | { kind: "message"; inbound: ManagedWhatsAppInbound }
  | { kind: "approval"; reply: WhatsAppApprovalReply }
  | { kind: "release"; tap: WhatsAppTemplateTap };

/** The WhatsApp identity behind one peer event. */
export type WhatsAppEventActor = { actorId: string; surfaceId: string };

export function whatsAppEventActor(event: ManagedWhatsAppPeerEvent): WhatsAppEventActor {
  switch (event.kind) {
    case "message":
      return { actorId: event.inbound.actorId, surfaceId: event.inbound.surfaceId };
    case "approval":
      return { actorId: event.reply.actorId, surfaceId: event.reply.surfaceId };
    case "release":
      return { actorId: event.tap.actorId, surfaceId: event.tap.surfaceId };
  }
}

export type ManagedWhatsAppWebhookDisposition =
  | { kind: "accepted"; events: ManagedWhatsAppPeerEvent[] }
  | { kind: "ignored" }
  | { kind: "invalid" };

/** Answers Meta's subscription handshake for the configured verify token. */
export function answerWhatsAppVerification(url: URL, verifyToken: string): Response {
  const mode = url.searchParams.get("hub.mode");
  const presented = url.searchParams.get("hub.verify_token") ?? "";
  const challenge = url.searchParams.get("hub.challenge") ?? "";
  if (
    mode !== "subscribe"
    || !challenge
    || challenge.length > 256
    || !constantTimeEqual(presented, verifyToken)
  ) {
    return new Response("Forbidden", { status: 403 });
  }
  return new Response(challenge, {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export function validWhatsAppSignatureHeader(value: string | null): value is string {
  return value !== null && SIGNATURE_PATTERN.test(value.trim());
}

/** Compares `X-Hub-Signature-256` against the HMAC of the exact bytes Meta sent. */
export async function verifyWhatsAppSignature(
  header: string | null,
  rawBody: Uint8Array,
  appSecret: string,
): Promise<boolean> {
  if (!validWhatsAppSignatureHeader(header) || !appSecret) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, rawBody));
  const expected = `sha256=${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  return constantTimeEqual(header.trim(), expected);
}

/**
 * Normalizes one Cloud API webhook payload into peer events. Only `messages`
 * changes for the configured phone number produce events; statuses, other
 * numbers on the business account, and group traffic are dropped.
 */
export function normalizeWhatsAppWebhook<T>(
  value: T,
  phoneNumberId: string,
): ManagedWhatsAppWebhookDisposition {
  const parsed = whatsAppWebhookSchema.safeParse(value);
  if (!parsed.success) return { kind: "invalid" };
  const events: ManagedWhatsAppPeerEvent[] = [];
  for (const entry of parsed.data.entry) {
    for (const change of entry.changes) {
      if (change.field !== "messages") continue;
      const payload = whatsAppMessagesValueSchema.safeParse(change.value);
      if (!payload.success) return { kind: "invalid" };
      const messagesValue = payload.data;
      if (messagesValue.metadata.phone_number_id !== phoneNumberId || messagesValue.group_id) continue;
      for (const candidate of messagesValue.messages ?? []) {
        // Individual messages are parsed one at a time so one unfamiliar shape
        // does not reject the other messages in the same notification.
        const message = whatsAppMessageSchema.safeParse(candidate);
        if (!message.success) continue;
        const event = normalizeMessage(message.data, messagesValue.contacts ?? []);
        if (event) events.push(event);
      }
    }
  }
  return events.length > 0 ? { kind: "accepted", events } : { kind: "ignored" };
}

export function isManagedWhatsAppPairCommand(text: string): boolean {
  const command = text.trim().split(/\s+/, 1)[0]?.toLowerCase();
  return command === "/start" || command === "/connect" || command === "/link";
}

/** Derives the stable account-scoped ingress id from one provider message id. */
export function whatsAppDeliveryToken(messageId: string): string | null {
  if (!WAMID_PATTERN.test(messageId)) return null;
  return messageId.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+/g, "");
}

function normalizeMessage(
  message: z.infer<typeof whatsAppMessageSchema>,
  contacts: z.infer<typeof whatsAppContactSchema>[],
): ManagedWhatsAppPeerEvent | null {
  if (message.group_id || message.context?.group_id || !WA_ID_PATTERN.test(message.from)) return null;
  if (SILENT_MESSAGE_TYPES.has(message.type)) return null;
  const messageId = message.id.trim();
  const token = whatsAppDeliveryToken(messageId);
  if (!token) return null;
  const actorId = message.from;
  const timestamp = timestampMilliseconds(message.timestamp);

  if (message.type === "interactive") {
    const reply = message.interactive;
    const providerMessageId = message.context?.id?.trim() ?? "";
    if (
      reply?.type !== "button_reply"
      || !reply.button_reply?.id.startsWith(APPROVAL_REPLY_PREFIX)
      || !WAMID_PATTERN.test(providerMessageId)
    ) {
      return unsupported(message.id, token, actorId, contacts, timestamp);
    }
    return {
      kind: "approval",
      reply: {
        interactionId: messageId,
        actorId,
        surfaceId: actorId,
        providerMessageId,
        data: reply.button_reply.id,
        timestamp,
      },
    };
  }

  if (message.type === "button") {
    if (message.button?.payload?.trim() !== WHATSAPP_TEMPLATE_RELEASE_PAYLOAD) {
      return unsupported(message.id, token, actorId, contacts, timestamp);
    }
    const providerMessageId = message.context?.id?.trim();
    const tap: WhatsAppTemplateTap = { interactionId: messageId, actorId, surfaceId: actorId, timestamp };
    if (providerMessageId && WAMID_PATTERN.test(providerMessageId)) tap.providerMessageId = providerMessageId;
    return { kind: "release", tap };
  }

  const content = message.type === "text" || MEDIA_MESSAGE_TYPES.has(message.type)
    ? extractWhatsAppInboundContent(message)
    : { text: message.type === "location" ? locationText(message.location) : null, media: [] };
  const text = normalizedText(content.text);
  const unsupportedContent = !text;
  const replyToId = message.context?.id?.trim();
  const inbound: ManagedWhatsAppInbound = {
    deliveryId: `message:${token}`,
    messageId,
    actorId,
    surfaceId: actorId,
    actorName: contactName(contacts, actorId),
    actorHandle: maskWhatsAppNumber(actorId) || undefined,
    text: text ?? "",
    media: content.media.length > 0 ? content.media : undefined,
    replyToId: replyToId && WAMID_PATTERN.test(replyToId) ? replyToId : undefined,
    timestamp,
    unsupportedContent,
  };
  return { kind: "message", inbound };
}

function unsupported(
  messageId: string,
  token: string,
  actorId: string,
  contacts: z.infer<typeof whatsAppContactSchema>[],
  timestamp: number | undefined,
): ManagedWhatsAppPeerEvent {
  return {
    kind: "message",
    inbound: {
      deliveryId: `message:${token}`,
      messageId: messageId.trim(),
      actorId,
      surfaceId: actorId,
      actorName: contactName(contacts, actorId),
      actorHandle: maskWhatsAppNumber(actorId) || undefined,
      text: "",
      timestamp,
      unsupportedContent: true,
    },
  };
}

function locationText(
  location: z.infer<typeof whatsAppMessageSchema>["location"],
): string | null {
  if (!location || !Number.isFinite(location.latitude) || !Number.isFinite(location.longitude)) return null;
  const coordinates = `${location.latitude.toFixed(6)}, ${location.longitude.toFixed(6)}`;
  const label = [location.name, location.address]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value))
    .join(", ");
  return label ? `Location: ${coordinates} (${label})` : `Location: ${coordinates}`;
}

function contactName(
  contacts: z.infer<typeof whatsAppContactSchema>[],
  actorId: string,
): string | undefined {
  const contact = contacts.find((entry) => entry.wa_id === actorId)
    ?? (contacts.length === 1 ? contacts[0] : undefined);
  const name = contact?.profile?.name?.trim().slice(0, MAX_DISPLAY_NAME_LENGTH);
  return name || undefined;
}

function normalizedText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, MAX_TEXT_LENGTH) : null;
}

function timestampMilliseconds(value: string | undefined): number | undefined {
  if (value === undefined || !/^[0-9]{1,12}$/.test(value)) return undefined;
  return Number(value) * 1000;
}

function constantTimeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}
