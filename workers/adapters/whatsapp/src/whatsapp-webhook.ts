import {
  extractWhatsAppInboundContent,
  type WhatsAppInboundMediaSource,
} from "./whatsapp-inbound-media";
import { maskWhatsAppNumber } from "./managed-config";
import { isWhatsAppPhoneNumber, isWhatsAppUserId } from "./whatsapp-address";
import { WHATSAPP_CHOICE_REPLY_PREFIX } from "./whatsapp-choices";
import { WHATSAPP_TEMPLATE_REPLY_PAYLOAD } from "./whatsapp-template";
import { z } from "zod";

const MAX_TEXT_LENGTH = 16_384;
const MAX_DISPLAY_NAME_LENGTH = 160;
const MAX_USERNAME_LENGTH = 64;
const WAMID_PATTERN = /^[A-Za-z0-9+/=._-]{1,180}$/;
const SIGNATURE_PATTERN = /^sha256=[0-9a-f]{64}$/;
const APPROVAL_REPLY_PREFIX = "gsvh:";

const whatsAppMessageSchema = z.object({
  id: z.string(),
  /** Omitted when the sender has a username and has not shared their number with this business. */
  from: z.string().optional(),
  from_user_id: z.string().optional(),
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
    list_reply: z.object({ id: z.string(), title: z.string().optional() }).passthrough().optional(),
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
  wa_id: z.string().optional(),
  user_id: z.string().optional(),
  profile: z.object({ name: z.string().optional(), username: z.string().optional() }).passthrough().optional(),
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

/**
 * Message types the Cloud API delivers that GSV neither relays nor answers: a reaction is not
 * a message to reply to, and a system notice reports a changed number or user ID.
 */
const SILENT_MESSAGE_TYPES = new Set(["request_welcome", "reaction", "system"]);
/** Media message types relayed as attachments. */
const MEDIA_MESSAGE_TYPES = new Set(["image", "video", "audio", "document", "sticker"]);

/**
 * Who sent a peer event. The actor and surface are the person's address; when that address is
 * a user ID and Meta also shared the number, the number travels beside it so a person known
 * by number before user IDs existed keeps reaching the peer that holds their link.
 */
type WhatsAppSender = {
  actorId: string;
  surfaceId: string;
  phoneNumber?: string;
};

export type ManagedWhatsAppInbound = WhatsAppSender & {
  deliveryId: string;
  messageId: string;
  actorName?: string;
  actorHandle?: string;
  text: string;
  media?: WhatsAppInboundMediaSource[];
  replyToId?: string;
  timestamp?: number;
  unsupportedContent: boolean;
};

/** A reply button pressed on an approval prompt this adapter sent. */
export type WhatsAppApprovalReply = WhatsAppSender & {
  /** The reply message's own id; it identifies one interaction. */
  interactionId: string;
  /** The id of the interactive prompt the person answered. */
  providerMessageId: string;
  data: string;
  timestamp?: number;
};

/**
 * A quick-reply tap on the template GSV sent outside the customer service
 * window. Its visible label is an ordinary user reply to Ship. The persisted
 * event tag stays stable so already-admitted taps keep their deduplication id.
 */
export type WhatsAppTemplateTap = WhatsAppSender & {
  /** Absent only on taps persisted before button text was forwarded. */
  text?: string;
  /** The tap message's own id; it identifies one interaction. */
  interactionId: string;
  /** The id of the template message the person tapped, when Meta relays it. */
  providerMessageId?: string;
  timestamp?: number;
};

export type ManagedWhatsAppPeerEvent =
  | { kind: "message"; inbound: ManagedWhatsAppInbound }
  | { kind: "approval"; reply: WhatsAppApprovalReply }
  | { kind: "release"; tap: WhatsAppTemplateTap };

/** The WhatsApp identity behind one peer event. */
export function whatsAppEventActor(event: ManagedWhatsAppPeerEvent): WhatsAppSender {
  const sender = event.kind === "message" ? event.inbound : event.kind === "approval" ? event.reply : event.tap;
  const actor: WhatsAppSender = { actorId: sender.actorId, surfaceId: sender.surfaceId };
  if (sender.phoneNumber) actor.phoneNumber = sender.phoneNumber;
  return actor;
}

/** The same event addressed to the person's existing peer, which knows them by `address`. */
export function addressWhatsAppEvent(event: ManagedWhatsAppPeerEvent, address: string): ManagedWhatsAppPeerEvent {
  switch (event.kind) {
    case "message": {
      const { phoneNumber: _shared, ...inbound } = event.inbound;
      return { kind: "message", inbound: { ...inbound, actorId: address, surfaceId: address } };
    }
    case "approval": {
      const { phoneNumber: _shared, ...reply } = event.reply;
      return { kind: "approval", reply: { ...reply, actorId: address, surfaceId: address } };
    }
    case "release": {
      const { phoneNumber: _shared, ...tap } = event.tap;
      return { kind: "release", tap: { ...tap, actorId: address, surfaceId: address } };
    }
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
  if (message.group_id || message.context?.group_id) return null;
  const ids = senderIds(message);
  const sender = whatsAppSender(ids);
  if (!sender || SILENT_MESSAGE_TYPES.has(message.type)) return null;
  const messageId = message.id.trim();
  const token = whatsAppDeliveryToken(messageId);
  if (!token) return null;
  const timestamp = timestampMilliseconds(message.timestamp);
  const profile = senderProfile(ids, contacts);

  const choice = tappedChoice(message);
  if (message.type === "interactive" && choice === null) {
    const reply = message.interactive;
    const providerMessageId = message.context?.id?.trim() ?? "";
    if (
      reply?.type !== "button_reply"
      || !reply.button_reply?.id.startsWith(APPROVAL_REPLY_PREFIX)
      || !WAMID_PATTERN.test(providerMessageId)
    ) {
      return unsupported(message.id, token, sender, profile, timestamp);
    }
    return {
      kind: "approval",
      reply: {
        ...sender,
        interactionId: messageId,
        providerMessageId,
        data: reply.button_reply.id,
        timestamp,
      },
    };
  }

  if (message.type === "button") {
    if (message.button?.payload?.trim() !== WHATSAPP_TEMPLATE_REPLY_PAYLOAD) {
      return unsupported(message.id, token, sender, profile, timestamp);
    }
    const providerMessageId = message.context?.id?.trim();
    const tap: WhatsAppTemplateTap = {
      ...sender, interactionId: messageId, timestamp,
      text: normalizedText(message.button?.text) ?? undefined,
    };
    if (providerMessageId && WAMID_PATTERN.test(providerMessageId)) tap.providerMessageId = providerMessageId;
    return { kind: "release", tap };
  }

  const content = choice !== null
    ? { text: choice, media: [] }
    : message.type === "text" || MEDIA_MESSAGE_TYPES.has(message.type)
      ? extractWhatsAppInboundContent(message)
      : { text: message.type === "location" ? locationText(message.location) : null, media: [] };
  const text = normalizedText(content.text);
  const unsupportedContent = !text;
  const replyToId = message.context?.id?.trim();
  const inbound: ManagedWhatsAppInbound = {
    deliveryId: `message:${token}`,
    messageId,
    ...sender,
    ...profile,
    text: text ?? "",
    media: content.media.length > 0 ? content.media : undefined,
    replyToId: replyToId && WAMID_PATTERN.test(replyToId) ? replyToId : undefined,
    timestamp,
    unsupportedContent,
  };
  return { kind: "message", inbound };
}

/** A tap on a reply button or list row that offered a choice is the person replying with its title. */
function tappedChoice(message: z.infer<typeof whatsAppMessageSchema>): string | null {
  const interactive = message.type === "interactive" ? message.interactive : undefined;
  const reply = interactive?.type === "button_reply"
    ? interactive.button_reply
    : interactive?.type === "list_reply" ? interactive.list_reply : undefined;
  return reply?.id.startsWith(WHATSAPP_CHOICE_REPLY_PREFIX) ? reply.title ?? "" : null;
}

function unsupported(
  messageId: string,
  token: string,
  sender: WhatsAppSender,
  profile: SenderProfile,
  timestamp: number | undefined,
): ManagedWhatsAppPeerEvent {
  return {
    kind: "message",
    inbound: {
      deliveryId: `message:${token}`,
      messageId: messageId.trim(),
      ...sender,
      ...profile,
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

type SenderIds = { phoneNumber?: string; userId?: string };
type SenderProfile = { actorName?: string; actorHandle?: string };

/** The valid number and user ID a message names; Meta withholds the number from some username senders. */
function senderIds(message: z.infer<typeof whatsAppMessageSchema>): SenderIds {
  const ids: SenderIds = {};
  if (isWhatsAppPhoneNumber(message.from)) ids.phoneNumber = message.from;
  if (isWhatsAppUserId(message.from_user_id)) ids.userId = message.from_user_id;
  return ids;
}

/**
 * The person's address and, when that address is their user ID, the number Meta shared beside
 * it. A message carrying neither a valid number nor a valid user ID names nobody.
 */
function whatsAppSender({ phoneNumber, userId }: SenderIds): WhatsAppSender | null {
  if (userId) {
    const sender: WhatsAppSender = { actorId: userId, surfaceId: userId };
    if (phoneNumber) sender.phoneNumber = phoneNumber;
    return sender;
  }
  return phoneNumber ? { actorId: phoneNumber, surfaceId: phoneNumber } : null;
}

/** How Ship shows the sender: their profile name, and their masked number or else their username. */
function senderProfile(
  { phoneNumber, userId }: SenderIds,
  contacts: z.infer<typeof whatsAppContactSchema>[],
): SenderProfile {
  const contact = contacts.find((entry) => (phoneNumber !== undefined && entry.wa_id === phoneNumber)
    || (userId !== undefined && entry.user_id === userId))
    ?? (contacts.length === 1 ? contacts[0] : undefined);
  const name = contact?.profile?.name?.trim().slice(0, MAX_DISPLAY_NAME_LENGTH);
  const username = contact?.profile?.username?.trim().replace(/^@/, "").slice(0, MAX_USERNAME_LENGTH);
  const profile: SenderProfile = {};
  if (name) profile.actorName = name;
  const handle = phoneNumber ? maskWhatsAppNumber(phoneNumber) : username ? `@${username}` : "";
  if (handle) profile.actorHandle = handle;
  return profile;
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
