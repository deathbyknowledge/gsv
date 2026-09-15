import { describe, expect, it } from "vitest";

import {
  answerWhatsAppVerification,
  isManagedWhatsAppPairCommand,
  normalizeWhatsAppWebhook,
  verifyWhatsAppSignature,
  whatsAppDeliveryToken,
} from "./whatsapp-webhook";

const PHONE_NUMBER_ID = "111222333444555";
const APP_SECRET = "app_secret_value_0123456789";

type MessageFixture = Record<string, unknown> & { id: string; from: string; type: string };

function notification(
  messages: MessageFixture[],
  overrides: { phoneNumberId?: string; contacts?: unknown[]; statuses?: unknown[]; field?: string; value?: Record<string, unknown> } = {},
) {
  return {
    object: "whatsapp_business_account",
    entry: [{
      id: "9876543210",
      changes: [{
        field: overrides.field ?? "messages",
        value: {
          messaging_product: "whatsapp",
          metadata: { display_phone_number: "34600000000", phone_number_id: overrides.phoneNumberId ?? PHONE_NUMBER_ID },
          contacts: overrides.contacts ?? [{ profile: { name: "Hank Human" }, wa_id: "34611111189" }],
          ...(messages.length > 0 ? { messages } : {}),
          ...(overrides.statuses ? { statuses: overrides.statuses } : {}),
          ...overrides.value,
        },
      }],
    }],
  };
}

function textMessage(body = "hello", id = "wamid.HBgLMzQ2MTExMTExODkVAgASGBQzQTBDN0Y5RDU1RTZGMkE3RUFBQQA="): MessageFixture {
  return { from: "34611111189", id, timestamp: "1700000000", type: "text", text: { body } };
}

async function sign(body: string, secret = APP_SECRET): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return `sha256=${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

describe("WhatsApp webhook signature", () => {
  it("accepts the HMAC of the exact body and rejects tampering or a missing header", async () => {
    const body = JSON.stringify(notification([textMessage()]));
    const header = await sign(body);
    expect(await verifyWhatsAppSignature(header, body, APP_SECRET)).toBe(true);
    expect(await verifyWhatsAppSignature(header, new TextEncoder().encode(body), APP_SECRET)).toBe(true);
    expect(await verifyWhatsAppSignature(header, `${body} `, APP_SECRET)).toBe(false);
    expect(await verifyWhatsAppSignature(await sign(body, "another_secret_0123456789"), body, APP_SECRET)).toBe(false);
    expect(await verifyWhatsAppSignature(null, body, APP_SECRET)).toBe(false);
    expect(await verifyWhatsAppSignature("sha1=abc", body, APP_SECRET)).toBe(false);
    expect(await verifyWhatsAppSignature(header, body, "")).toBe(false);
  });
});

describe("WhatsApp verification challenge", () => {
  it("echoes the challenge only for a subscribe request with the configured token", async () => {
    const token = "verify_token_0123456789";
    const ok = answerWhatsAppVerification(
      new URL(`https://wa.example/webhook?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=1158201444`),
      token,
    );
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("1158201444");
    expect(ok.headers.get("content-type")).toContain("text/plain");
    expect(answerWhatsAppVerification(
      new URL(`https://wa.example/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1`),
      token,
    ).status).toBe(403);
    expect(answerWhatsAppVerification(
      new URL(`https://wa.example/webhook?hub.mode=unsubscribe&hub.verify_token=${token}&hub.challenge=1`),
      token,
    ).status).toBe(403);
    expect(answerWhatsAppVerification(
      new URL(`https://wa.example/webhook?hub.mode=subscribe&hub.verify_token=${token}`),
      token,
    ).status).toBe(403);
  });
});

