import { describe, expect, it } from "vitest";
import {
  buildSlackApprovalBlocks,
  buildSlackApprovalSubmittedMessage,
  normalizeSlackInteraction,
} from "./slack-interactions";

const BOT = "UGSVBOT1";
const PROMPT = [
  "I need your confirmation before I can continue.",
  "",
  "Run the requested shell command.",
  "",
  "Reply \"approve hil[request-1]\" to continue, \"approve always hil[request-1]\" to remember it for this conversation, or \"deny hil[request-1]\" to stop this action.",
].join("\n");

function interaction(value: string, overrides: {
  channelId?: string;
  messageUser?: string;
} = {}) {
  const channelId = overrides.channelId ?? "DALICE01";
  return {
    type: "block_actions",
    team: { id: "TWORK123" },
    user: { id: "UALICE01" },
    channel: { id: channelId },
    container: {
      type: "message",
      channel_id: channelId,
      message_ts: "1700000000.000100",
    },
    message: {
      user: overrides.messageUser ?? BOT,
      text: PROMPT,
      ts: "1700000000.000100",
    },
    actions: [{
      type: "button",
      action_id: "gsv_hil_approve_always",
      value,
      action_ts: "1700000001.000200",
    }],
  };
}

describe("Slack approval interactions", () => {
  it("renders exact HIL prompts as buttons bound to the managed route", () => {
    const blocks = buildSlackApprovalBlocks(PROMPT, "route-generation-1");
    expect(blocks).toHaveLength(2);
    expect(blocks?.[0]).toMatchObject({
      type: "section",
      text: { text: PROMPT },
    });
    expect(blocks?.[1]).toMatchObject({
      type: "actions",
      elements: [
        { action_id: "gsv_hil_approve", style: "primary" },
        { action_id: "gsv_hil_approve_always" },
        { action_id: "gsv_hil_deny", style: "danger" },
      ],
    });
    const actionBlock = blocks?.[1];
    if (actionBlock?.type !== "actions") throw new Error("Expected action buttons");
    for (const button of actionBlock.elements) {
      expect(JSON.parse(button.value)).toEqual({
        v: 1,
        token: "hil[request-1]",
        routeGeneration: "route-generation-1",
      });
    }
    expect(buildSlackApprovalBlocks("ordinary response")).toBeUndefined();
  });

  it("normalizes a bot-authored DM button into the existing HIL command", () => {
    const value = JSON.stringify({
      v: 1,
      token: "hil[request-1]",
      routeGeneration: "route-generation-1",
    });
    expect(normalizeSlackInteraction(interaction(value), BOT)).toEqual({
      kind: "accepted",
      inbound: {
        deliveryId: "interaction:1700000000.000100:1700000001.000200",
        eventId: "interaction:1700000001.000200",
        teamId: "TWORK123",
        messageId: "1700000001.000200",
        actorId: "UALICE01",
        surface: { kind: "dm", id: "DALICE01" },
        text: "approve always hil[request-1]",
        replyToId: "1700000000.000100",
        timestamp: 1_700_000_001_000,
        wasMentioned: true,
        interaction: {
          sourceMessageId: "1700000000.000100",
          sourceText: PROMPT,
          action: "approve_always",
          expectedRouteGeneration: "route-generation-1",
        },
      },
    });
  });

  it("rejects buttons outside a bot-authored direct message", () => {
    const value = JSON.stringify({ v: 1, token: "hil[request-1]" });
    expect(normalizeSlackInteraction(interaction(value, {
      channelId: "CGENERAL1",
    }), BOT)).toEqual({ kind: "invalid" });
    expect(normalizeSlackInteraction(interaction(value, {
      messageUser: "UOTHER01",
    }), BOT)).toEqual({ kind: "invalid" });
    expect(normalizeSlackInteraction(interaction(JSON.stringify({
      v: 1,
      token: "hil[another-request]",
    })), BOT)).toEqual({ kind: "invalid" });
  });

  it("removes the buttons after a decision is submitted", () => {
    const submitted = buildSlackApprovalSubmittedMessage(PROMPT, "deny");
    expect(submitted.text).toContain("Decision submitted: Deny.");
    expect(submitted.blocks.some((block) => block.type === "actions")).toBe(false);
  });
});
