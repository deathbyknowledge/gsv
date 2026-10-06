import { describe, expect, it, vi } from "vitest";

import {
  handleManagedWhatsAppRequest,
  type ManagedWhatsAppHttpEnv,
} from "./managed-http";

const APP_SECRET = "valid_app_secret_0123456789";
const VERIFY_TOKEN = "verify_token_0123456789";
const PHONE_NUMBER_ID = "111222333444555";

function notification(from = "34611111189") {
  return {
    object: "whatsapp_business_account",
    entry: [{
      id: "9876543210",
      changes: [{
        field: "messages",
        value: {
          messaging_product: "whatsapp",
          metadata: { display_phone_number: "34600000000", phone_number_id: PHONE_NUMBER_ID },
          contacts: [{ profile: { name: "Hank" }, wa_id: from }],
          messages: [{ from, id: "wamid.first", timestamp: "1700000000", type: "text", text: { body: "hello" } }],
        },
      }],
    }],
  };
}

function makeEnv(overrides: Partial<ManagedWhatsAppHttpEnv> = {}) {
  const handleWebhook = vi.fn(async () => ({ ok: true as const }));
  const idFromName = vi.fn((name: string) => ({ name }));
  const get = vi.fn(() => ({ handleWebhook }));
  // SAFETY: this test fake implements the only namespace operations used by the handler.
  const env: ManagedWhatsAppHttpEnv = {
    MANAGED_WHATSAPP_PEER: {
      idFromName,
      get,
    } as Pick<DurableObjectNamespace, "idFromName" | "get">,
    WHATSAPP_ACCESS_TOKEN: "token",
    WHATSAPP_APP_SECRET: APP_SECRET,
    WHATSAPP_VERIFY_TOKEN: VERIFY_TOKEN,
    WHATSAPP_PHONE_NUMBER_ID: PHONE_NUMBER_ID,
    WHATSAPP_BUSINESS_ACCOUNT_ID: "9876543210",
    WHATSAPP_WEBHOOK_BASE_URL: "https://whatsapp.gsv.example",
    WHATSAPP_DISPLAY_NUMBER: "+34600000000",
    ...overrides,
  };
  return { env, handleWebhook, idFromName, get };
}

async function sign(body: string, secret = APP_SECRET): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return `sha256=${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function webhookRequest(
  body: string,
  options: { signature?: string | null; headers?: Record<string, string> } = {},
): Promise<Request> {
  const headers = new Headers({ "Content-Type": "application/json", ...options.headers });
  const signature = options.signature === undefined ? await sign(body) : options.signature;
  if (signature !== null) headers.set("X-Hub-Signature-256", signature);
  return new Request("https://whatsapp.gsv.example/webhook", { method: "POST", headers, body });
}

describe("managed WhatsApp HTTP boundary", () => {
  it("answers the verification handshake with the challenge", async () => {
    const { env } = makeEnv();
    const response = await handleManagedWhatsAppRequest(
      new Request(`https://whatsapp.gsv.example/webhook?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=424242`),
      env,
    );
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("424242");
    expect((await handleManagedWhatsAppRequest(
      new Request("https://whatsapp.gsv.example/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1"),
      env,
    )).status).toBe(403);
  });

  it("rejects a missing or malformed signature header before reading the body", async () => {
    const { env, get } = makeEnv();
    const missing = await webhookRequest(JSON.stringify(notification()), { signature: null });
    const getReader = vi.spyOn(missing.body!, "getReader");
    expect((await handleManagedWhatsAppRequest(missing, env)).status).toBe(403);
    expect(getReader).not.toHaveBeenCalled();
    const malformed = await webhookRequest(JSON.stringify(notification()), { signature: "sha256=nothex" });
    expect((await handleManagedWhatsAppRequest(malformed, env)).status).toBe(403);
    expect(get).not.toHaveBeenCalled();
  });

  it("rejects a tampered body and never allocates a peer for it", async () => {
    const { env, get } = makeEnv();
    const body = JSON.stringify(notification());
    const request = await webhookRequest(body.replace("hello", "hullo"), { signature: await sign(body) });
    const response = await handleManagedWhatsAppRequest(request, env);
    expect(response.status).toBe(403);
    expect(get).not.toHaveBeenCalled();
  });

  it("rejects declared oversized payloads before allocating a peer", async () => {
    const { env, get } = makeEnv();
    const response = await handleManagedWhatsAppRequest(
      await webhookRequest("{}", { headers: { "Content-Length": "1048577" } }),
      env,
    );
    expect(response.status).toBe(413);
    expect(get).not.toHaveBeenCalled();
  });

  it("checks the staging actor allowlist before allocating Durable Object state", async () => {
    const { env, get } = makeEnv({ WHATSAPP_ALLOWED_ACTOR_IDS: "34699999999" });
    const response = await handleManagedWhatsAppRequest(
      await webhookRequest(JSON.stringify(notification())),
      env,
    );
    expect(response.status).toBe(200);
    expect(get).not.toHaveBeenCalled();
  });

  it("normalizes an authenticated notification and routes each message to its peer", async () => {
    const { env, idFromName, handleWebhook } = makeEnv({ WHATSAPP_ALLOWED_ACTOR_IDS: "34611111189,34699999999" });
    const response = await handleManagedWhatsAppRequest(
      await webhookRequest(JSON.stringify(notification())),
      env,
    );
    expect(response.status).toBe(200);
    expect(idFromName).toHaveBeenCalledWith("managed:34611111189");
    expect(handleWebhook).toHaveBeenCalledWith({
      kind: "message",
      inbound: expect.objectContaining({
        actorId: "34611111189",
        surfaceId: "34611111189",
        deliveryId: "message:wamid.first",
        text: "hello",
      }),
    });
  });

  it("acknowledges status-only notifications without touching a peer", async () => {
    const { env, get } = makeEnv();
    const body = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{ id: "9876543210", changes: [{ field: "messages", value: {
        messaging_product: "whatsapp",
        metadata: { display_phone_number: "34600000000", phone_number_id: PHONE_NUMBER_ID },
        statuses: [{ id: "wamid.sent", status: "read", timestamp: "1700000000", recipient_id: "34611111189" }],
      } }] }],
    });
    expect((await handleManagedWhatsAppRequest(await webhookRequest(body), env)).status).toBe(200);
    expect(get).not.toHaveBeenCalled();
  });

  it("asks Meta to retry when the peer cannot durably enqueue the message", async () => {
    const { env, handleWebhook } = makeEnv();
    handleWebhook.mockRejectedValueOnce(new Error("simulated storage failure"));
    const response = await handleManagedWhatsAppRequest(
      await webhookRequest(JSON.stringify(notification())),
      env,
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "WhatsApp notification could not be accepted",
    });
  });

  it("exposes only health and the exact webhook route", async () => {
    const { env } = makeEnv();
    const health = await handleManagedWhatsAppRequest(new Request("https://whatsapp.gsv.example/health"), env);
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({ service: "gsv-managed-whatsapp", configured: true });
    expect((await handleManagedWhatsAppRequest(
      await webhookRequest("{}"),
      { ...env, WHATSAPP_APP_SECRET: undefined },
    )).status).toBe(503);
    expect((await handleManagedWhatsAppRequest(
      new Request("https://whatsapp.gsv.example/webhook/legacy"),
      env,
    )).status).toBe(404);
    expect((await handleManagedWhatsAppRequest(
      new Request("https://whatsapp.gsv.example/webhook", { method: "PUT" }),
      env,
    )).status).toBe(404);
  });
});
