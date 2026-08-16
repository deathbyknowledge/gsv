import { describe, expect, it } from "vitest";

import {
  isManagedTelegramPairCommand,
  normalizeManagedTelegramUpdate,
} from "./managed-update";

function update(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    update_id: 42,
    message: {
      message_id: 7,
      date: 1_700_000_000,
      text: "hello",
      chat: { id: 12345, type: "private" },
      from: {
        id: 12345,
        is_bot: false,
        first_name: "Hank",
        last_name: "Human",
        username: "hank_test",
      },
    },
    ...overrides,
  };
}

describe("managed Telegram update normalization", () => {
  it("normalizes a private human message with sequence ordering metadata", () => {
    expect(normalizeManagedTelegramUpdate(update())).toEqual({
      kind: "accepted",
      inbound: {
        deliveryId: "update:0000000000000042",
        sequence: 42,
        messageId: "7",
        actorId: "12345",
        surfaceId: "12345",
        actorName: "Hank Human",
        actorHandle: "@hank_test",
        text: "hello",
        timestamp: 1_700_000_000_000,
        unsupportedContent: false,
      },
    });
  });

  it("marks rich or empty messages unsupported without exposing provider shapes", () => {
    const message = (update().message as Record<string, unknown>);
    expect(normalizeManagedTelegramUpdate(update({
      message: { ...message, text: undefined, photo: [{ file_id: "secret" }] },
    }))).toMatchObject({
      kind: "accepted",
      inbound: { text: "", unsupportedContent: true },
    });
  });

  it("ignores groups, bots, and mismatched private peers", () => {
    const message = update().message as Record<string, unknown>;
    expect(normalizeManagedTelegramUpdate(update({
      message: { ...message, chat: { id: 12345, type: "group" } },
    }))).toEqual({ kind: "ignored" });
    expect(normalizeManagedTelegramUpdate(update({
      message: { ...message, from: { id: 12345, is_bot: true } },
    }))).toEqual({ kind: "ignored" });
    expect(normalizeManagedTelegramUpdate(update({
      message: { ...message, chat: { id: 54321, type: "private" } },
    }))).toEqual({ kind: "ignored" });
  });

  it("rejects malformed envelopes and ignores unrelated update types", () => {
    expect(normalizeManagedTelegramUpdate(null)).toEqual({ kind: "invalid" });
    expect(normalizeManagedTelegramUpdate({ update_id: 1, message: null })).toEqual({
      kind: "invalid",
    });
    expect(normalizeManagedTelegramUpdate({ update_id: 1, callback_query: {} })).toEqual({
      kind: "ignored",
    });
  });

  it("recognizes pairing commands before normal ingress", () => {
    expect(isManagedTelegramPairCommand("/start")).toBe(true);
    expect(isManagedTelegramPairCommand(" /CONNECT anything ")).toBe(true);
    expect(isManagedTelegramPairCommand("/link@other_bot")).toBe(false);
    expect(isManagedTelegramPairCommand("please connect me")).toBe(false);
  });
});
