import { describe, expect, it } from "vitest";

import {
  isManagedTelegramPairCommand,
  normalizeManagedTelegramUpdate,
} from "./managed-update";

type MessageFixture = {
  message_id: number;
  date: number;
  text?: string;
  chat: { id: number; type: "private" | "group" };
  from: { id: number; is_bot: boolean; first_name?: string; last_name?: string; username?: string };
  contact?: { phone_number: string };
  voice?: { file_id: string; file_size: number; duration: number; mime_type: string };
};
type UpdateFixture = { update_id: number; message: MessageFixture };

function update(overrides: Partial<UpdateFixture> = {}): UpdateFixture {
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
    const message = update().message;
    expect(normalizeManagedTelegramUpdate(update({
      message: { ...message, text: undefined, contact: { phone_number: "secret" } },
    }))).toMatchObject({
      kind: "accepted",
      inbound: { text: "", unsupportedContent: true },
    });
  });

  it("normalizes a voice note as binary-backed inbound audio", () => {
    const message = update().message;
    expect(normalizeManagedTelegramUpdate(update({
      message: {
        ...message,
        text: undefined,
        voice: {
          file_id: "voice_file_123",
          file_size: 4,
          duration: 2,
          mime_type: "audio/ogg",
        },
      },
    }))).toMatchObject({
      kind: "accepted",
      inbound: {
        text: "[Voice note]",
        unsupportedContent: false,
        media: [{
          type: "audio",
          fileId: "voice_file_123",
          mimeType: "audio/ogg",
          filename: "telegram-voice-7.ogg",
          size: 4,
          duration: 2,
        }],
      },
    });
  });

  it("ignores groups, bots, and mismatched private peers", () => {
    const message = update().message;
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

  it("normalizes structured approval callbacks", () => {
    expect(normalizeManagedTelegramUpdate({
      update_id: 43,
      callback_query: {
        id: "callback-1",
        from: { id: 12345, is_bot: false },
        message: {
          message_id: 8,
          chat: { id: 12345, type: "private" },
        },
        data: "gsvh:abcdefghijklmnop:a",
      },
    })).toEqual({
      kind: "approval",
      callback: {
        callbackQueryId: "callback-1",
        actorId: "12345",
        surfaceId: "12345",
        providerMessageId: "8",
        data: "gsvh:abcdefghijklmnop:a",
      },
    });
  });

  it("rejects malformed envelopes and ignores unrelated update types", () => {
    expect(normalizeManagedTelegramUpdate(null)).toEqual({ kind: "invalid" });
    expect(normalizeManagedTelegramUpdate({ update_id: 1, message: null })).toEqual({
      kind: "invalid",
    });
    expect(normalizeManagedTelegramUpdate({ update_id: 1, callback_query: {} })).toEqual({
      kind: "invalid",
    });
    expect(normalizeManagedTelegramUpdate({
      update_id: 1,
      callback_query: {
        id: "callback-1",
        from: { id: 12345, is_bot: false },
        message: {
          message_id: 8,
          chat: { id: 12345, type: "private" },
        },
        data: "someone-else:action",
      },
    })).toEqual({
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
