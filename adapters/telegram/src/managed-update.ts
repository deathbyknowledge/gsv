import {
  extractTelegramInboundContent,
  type TelegramInboundMediaSource,
} from "./telegram-inbound-media";
import { z } from "zod";

const MAX_TEXT_LENGTH = 16_384;
const MAX_DISPLAY_NAME_LENGTH = 160;
const MAX_HANDLE_LENGTH = 64;

const telegramManagedMessageSchema = z.object({
  message_id: z.number(), date: z.number(),
  chat: z.object({ id: z.number(), type: z.string() }).passthrough(),
  from: z.object({ id: z.number(), is_bot: z.boolean(), first_name: z.string().optional(), last_name: z.string().optional(), username: z.string().optional() }).passthrough(),
  reply_to_message: z.object({ message_id: z.number() }).passthrough().optional(),
}).passthrough();
const telegramManagedUpdateSchema = z.object({ update_id: z.number(), message: telegramManagedMessageSchema.optional() }).passthrough();

const UNSUPPORTED_CONTENT_FIELDS = [
  "contact",
  "dice",
  "game",
  "invoice",
  "location",
  "paid_media",
  "poll",
  "story",
  "successful_payment",
  "venue",
] as const;

export type ManagedTelegramInbound = {
  deliveryId: string;
  sequence: number;
  messageId: string;
  actorId: string;
  surfaceId: string;
  actorName?: string;
  actorHandle?: string;
  text: string;
  media?: TelegramInboundMediaSource[];
  replyToId?: string;
  timestamp?: number;
  unsupportedContent: boolean;
};

export type ManagedTelegramUpdateDisposition =
  | { kind: "accepted"; inbound: ManagedTelegramInbound }
  | { kind: "ignored" }
  | { kind: "invalid" };

export function normalizeManagedTelegramUpdate<T>(
  value: T,
): ManagedTelegramUpdateDisposition {
  const parsed = telegramManagedUpdateSchema.safeParse(value);
  if (!parsed.success) return { kind: "invalid" };
  const update = parsed.data;
  if (!update.message) return { kind: "ignored" };

  const message = update.message;
  const chat = message.chat;
  const from = message.from;
  if (chat.type !== "private" || from.is_bot === true) return { kind: "ignored" };

  const actorId = positiveTelegramId(from.id);
  const surfaceId = positiveTelegramId(chat.id);
  const messageId = positiveIntegerString(message.message_id);
  const sequence = nonNegativeSafeInteger(update.update_id);
  if (!actorId || !surfaceId || !messageId || sequence === null || actorId !== surfaceId) {
    return { kind: "ignored" };
  }

  const content = extractTelegramInboundContent(message, messageId);
  const text = normalizedText(content.text);
  const unsupportedContent = UNSUPPORTED_CONTENT_FIELDS.some(
    (field) => message[field] !== undefined,
  ) || !text;
  const replyToId = positiveIntegerString(message.reply_to_message?.message_id);
  const timestamp = nonNegativeTimestamp(message.date);
  const actorName = displayName(from.first_name, from.last_name);
  const actorHandle = handle(from.username);

  return {
    kind: "accepted",
    inbound: {
      deliveryId: `update:${String(sequence).padStart(16, "0")}`,
      sequence,
      messageId,
      actorId,
      surfaceId,
      actorName,
      actorHandle,
      text: text || "",
      media: content.media.length > 0 ? content.media : undefined,
      replyToId: replyToId ?? undefined,
      timestamp,
      unsupportedContent,
    },
  };
}

export function isManagedTelegramPairCommand(text: string): boolean {
  const command = text.trim().split(/\s+/, 1)[0]?.toLowerCase();
  return command === "/start" || command === "/connect" || command === "/link";
}

function positiveTelegramId(value: number): string | null {
  return Number.isSafeInteger(value) && value > 0
    ? String(value)
    : null;
}

function positiveIntegerString(value: number | undefined): string | null {
  return value !== undefined && Number.isSafeInteger(value) && value > 0
    ? String(value)
    : null;
}

function nonNegativeSafeInteger(value: number): number | null {
  return Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function normalizedText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, MAX_TEXT_LENGTH) : null;
}

function nonNegativeTimestamp(value: number): number | undefined {
  return Number.isSafeInteger(value)
    && value >= 0
    && value <= Math.floor(Number.MAX_SAFE_INTEGER / 1000)
    ? value * 1000
    : undefined;
}

function displayName(first: string | undefined, last: string | undefined): string | undefined {
  const name = [first, last]
    .filter((value): value is string => value !== undefined)
    .map((value) => value.trim())
    .filter(Boolean)
    .join(" ")
    .slice(0, MAX_DISPLAY_NAME_LENGTH);
  return name || undefined;
}

function handle(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().replace(/^@/, "").slice(0, MAX_HANDLE_LENGTH);
  return /^[A-Za-z0-9_]{1,64}$/.test(normalized) ? `@${normalized}` : undefined;
}
