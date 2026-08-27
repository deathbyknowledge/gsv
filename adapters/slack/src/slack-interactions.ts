import {
  requireSlackId,
  requireSlackTimestamp,
} from "./slack-api";
import type { SlackInbound } from "./slack-events";
import { z } from "zod";

const APPROVE_ACTION_ID = "gsv_hil_approve";
const APPROVE_ALWAYS_ACTION_ID = "gsv_hil_approve_always";
const DENY_ACTION_ID = "gsv_hil_deny";
const APPROVAL_TOKEN_PATTERN = /^hil\[[^\]\s]{1,180}\]$/;
const ROUTE_GENERATION_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,190}[A-Za-z0-9])?$/;
const MAX_BLOCK_TEXT_LENGTH = 3_000;

export type SlackApprovalAction = "approve" | "approve_always" | "deny";

export type SlackBlock =
  | {
      type: "section";
      text: { type: "mrkdwn"; text: string };
    }
  | {
      type: "actions";
      block_id: "gsv_hil_decision";
      elements: Array<{
        type: "button";
        action_id: string;
        text: { type: "plain_text"; text: string; emoji: true };
        value: string;
        style?: "primary" | "danger";
      }>;
    }
  | {
      type: "context";
      elements: Array<{ type: "mrkdwn"; text: string }>;
    };

const approvalValueSchema = z.object({
  v: z.literal(1),
  token: z.string().regex(APPROVAL_TOKEN_PATTERN),
  routeGeneration: z.string().regex(ROUTE_GENERATION_PATTERN).optional(),
}).strict();

const blockActionSchema = z.object({
  type: z.literal("block_actions"),
  team: z.object({ id: z.string() }).passthrough(),
  user: z.object({ id: z.string() }).passthrough(),
  channel: z.object({ id: z.string() }).passthrough(),
  container: z.object({
    type: z.literal("message"),
    channel_id: z.string(),
    message_ts: z.string(),
    thread_ts: z.string().optional(),
  }).passthrough(),
  message: z.object({
    user: z.string(),
    text: z.string().max(MAX_BLOCK_TEXT_LENGTH),
    ts: z.string(),
    thread_ts: z.string().optional(),
  }).passthrough(),
  actions: z.array(z.object({
    type: z.literal("button"),
    action_id: z.string(),
    value: z.string().max(2_000),
    action_ts: z.string(),
  }).passthrough()).length(1),
}).passthrough();

export type SlackInteractionDisposition =
  | { kind: "accepted"; inbound: SlackInbound }
  | { kind: "ignored" }
  | { kind: "invalid" };

export function buildSlackApprovalBlocks(
  text: string,
  routeGeneration?: string,
): SlackBlock[] | undefined {
  const token = approvalTokenFromPrompt(text);
  if (!token || text.length > MAX_BLOCK_TEXT_LENGTH) return undefined;
  if (routeGeneration && !ROUTE_GENERATION_PATTERN.test(routeGeneration)) return undefined;
  const value = JSON.stringify({
    v: 1,
    token,
    ...(routeGeneration ? { routeGeneration } : undefined),
  });
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text },
    },
    {
      type: "actions",
      block_id: "gsv_hil_decision",
      elements: [
        approvalButton("Approve once", APPROVE_ACTION_ID, value, "primary"),
        approvalButton("Always approve", APPROVE_ALWAYS_ACTION_ID, value),
        approvalButton("Deny", DENY_ACTION_ID, value, "danger"),
      ],
    },
  ];
}

export function buildSlackApprovalSubmittedMessage(
  sourceText: string,
  action: SlackApprovalAction,
): { text: string; blocks: SlackBlock[] } {
  const status = `Decision submitted: ${approvalActionLabel(action)}.`;
  const text = `${sourceText.trim()}\n\n${status}`.trim().slice(0, 40_000);
  const blocks: SlackBlock[] = [];
  if (sourceText.trim().length <= MAX_BLOCK_TEXT_LENGTH) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: sourceText.trim() },
    });
  }
  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: `_${status}_` }],
  });
  return { text, blocks };
}

