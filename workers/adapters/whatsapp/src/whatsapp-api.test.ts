import { describe, expect, it, vi } from "vitest";

import { readAdapterMediaBody } from "../../shared/src/media-body";
import {
  classifyWhatsAppFailure,
  type ManagedWhatsAppFetch,
  downloadWhatsAppMedia,
  lookupWhatsAppMedia,
  ManagedWhatsAppDeliveryError,
  markWhatsAppMessageRead,
  sendWhatsAppMessage,
  uploadWhatsAppMedia,
  WHATSAPP_GRAPH_BASE,
  WHATSAPP_WINDOW_CLOSED_ERROR,
} from "./whatsapp-api";

const TOKEN = "EAAB.access.token";
const PHONE_NUMBER_ID = "111222333444555";

function graphError(status: number, code: number, message = "rejected"): Response {
  return Response.json({ error: { message, type: "OAuthException", code, fbtrace_id: "trace" } }, { status });
}

describe("WhatsApp Graph API client", () => {
  it("posts one text message with the bearer token and returns its id", async () => {
    const fetcher = vi.fn<ManagedWhatsAppFetch>(async () => Response.json({
      messaging_product: "whatsapp",
      contacts: [{ input: "34611111189", wa_id: "34611111189" }],
      messages: [{ id: "wamid.sent" }],
    }));
    await expect(sendWhatsAppMessage(TOKEN, PHONE_NUMBER_ID, {
      to: "34611111189",
      type: "text",
      text: { preview_url: false, body: "hello" },
    }, fetcher)).resolves.toEqual({ messageId: "wamid.sent" });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${WHATSAPP_GRAPH_BASE}/${PHONE_NUMBER_ID}/messages`);
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(String(init?.body))).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "34611111189",
      type: "text",
      text: { preview_url: false, body: "hello" },
    });
  });

  it("classifies provider failures for a non-idempotent send", async () => {
    await expect(sendWhatsAppMessage(TOKEN, PHONE_NUMBER_ID, { to: "1" }, async () => graphError(400, 131047)))
      .rejects.toMatchObject({ kind: "permanent", windowClosed: true, message: WHATSAPP_WINDOW_CLOSED_ERROR });
    await expect(sendWhatsAppMessage(TOKEN, PHONE_NUMBER_ID, { to: "1" }, async () => graphError(429, 130429)))
      .rejects.toMatchObject({ kind: "retryable", graphCode: 130429 });
    await expect(sendWhatsAppMessage(TOKEN, PHONE_NUMBER_ID, { to: "1" }, async () => graphError(500, 2)))
      .rejects.toMatchObject({ kind: "ambiguous", graphStatus: 500 });
    await expect(sendWhatsAppMessage(TOKEN, PHONE_NUMBER_ID, { to: "1" }, async () => graphError(400, 131026)))
      .rejects.toMatchObject({ kind: "permanent", graphCode: 131026, templateRejected: false });
    await expect(sendWhatsAppMessage(TOKEN, PHONE_NUMBER_ID, { to: "1" }, async () => graphError(400, 132001)))
      .rejects.toMatchObject({
        kind: "permanent",
        templateRejected: true,
        message: expect.stringContaining("template message was rejected by Meta (code 132001)"),
      });
    await expect(sendWhatsAppMessage(TOKEN, PHONE_NUMBER_ID, { to: "1" }, async () => { throw new Error("socket"); }))
      .rejects.toMatchObject({ kind: "ambiguous" });
    await expect(sendWhatsAppMessage(TOKEN, PHONE_NUMBER_ID, { to: "1" }, async () => new Response("<html>", { status: 200 })))
      .rejects.toBeInstanceOf(ManagedWhatsAppDeliveryError);
    await expect(sendWhatsAppMessage("  ", PHONE_NUMBER_ID, { to: "1" }, async () => Response.json({})))
      .rejects.toMatchObject({ kind: "permanent" });
    expect(classifyWhatsAppFailure(503, undefined, true)).toBe("retryable");
    expect(classifyWhatsAppFailure(503, undefined, false)).toBe("ambiguous");
    expect(classifyWhatsAppFailure(400, 4, false)).toBe("retryable");
  });

  it("marks a message read with an optional typing indicator", async () => {
    const fetcher = vi.fn<ManagedWhatsAppFetch>(async () => Response.json({ success: true }));
    await markWhatsAppMessageRead(TOKEN, PHONE_NUMBER_ID, "wamid.in", fetcher, { typing: true });
    const [, init] = fetcher.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toEqual({
      messaging_product: "whatsapp",
      status: "read",
      message_id: "wamid.in",
      typing_indicator: { type: "text" },
    });
    await markWhatsAppMessageRead(TOKEN, PHONE_NUMBER_ID, "wamid.in", fetcher);
    const [, plain] = fetcher.mock.calls[1]!;
    expect(JSON.parse(String(plain?.body))).not.toHaveProperty("typing_indicator");
  });

  it("looks media up by id and downloads it with the token", async () => {
    const fetcher = vi.fn<ManagedWhatsAppFetch>(async (input) => {
      const url = String(input);
      if (url.startsWith(`${WHATSAPP_GRAPH_BASE}/1001`)) {
        expect(new URL(url).searchParams.get("phone_number_id")).toBe(PHONE_NUMBER_ID);
        return Response.json({ url: "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1001", mime_type: "image/jpeg", file_size: "4", id: "1001" });
      }
      return new Response(new Uint8Array([1, 2, 3, 4]), { headers: { "content-length": "4" } });
    });
    const lookup = await lookupWhatsAppMedia(TOKEN, "1001", PHONE_NUMBER_ID, fetcher);
    expect(lookup).toEqual({ url: "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1001", mimeType: "image/jpeg", size: 4 });
    const body = await downloadWhatsAppMedia(TOKEN, lookup.url, lookup.size, 1024, fetcher);
    expect(body.length).toBe(4);
    await expect(readAdapterMediaBody([{ type: "image", mimeType: "image/jpeg", body: { offset: 0, length: 4 } }], body))
      .resolves.toEqual([new Uint8Array([1, 2, 3, 4])]);
    const [, downloadInit] = fetcher.mock.calls[1]!;
    expect(new Headers(downloadInit?.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
    await expect(downloadWhatsAppMedia(TOKEN, lookup.url, 4, 1024, async () => new Response("nope", { status: 404 })))
      .rejects.toThrow("HTTP 404");
  });

  it("classifies media that Meta no longer serves as permanent and server trouble as retryable", async () => {
    const url = "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1001";
    await expect(downloadWhatsAppMedia(TOKEN, url, 4, 1024, async () => new Response("gone", { status: 404 })))
      .rejects.toMatchObject({ kind: "permanent", graphStatus: 404 });
    await expect(downloadWhatsAppMedia(TOKEN, url, 4, 1024, async () => new Response("later", { status: 503 })))
      .rejects.toMatchObject({ kind: "retryable", graphStatus: 503 });
    await expect(downloadWhatsAppMedia(TOKEN, url, 4, 1024, async () => { throw new Error("socket"); }))
      .rejects.toMatchObject({ kind: "retryable" });
    await expect(downloadWhatsAppMedia(TOKEN, url, undefined, 2, async () => new Response(new Uint8Array(4), { headers: { "content-length": "4" } })))
      .rejects.toMatchObject({ kind: "permanent", message: expect.stringContaining("exceeds transfer limit") });
    await expect(lookupWhatsAppMedia(TOKEN, "gone", PHONE_NUMBER_ID, async () => graphError(400, 100, "Object with ID 'gone' does not exist")))
      .rejects.toMatchObject({ kind: "permanent", graphCode: 100 });
    await expect(lookupWhatsAppMedia(TOKEN, "later", PHONE_NUMBER_ID, async () => graphError(500, 2)))
      .rejects.toMatchObject({ kind: "retryable" });
  });

  it("uploads bytes as multipart form data and returns the media id", async () => {
    const fetcher = vi.fn<ManagedWhatsAppFetch>(async (_input, init) => {
      const form = init?.body;
      if (!(form instanceof FormData)) throw new Error("expected multipart upload");
      const file = form.get("file");
      if (!(file instanceof File)) throw new Error("expected a file part");
      expect(form.get("messaging_product")).toBe("whatsapp");
      expect(form.get("type")).toBe("audio/ogg");
      expect(file.name).toBe("reply.ogg");
      expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array([9, 8, 7]));
      return Response.json({ id: "media-77" });
    });
    await expect(uploadWhatsAppMedia(TOKEN, PHONE_NUMBER_ID, new Uint8Array([9, 8, 7]), "audio/ogg", "reply.ogg", fetcher))
      .resolves.toBe("media-77");
    expect(String(fetcher.mock.calls[0]![0])).toBe(`${WHATSAPP_GRAPH_BASE}/${PHONE_NUMBER_ID}/media`);
    await expect(uploadWhatsAppMedia(TOKEN, PHONE_NUMBER_ID, new Uint8Array([1]), "audio/ogg", "a.ogg", async () => { throw new Error("socket"); }))
      .rejects.toMatchObject({ kind: "retryable" });
  });
});
