import { describe, expect, it, vi } from "vitest";
import { handleTelegramWebhookRequest } from "./webhook-handler";

const URL = "https://tenant.gsv.space/webhook/account-1";
const SECRET = "valid-secret_123";

describe("Telegram webhook authentication order", () => {
  it("rejects an unauthorized request before parsing its malformed body", async () => {
    const authorizeWebhook = vi.fn(async () => ({
      ok: false as const,
      status: 401,
      error: "Invalid webhook secret token",
    }));
    const handleWebhook = vi.fn();
    const response = await handleTelegramWebhookRequest(webhookRequest("{"), {
      authorizeWebhook,
      handleWebhook,
    });

    expect(response.status).toBe(401);
    expect(authorizeWebhook).toHaveBeenCalledWith(SECRET);
    expect(handleWebhook).not.toHaveBeenCalled();
  });

  it("parses and delivers a request only after durable authorization", async () => {
    const calls: string[] = [];
    const response = await handleTelegramWebhookRequest(
      webhookRequest('{"update_id":42}'),
      {
        authorizeWebhook: async () => {
          calls.push("authorize");
          return { ok: true as const, acceptBody: true };
        },
        handleWebhook: async (update: unknown, secret: string) => {
          calls.push("handle");
          expect(update).toEqual({ update_id: 42 });
          expect(secret).toBe(SECRET);
          return { ok: true };
        },
      },
    );

    expect(response.status).toBe(200);
    expect(calls).toEqual(["authorize", "handle"]);
  });
});

function webhookRequest(body: string): Request {
  return new Request(URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": SECRET,
    },
    body,
  });
}