export function normalizeSlackInteraction<T>(
  value: T,
  botUserIdInput: string,
): SlackInteractionDisposition {
  const base = z.object({ type: z.string() }).passthrough().safeParse(value);
  if (!base.success) return { kind: "invalid" };
  if (base.data.type !== "block_actions") return { kind: "ignored" };
  const parsed = blockActionSchema.safeParse(value);
  if (!parsed.success) return { kind: "invalid" };
  const payload = parsed.data;
  const action = approvalAction(payload.actions[0]!.action_id);
  if (!action) return { kind: "ignored" };

  const decoded = parseApprovalValue(payload.actions[0]!.value);
  if (!decoded) return { kind: "invalid" };
  if (approvalTokenFromPrompt(payload.message.text) !== decoded.token) {
    return { kind: "invalid" };
  }
  let teamId: string;
  let actorId: string;
  let channelId: string;
  let botUserId: string;
  let sourceMessageId: string;
  let actionMessageId: string;
  let threadId: string | undefined;
  try {
    teamId = requireSlackId(payload.team.id, "Slack workspace");
    actorId = requireSlackId(payload.user.id, "Slack actor");
    channelId = requireSlackId(payload.channel.id, "Slack channel");
    botUserId = requireSlackId(botUserIdInput, "Slack bot user");
    sourceMessageId = requireSlackTimestamp(payload.message.ts);
    actionMessageId = requireSlackTimestamp(payload.actions[0]!.action_ts);
    const rawThreadId = payload.container.thread_ts ?? payload.message.thread_ts;
    threadId = rawThreadId ? requireSlackTimestamp(rawThreadId) : undefined;
    if (
      !channelId.startsWith("D")
      || requireSlackId(payload.container.channel_id, "Slack interaction channel") !== channelId
      || requireSlackTimestamp(payload.container.message_ts) !== sourceMessageId
      || requireSlackId(payload.message.user, "Slack message author") !== botUserId
    ) {
      return { kind: "invalid" };
    }
  } catch {
    return { kind: "invalid" };
  }

  const surface: SlackInbound["surface"] = { kind: "dm", id: channelId };
  if (threadId) surface.threadId = threadId;
  const decisionText = action === "approve"
    ? `approve ${decoded.token}`
    : action === "approve_always"
      ? `approve always ${decoded.token}`
      : `deny ${decoded.token}`;
  return {
    kind: "accepted",
    inbound: {
      deliveryId: `interaction:${sourceMessageId}:${actionMessageId}`,
      eventId: `interaction:${actionMessageId}`,
      teamId,
      messageId: actionMessageId,
      actorId,
      surface,
      text: decisionText,
      replyToId: sourceMessageId,
      timestamp: slackTimestampMilliseconds(actionMessageId),
      wasMentioned: true,
      interaction: {
        sourceMessageId,
        sourceText: payload.message.text,
        action,
        expectedRouteGeneration: decoded.routeGeneration,
      },
    },
  };
}

function approvalButton(
  text: string,
  actionId: string,
  value: string,
  style?: "primary" | "danger",
): Extract<SlackBlock, { type: "actions" }>["elements"][number] {
  return {
    type: "button",
    action_id: actionId,
    text: { type: "plain_text", text, emoji: true },
    value,
    ...(style ? { style } : undefined),
  };
}

function approvalTokenFromPrompt(text: string): string | undefined {
  const matches = text.match(/hil\[[^\]\s]{1,180}\]/g) ?? [];
  const tokens = [...new Set(matches)].filter((token) => APPROVAL_TOKEN_PATTERN.test(token));
  if (tokens.length !== 1) return undefined;
  const token = tokens[0]!;
  if (!text.includes(`"approve ${token}"`) || !text.includes(`"deny ${token}"`)) {
    return undefined;
  }
  return token;
}

function parseApprovalValue(value: string): z.infer<typeof approvalValueSchema> | undefined {
  try {
    const parsed = approvalValueSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function approvalAction(actionId: string): SlackApprovalAction | undefined {
  if (actionId === APPROVE_ACTION_ID) return "approve";
  if (actionId === APPROVE_ALWAYS_ACTION_ID) return "approve_always";
  if (actionId === DENY_ACTION_ID) return "deny";
  return undefined;
}

function approvalActionLabel(action: SlackApprovalAction): string {
  if (action === "approve") return "Approve once";
  if (action === "approve_always") return "Always approve";
  return "Deny";
}

function slackTimestampMilliseconds(value: string): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > Number.MAX_SAFE_INTEGER / 1_000) {
    return undefined;
  }
  return Math.floor(parsed * 1_000);
}