describe("WhatsApp webhook normalization", () => {
  it("normalizes a private text message with its contact profile and masked number", () => {
    expect(normalizeWhatsAppWebhook(notification([textMessage()]), PHONE_NUMBER_ID)).toEqual({
      kind: "accepted",
      events: [{
        kind: "message",
        inbound: {
          deliveryId: "message:wamid.HBgLMzQ2MTExMTExODkVAgASGBQzQTBDN0Y5RDU1RTZGMkE3RUFBQQA",
          messageId: "wamid.HBgLMzQ2MTExMTExODkVAgASGBQzQTBDN0Y5RDU1RTZGMkE3RUFBQQA=",
          actorId: "34611111189",
          surfaceId: "34611111189",
          actorName: "Hank Human",
          actorHandle: "+34•••••••89",
          text: "hello",
          timestamp: 1_700_000_000_000,
          unsupportedContent: false,
        },
      }],
    });
  });

  it("relays image, document, voice, video, and sticker attachments with captions", () => {
    const result = normalizeWhatsAppWebhook(notification([
      { from: "34611111189", id: "wamid.img", type: "image", image: { id: "1001", mime_type: "image/jpeg", sha256: "x", caption: "look" } },
      { from: "34611111189", id: "wamid.doc", type: "document", document: { id: "1002", mime_type: "application/pdf", filename: "report.pdf" } },
      { from: "34611111189", id: "wamid.voice", type: "audio", audio: { id: "1003", mime_type: "audio/ogg; codecs=opus", voice: true } },
      { from: "34611111189", id: "wamid.video", type: "video", video: { id: "1004", mime_type: "video/mp4" } },
      { from: "34611111189", id: "wamid.sticker", type: "sticker", sticker: { id: "1005", mime_type: "image/webp", animated: false } },
    ]), PHONE_NUMBER_ID);
    expect(result.kind).toBe("accepted");
    if (result.kind !== "accepted") throw new Error("expected accepted events");
    const inbound = result.events.map((event) => event.kind === "message" ? event.inbound : null);
    expect(inbound.map((message) => [message?.text, message?.media])).toEqual([
      ["look", [{ type: "image", mediaId: "1001", mimeType: "image/jpeg", filename: "whatsapp-image-1001.jpg" }]],
      ["[Document]", [{ type: "document", mediaId: "1002", mimeType: "application/pdf", filename: "report.pdf" }]],
      ["[Voice note]", [{ type: "audio", mediaId: "1003", mimeType: "audio/ogg; codecs=opus", filename: "whatsapp-audio-1003.ogg" }]],
      ["[Video]", [{ type: "video", mediaId: "1004", mimeType: "video/mp4", filename: "whatsapp-video-1004.mp4" }]],
      ["[Sticker]", [{ type: "image", mediaId: "1005", mimeType: "image/webp", filename: "whatsapp-image-1005.webp" }]],
    ]);
    expect(inbound.every((message) => message?.unsupportedContent === false)).toBe(true);
  });

  it("renders a shared location as text and keeps reply context", () => {
    const result = normalizeWhatsAppWebhook(notification([{
      from: "34611111189", id: "wamid.loc", type: "location",
      context: { from: "34600000000", id: "wamid.sent-by-gsv" },
      location: { latitude: 41.3851, longitude: 2.1734, name: "Plaça de Catalunya", address: "Barcelona" },
    }]), PHONE_NUMBER_ID);
    expect(result).toMatchObject({
      kind: "accepted",
      events: [{ kind: "message", inbound: {
        text: "Location: 41.385100, 2.173400 (Plaça de Catalunya, Barcelona)",
        replyToId: "wamid.sent-by-gsv",
        unsupportedContent: false,
      } }],
    });
  });

  it("turns an approval reply button into a structured peer event", () => {
    expect(normalizeWhatsAppWebhook(notification([{
      from: "34611111189", id: "wamid.reply", type: "interactive", timestamp: "1700000100",
      context: { from: "34600000000", id: "wamid.prompt" },
      interactive: { type: "button_reply", button_reply: { id: "gsvh:abcdefghijklmnop:a", title: "Always approve" } },
    }]), PHONE_NUMBER_ID)).toEqual({
      kind: "accepted",
      events: [{
        kind: "approval",
        reply: {
          interactionId: "wamid.reply",
          actorId: "34611111189",
          surfaceId: "34611111189",
          providerMessageId: "wamid.prompt",
          data: "gsvh:abcdefghijklmnop:a",
          timestamp: 1_700_000_100_000,
        },
      }],
    });
  });

  it("marks reactions, contacts, list replies and foreign buttons as unsupported content", () => {
    const result = normalizeWhatsAppWebhook(notification([
      { from: "34611111189", id: "wamid.react", type: "reaction", reaction: { message_id: "wamid.x", emoji: "👍" } },
      { from: "34611111189", id: "wamid.contacts", type: "contacts", contacts: [{ name: { formatted_name: "Someone" } }] },
      { from: "34611111189", id: "wamid.list", type: "interactive", interactive: { type: "list_reply", list_reply: { id: "row-1" } } },
      { from: "34611111189", id: "wamid.other", type: "interactive", context: { id: "wamid.prompt" }, interactive: { type: "button_reply", button_reply: { id: "someone-else:x" } } },
    ]), PHONE_NUMBER_ID);
    if (result.kind !== "accepted") throw new Error("expected accepted events");
    expect(result.events).toHaveLength(4);
    expect(result.events.every((event) => event.kind === "message" && event.inbound.unsupportedContent && event.inbound.text === "")).toBe(true);
  });

  it("ignores statuses, other numbers on the account, other fields and group traffic", () => {
    expect(normalizeWhatsAppWebhook(notification([], {
      statuses: [{ id: "wamid.sent", status: "delivered", timestamp: "1700000000", recipient_id: "34611111189" }],
    }), PHONE_NUMBER_ID)).toEqual({ kind: "ignored" });
    expect(normalizeWhatsAppWebhook(notification([textMessage()], { phoneNumberId: "999" }), PHONE_NUMBER_ID))
      .toEqual({ kind: "ignored" });
    expect(normalizeWhatsAppWebhook(notification([textMessage()], { field: "account_update" }), PHONE_NUMBER_ID))
      .toEqual({ kind: "ignored" });
    expect(normalizeWhatsAppWebhook(notification([{ ...textMessage(), group_id: "120363000000000000@g.us" }]), PHONE_NUMBER_ID))
      .toEqual({ kind: "ignored" });
    expect(normalizeWhatsAppWebhook(notification([textMessage()], { value: { group_id: "120363000000000000@g.us" } }), PHONE_NUMBER_ID))
      .toEqual({ kind: "ignored" });
    expect(normalizeWhatsAppWebhook(notification([{ ...textMessage(), from: "not-a-number" }]), PHONE_NUMBER_ID))
      .toEqual({ kind: "ignored" });
    expect(normalizeWhatsAppWebhook(notification([{ from: "34611111189", id: "wamid.welcome", type: "request_welcome" }]), PHONE_NUMBER_ID))
      .toEqual({ kind: "ignored" });
  });

  it("rejects malformed envelopes", () => {
    expect(normalizeWhatsAppWebhook(null, PHONE_NUMBER_ID)).toEqual({ kind: "invalid" });
    expect(normalizeWhatsAppWebhook({ object: "page", entry: [] }, PHONE_NUMBER_ID)).toEqual({ kind: "invalid" });
    expect(normalizeWhatsAppWebhook({
      object: "whatsapp_business_account",
      entry: [{ id: "1", changes: [{ field: "messages", value: { messages: [] } }] }],
    }, PHONE_NUMBER_ID)).toEqual({ kind: "invalid" });
  });

  it("recognizes pairing commands and derives ledger-safe delivery tokens", () => {
    expect(isManagedWhatsAppPairCommand("/link")).toBe(true);
    expect(isManagedWhatsAppPairCommand(" /CONNECT please ")).toBe(true);
    expect(isManagedWhatsAppPairCommand("/start")).toBe(true);
    expect(isManagedWhatsAppPairCommand("link me")).toBe(false);
    expect(whatsAppDeliveryToken("wamid.HBgL+ab/cd==")).toBe("wamid.HBgL-ab_cd");
    expect(whatsAppDeliveryToken("wamid with spaces")).toBeNull();
    expect(whatsAppDeliveryToken("")).toBeNull();
  });
});
