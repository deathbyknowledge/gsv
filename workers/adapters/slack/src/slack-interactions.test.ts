import { describe, expect, it } from "vitest";
import {
  buildSlackApprovalBlocks,
  buildSlackApprovalStatusMessage,
  normalizeSlackInteraction,
} from "./slack-interactions";

const BOT = "UGSVBOT1";
const PROMPT = "Run the requested shell command.";
const TOKEN = "AbCdEfGhIjKlMnOp";

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
  it("renders a structured HIL request as buttons bound to an opaque adapter token", () => {
    const blocks = buildSlackApprovalBlocks(PROMPT, TOKEN);
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
        v: 2,
        token: TOKEN,
      });
    }
    expect(buildSlackApprovalBlocks("ordinary response", "bad-token")).toBeUndefined();
  });

  it("normalizes a bot-authored DM button as a structured callback", () => {
    const value = JSON.stringify({
      v: 2,
      token: TOKEN,
    });
    expect(normalizeSlackInteraction(interaction(value), BOT)).toEqual({
      kind: "accepted",
      callback: {
        deliveryId: "interaction:1700000000.000100:1700000001.000200",
        interactionId: "interaction:1700000001.000200",
        teamId: "TWORK123",
        actorId: "UALICE01",
        surface: { kind: "dm", id: "DALICE01" },
        sourceMessageId: "1700000000.000100",
        action: "approve_always",
        token: TOKEN,
      },
    });
  });

  it("rejects buttons outside a bot-authored direct message", () => {
    const value = JSON.stringify({ v: 2, token: TOKEN });
    expect(normalizeSlackInteraction(interaction(value, {
      channelId: "CGENERAL1",
    }), BOT)).toEqual({ kind: "invalid" });
    expect(normalizeSlackInteraction(interaction(value, {
      messageUser: "UOTHER01",
    }), BOT)).toEqual({ kind: "invalid" });
    expect(normalizeSlackInteraction(interaction(JSON.stringify({
      v: 2,
      token: "not-an-opaque-token",
    })), BOT)).toEqual({ kind: "invalid" });
  });

  it("replaces the prompt and buttons with the resolved action", () => {
    const submitted = buildSlackApprovalStatusMessage({
      action: "Requested action: run \"date\".",
      scope: "work",
    }, "Denied.");
    expect(submitted.text).toBe(
      "[WORK SESSION] Denied.\n\nRequested action: run \"date\".",
    );
    expect(submitted.text).not.toContain(PROMPT);
    expect(submitted.blocks.some((block) => block.type === "actions")).toBe(false);
  });
});
