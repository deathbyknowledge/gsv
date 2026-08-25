import { describe, expect, it, vi } from "vitest";

import {
  handleManagedTelegramRequest,
  type ManagedTelegramHttpEnv,
} from "./managed-http";

const SECRET = "valid_webhook_secret_123";

type TelegramUpdateFixture = {
  update_id: number;
  message: {
    message_id: number;
    date: number;
    text: string;
    chat: { id: number; type: "private" };
    from: { id: number; is_bot: boolean; first_name: string };
  };
};

function telegramUpdate(actorId = 12345): TelegramUpdateFixture {
  return {
    update_id: 42,
    message: {
      message_id: 7,
      date: 1_700_000_000,
      text: "hello",
      chat: { id: actorId, type: "private" },
      from: { id: actorId, is_bot: false, first_name: "Hank" },
    },
  };
}

function makeEnv(overrides: Partial<ManagedTelegramHttpEnv> = {}) {
  const handleWebhook = vi.fn(async () => ({ ok: true as const }));
  const idFromName = vi.fn((name: string) => ({ name }));
  const get = vi.fn(() => ({ handleWebhook }));
    // SAFETY: this test fake implements the only namespace operations used by the handler.
    const env: ManagedTelegramHttpEnv = {
    MANAGED_TELEGRAM_PEER: {
      idFromName,
      get,
    } as Pick<DurableObjectNamespace, "idFromName" | "get">,
    TELEGRAM_BOT_TOKEN: "token",
    TELEGRAM_BOT_USERNAME: "official_gsv_bot",
    TELEGRAM_WEBHOOK_SECRET: SECRET,
    ...overrides,
  };
  return { env, handleWebhook, idFromName, get };
}

function webhookRequest(
  body: string,
  secret = SECRET,
  headers: Record<string, string> = {},
): Request {
  return new Request("https://telegram.example/webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": secret,
      ...headers,
    },
    body,
  });
}

describe("managed Telegram HTTP boundary", () => {
  it("authenticates the webhook before reading its JSON body", async () => {
    const { env, get } = makeEnv();
    const request = webhookRequest(JSON.stringify(telegramUpdate()), "wrong-secret-value");
    const getReader = vi.spyOn(request.body!, "getReader");

    const response = await handleManagedTelegramRequest(request, env);
    expect(response.status).toBe(403);
    expect(getReader).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it("rejects declared oversized payloads before allocating a peer", async () => {
    const { env, get } = makeEnv();
    const response = await handleManagedTelegramRequest(
      webhookRequest("{}", SECRET, { "Content-Length": "1048577" }),
      env,
    );
    expect(response.status).toBe(413);
    expect(get).not.toHaveBeenCalled();
  });

  it("checks the staging actor allowlist before allocating Durable Object state", async () => {
    const { env, get } = makeEnv({ TELEGRAM_ALLOWED_ACTOR_IDS: "99999" });
    const response = await handleManagedTelegramRequest(
      webhookRequest(JSON.stringify(telegramUpdate())),
      env,
    );
    expect(response.status).toBe(200);
    expect(get).not.toHaveBeenCalled();
  });

  it("normalizes an authorized private update and routes it to its peer", async () => {
    const { env, idFromName, handleWebhook } = makeEnv({
      TELEGRAM_ALLOWED_ACTOR_IDS: "12345,99999",
    });
    const response = await handleManagedTelegramRequest(
      webhookRequest(JSON.stringify(telegramUpdate())),
      env,
    );
    expect(response.status).toBe(200);
    expect(idFromName).toHaveBeenCalledWith("managed:12345");
    expect(handleWebhook).toHaveBeenCalledWith(expect.objectContaining({
      actorId: "12345",
      surfaceId: "12345",
      deliveryId: "update:0000000000000042",
    }));
  });

  it("asks Telegram to retry when the peer cannot durably enqueue the update", async () => {
    const { env, handleWebhook } = makeEnv();
    handleWebhook.mockRejectedValueOnce(new Error("simulated storage failure"));

    const response = await handleManagedTelegramRequest(
      webhookRequest(JSON.stringify(telegramUpdate())),
      env,
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "Telegram update could not be accepted",
    });
  });

  it("exposes only health and the exact webhook route", async () => {
    const { env } = makeEnv();
    const health = await handleManagedTelegramRequest(
      new Request("https://telegram.example/health"),
      env,
    );
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({
      service: "gsv-managed-telegram",
      configured: true,
    });
    expect((await handleManagedTelegramRequest(
      webhookRequest("{}"),
      { ...env, TELEGRAM_WEBHOOK_SECRET: undefined },
    )).status).toBe(503);
    expect((await handleManagedTelegramRequest(
      new Request("https://telegram.example/webhook/legacy"),
      env,
    )).status).toBe(404);
  });
});
