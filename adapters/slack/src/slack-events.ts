import type { AdapterSurface } from "./types";
import { requireSlackId, requireSlackTimestamp } from "./slack-api";
import { z } from "zod";

const MAX_TEXT_LENGTH = 16_384;

const slackMessageEventSchema = z.object({
  type: z.string(),
  user: z.string().optional(),
  channel: z.string().optional(),
  channel_type: z.string().optional(),
  text: z.string().optional(),
  ts: z.string().optional(),
  event_ts: z.string().optional(),
  thread_ts: z.string().optional(),
  subtype: z.string().optional(),
  bot_id: z.string().optional(),
  hidden: z.boolean().optional(),
}).passthrough();

const slackEventCallbackSchema = z.object({
  type: z.literal("event_callback"),
  team_id: z.string(),
  api_app_id: z.string().optional(),
  event_id: z.string(),
  event_time: z.number(),
  event: slackMessageEventSchema,
}).passthrough();

const slackUrlVerificationSchema = z.object({
  type: z.literal("url_verification"),
  challenge: z.string().min(1).max(1_024),
}).passthrough();

export type SlackEventCallback = z.infer<typeof slackEventCallbackSchema>;

export type SlackInbound = {
  deliveryId: string;
  eventId: string;
  teamId: string;
  messageId: string;
  actorId: string;
  surface: AdapterSurface;
  text: string;
  replyToId?: string;
  timestamp?: number;
  wasMentioned: true;
};

export type SlackEventDisposition =
  | { kind: "accepted"; inbound: SlackInbound }
  | { kind: "uninstalled"; teamId: string; eventId: string }
  | { kind: "ignored" }
  | { kind: "invalid" };

export function parseSlackUrlVerification<T>(value: T): string | null {
  const parsed = slackUrlVerificationSchema.safeParse(value);
  return parsed.success ? parsed.data.challenge : null;
}

export function parseSlackEventCallback<T>(value: T): SlackEventCallback | null {
  const parsed = slackEventCallbackSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function normalizeSlackEvent<T>(
  value: T,
  botUserId: string,
): SlackEventDisposition {
  const parsed = slackEventCallbackSchema.safeParse(value);
  if (!parsed.success) return { kind: "invalid" };
  const envelope = parsed.data;

  let teamId: string;
  let normalizedBotUserId: string;
  try {
    teamId = requireSlackId(envelope.team_id, "Slack workspace");
    normalizedBotUserId = requireSlackId(botUserId, "Slack bot user");
  } catch {
    return { kind: "invalid" };
  }
  if (!/^Ev[A-Z0-9]{1,62}$/.test(envelope.event_id)) return { kind: "invalid" };
  if (envelope.event.type === "app_uninstalled") {
    return { kind: "uninstalled", teamId, eventId: envelope.event_id };
  }

  const event = envelope.event;
  const isMention = event.type === "app_mention";
  const isDm = event.type === "message" && event.channel_type === "im";
  if (!isMention && !isDm) return { kind: "ignored" };
  if (event.subtype || event.bot_id || event.hidden === true) return { kind: "ignored" };

  let actorId: string;
  let channelId: string;
  let messageId: string;
  try {
    actorId = requireSlackId(event.user, "Slack actor");
    channelId = requireSlackId(event.channel, "Slack channel");
    messageId = requireSlackTimestamp(event.ts);
  } catch {
    return { kind: "invalid" };
  }
  if (actorId === normalizedBotUserId) return { kind: "ignored" };

  let threadTs: string | undefined;
  try {
    threadTs = event.thread_ts
      ? requireSlackTimestamp(event.thread_ts)
      : isMention ? messageId : undefined;
  } catch {
    return { kind: "invalid" };
  }
  const surface: AdapterSurface = {
    kind: isDm ? "dm" : "channel",
    id: channelId,
  };
  if (threadTs) surface.threadId = threadTs;

  const rawText = event.text ?? "";
  const withoutMention = isMention
    ? rawText.replace(new RegExp(`<@${escapeRegExp(normalizedBotUserId)}>`, "g"), " ")
    : rawText;
  const text = decodeSlackText(withoutMention).trim().slice(0, MAX_TEXT_LENGTH)
    || (isMention ? "[Mention]" : "[Message]");
  const timestamp = slackTimestampMilliseconds(messageId)
    ?? safeEpochMilliseconds(envelope.event_time);
  return {
    kind: "accepted",
    inbound: {
      deliveryId: `event:${envelope.event_id}`,
      eventId: envelope.event_id,
      teamId,
      messageId,
      actorId,
      surface,
      text,
      replyToId: event.thread_ts ? messageId : undefined,
      timestamp,
      wasMentioned: true,
    },
  };
}

export function isSlackPairCommand(inbound: SlackInbound): boolean {
  if (inbound.surface.kind !== "dm") return false;
  return /^(?:\/?(?:link|connect|start))$/i.test(inbound.text.trim());
}

function slackTimestampMilliseconds(value: string): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > Number.MAX_SAFE_INTEGER / 1_000) {
    return undefined;
  }
  return Math.floor(parsed * 1_000);
}

function safeEpochMilliseconds(value: number): number | undefined {
  return Number.isSafeInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER / 1_000
    ? value * 1_000
    : undefined;
}

function decodeSlackText(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
