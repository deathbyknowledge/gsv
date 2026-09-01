import {
  requireSlackId,
  requireSlackTimestamp,
} from "./slack-api";
import {
  renderAdapterHilResolution,
  type AdapterHilPresentation,
} from "../../shared/src/peer-render";
import type { AdapterSurface } from "./types";
import { z } from "zod";

const APPROVE_ACTION_ID = "gsv_hil_approve";
const APPROVE_ALWAYS_ACTION_ID = "gsv_hil_approve_always";
const DENY_ACTION_ID = "gsv_hil_deny";
const APPROVAL_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16}$/;
const MAX_BLOCK_TEXT_LENGTH = 3_000;

export type SlackApprovalAction = "approve" | "approve_always" | "deny";

export type SlackApprovalSubmittedMessage = {
  text: string;
  blocks: SlackBlock[];
};

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
    };

const approvalValueSchema = z.object({
  v: z.literal(2),
  token: z.string().regex(APPROVAL_TOKEN_PATTERN),
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
  | { kind: "accepted"; callback: SlackApprovalCallback }
  | { kind: "ignored" }
  | { kind: "invalid" };

export type SlackApprovalCallback = {
  deliveryId: string;
  interactionId: string;
  teamId: string;
  actorId: string;
  surface: AdapterSurface;
  sourceMessageId: string;
  action: SlackApprovalAction;
  token: string;
};

export function buildSlackApprovalBlocks(
  text: string,
  token: string,
): SlackBlock[] | undefined {
  if (!APPROVAL_TOKEN_PATTERN.test(token) || !canRenderSlackApproval(text)) {
    return undefined;
  }
  const value = JSON.stringify({
    v: 2,
    token,
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

export function canRenderSlackApproval(text: string): boolean {
  return text.length <= MAX_BLOCK_TEXT_LENGTH;
}

export function buildSlackApprovalStatusMessage(
  presentation: AdapterHilPresentation | undefined,
  status: string,
): SlackApprovalSubmittedMessage {
  const text = renderAdapterHilResolution(presentation, status).slice(0, 40_000);
  const blocks: SlackBlock[] = [];
  if (text.length <= MAX_BLOCK_TEXT_LENGTH) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text },
    });
  }
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

  const surface: AdapterSurface = { kind: "dm", id: channelId };
  if (threadId) surface.threadId = threadId;
  return {
    kind: "accepted",
    callback: {
      deliveryId: `interaction:${sourceMessageId}:${actionMessageId}`,
      interactionId: `interaction:${actionMessageId}`,
      teamId,
      actorId,
      surface,
      sourceMessageId,
      action,
      token: decoded.token,
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
