import { describe, expect, it } from "vitest";
import {
  isManagedTelegramConnectCommand,
  normalizeManagedTelegramUpdate,
} from "./managed-update";

describe("managed Telegram update normalization", () => {
  it("accepts only a human-authored private DM with coincident actor and peer", () => {
    expect(normalizeManagedTelegramUpdate({
      update_id: 10,
      message: {
        message_id: 20,
        date: 1_700_000_000,
        chat: { id: 123456, type: "private" },
        from: {
          id: 123456,
          is_bot: false,
          first_name: "Hank",
          username: "hank_dev",
        },
        text: "  hello  ",
      },
    })).toEqual({
      kind: "accepted",
      inbound: {
        deliveryId: "update:10",
        messageId: "20",
        actorId: "123456",
        surfaceId: "123456",
        actorName: "Hank",
        actorHandle: "@hank_dev",
        text: "hello",
        timestamp: 1_700_000_000_000,
        unsupportedContent: false,
      },
    });
  });

  it("ignores groups, channels, bots, and unrelated update types", () => {
    const message = {
      message_id: 20,
      chat: { id: 123456, type: "private" },
      from: { id: 123456 },
      text: "hello",
    };
    expect(normalizeManagedTelegramUpdate({ callback_query: {} })).toEqual({
      kind: "ignored",
    });
    expect(normalizeManagedTelegramUpdate({
      message: { ...message, chat: { id: -123, type: "group" } },
    })).toEqual({ kind: "ignored" });
    expect(normalizeManagedTelegramUpdate({
      message: { ...message, from: { id: 123456, is_bot: true } },
    })).toEqual({ kind: "ignored" });
    expect(normalizeManagedTelegramUpdate({
      message: { ...message, from: { id: 999 } },
    })).toEqual({ kind: "ignored" });
  });

  it("marks rich content unsupported instead of silently stripping it", () => {
    const result = normalizeManagedTelegramUpdate({
      update_id: 10,
      message: {
        message_id: 20,
        chat: { id: 123456, type: "private" },
        from: { id: 123456 },
        caption: "what is this?",
        photo: [{ file_id: "secret-provider-id" }],
      },
    });
    expect(result.kind).toBe("accepted");
    if (result.kind === "accepted") {
      expect(result.inbound.unsupportedContent).toBe(true);
      expect(result.inbound).not.toHaveProperty("photo");
    }
  });

  it("recognizes only explicit relink commands", () => {
    expect(isManagedTelegramConnectCommand("/connect")).toBe(true);
    expect(isManagedTelegramConnectCommand("/LINK now")).toBe(true);
    expect(isManagedTelegramConnectCommand("please connect me")).toBe(false);
  });
});
