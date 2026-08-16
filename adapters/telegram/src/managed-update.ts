const MAX_TEXT_LENGTH = 16_384;
const MAX_DISPLAY_NAME_LENGTH = 160;
const MAX_HANDLE_LENGTH = 64;

const UNSUPPORTED_CONTENT_FIELDS = [
  "animation",
  "audio",
  "contact",
  "dice",
  "document",
  "game",
  "invoice",
  "location",
  "paid_media",
  "photo",
  "poll",
  "sticker",
  "story",
  "successful_payment",
  "venue",
  "video",
  "video_note",
  "voice",
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
  replyToId?: string;
  timestamp?: number;
  unsupportedContent: boolean;
};

export type ManagedTelegramUpdateDisposition =
  | { kind: "accepted"; inbound: ManagedTelegramInbound }
  | { kind: "ignored" }
  | { kind: "invalid" };

export function normalizeManagedTelegramUpdate(
  value: unknown,
): ManagedTelegramUpdateDisposition {
  const update = asRecord(value);
  if (!update) return { kind: "invalid" };
  if (!("message" in update)) return { kind: "ignored" };

  const message = asRecord(update.message);
  const chat = asRecord(message?.chat);
  const from = asRecord(message?.from);
  if (!message || !chat || !from) return { kind: "invalid" };
  if (chat.type !== "private" || from.is_bot === true) return { kind: "ignored" };

  const actorId = positiveTelegramId(from.id);
  const surfaceId = positiveTelegramId(chat.id);
  const messageId = positiveIntegerString(message.message_id);
  const sequence = nonNegativeSafeInteger(update.update_id);
  if (!actorId || !surfaceId || !messageId || sequence === null || actorId !== surfaceId) {
    return { kind: "ignored" };
  }

  const text = normalizedText(message.text ?? message.caption);
  const unsupportedContent = UNSUPPORTED_CONTENT_FIELDS.some(
    (field) => message[field] !== undefined,
  ) || !text;
  const reply = asRecord(message.reply_to_message);
  const replyToId = positiveIntegerString(reply?.message_id);
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
      ...(actorName ? { actorName } : {}),
      ...(actorHandle ? { actorHandle } : {}),
      text: text || "",
      ...(replyToId ? { replyToId } : {}),
      ...(timestamp !== undefined ? { timestamp } : {}),
      unsupportedContent,
    },
  };
}

export function isManagedTelegramPairCommand(text: string): boolean {
  const command = text.trim().split(/\s+/, 1)[0]?.toLowerCase();
  return command === "/start" || command === "/connect" || command === "/link";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function positiveTelegramId(value: unknown): string | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? String(value)
    : null;
}

function positiveIntegerString(value: unknown): string | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? String(value)
    : null;
}

function nonNegativeSafeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function normalizedText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, MAX_TEXT_LENGTH) : null;
}

function nonNegativeTimestamp(value: unknown): number | undefined {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= Math.floor(Number.MAX_SAFE_INTEGER / 1000)
    ? value * 1000
    : undefined;
}

function displayName(first: unknown, last: unknown): string | undefined {
  const name = [first, last]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean)
    .join(" ")
    .slice(0, MAX_DISPLAY_NAME_LENGTH);
  return name || undefined;
}

function handle(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replace(/^@/, "").slice(0, MAX_HANDLE_LENGTH);
  return /^[A-Za-z0-9_]{1,64}$/.test(normalized) ? `@${normalized}` : undefined;
}
