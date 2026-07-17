import { describe, expect, it } from "vitest";
import {
  readTelegramWebhookRequest,
  readTelegramWebhookUpdate,
  TELEGRAM_WEBHOOK_MAX_BODY_BYTES,
  TelegramWebhookRequestError,
} from "./webhook-request";

const WEBHOOK_URL = "https://tenant.gsv.space/webhook/default";
const SECRET_TOKEN = "valid_Telegram-secret-123";

function webhookRequest(
  body: string,
  headers: Record<string, string> = {},
): Request {
  return new Request(WEBHOOK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": SECRET_TOKEN,
      ...headers,
    },
    body,
  });
}

async function expectRequestError(
  promise: Promise<unknown>,
  status: TelegramWebhookRequestError["status"],
  code: TelegramWebhookRequestError["code"],
): Promise<void> {
  try {
    await promise;
    throw new Error("Expected TelegramWebhookRequestError");
  } catch (error) {
    expect(error).toBeInstanceOf(TelegramWebhookRequestError);
    expect(error).toMatchObject({ status, code });
  }
}

describe("Telegram webhook request boundary", () => {
  it("rejects non-POST methods before body parsing", async () => {
    const request = new Request(WEBHOOK_URL, {
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": SECRET_TOKEN,
      },
    });

    await expectRequestError(
      readTelegramWebhookRequest(request),
      405,
      "method_not_allowed",
    );
  });

  it("requires an application/json content type", async () => {
    const request = webhookRequest("{}", { "Content-Type": "text/plain" });

    await expectRequestError(
      readTelegramWebhookRequest(request),
      415,
      "json_content_type_required",
    );
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["invalid characters", "not valid"],
    ["too long", "a".repeat(257)],
  ])("rejects a %s secret header before parsing", async (_label, secretToken) => {
    const headers = new Headers({ "Content-Type": "application/json" });
    if (secretToken !== undefined) {
      headers.set("X-Telegram-Bot-Api-Secret-Token", secretToken);
    }
    const request = new Request(WEBHOOK_URL, {
      method: "POST",
      headers,
      body: "{}",
    });

    await expectRequestError(
      readTelegramWebhookRequest(request),
      401,
      "invalid_secret_token",
    );
  });

  it("rejects malformed and oversized declared content lengths", async () => {
    await expectRequestError(
      readTelegramWebhookRequest(webhookRequest("{}", { "Content-Length": "12x" })),
      400,
      "invalid_content_length",
    );
    await expectRequestError(
      readTelegramWebhookRequest(
        webhookRequest("{}", {
          "Content-Length": String(TELEGRAM_WEBHOOK_MAX_BODY_BYTES + 1),
        }),
      ),
      413,
      "request_too_large",
    );
  });

  it("cancels a streamed body as soon as it exceeds the limit", async () => {
    let cancellationReason: unknown;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(TELEGRAM_WEBHOOK_MAX_BODY_BYTES + 1));
      },
      cancel(reason) {
        cancellationReason = reason;
      },
    });

    await expectRequestError(
      readTelegramWebhookUpdate(stream),
      413,
      "request_too_large",
    );
    expect(cancellationReason).toBe("Telegram webhook request exceeded the body limit");
  });

  it("rejects malformed JSON and non-object JSON", async () => {
    await expectRequestError(
      readTelegramWebhookRequest(webhookRequest("{")),
      400,
      "invalid_json",
    );
    await expectRequestError(
      readTelegramWebhookRequest(webhookRequest("[]")),
      400,
      "invalid_json",
    );
  });

  it("returns a bounded object and the validated secret token", async () => {
    const result = await readTelegramWebhookRequest(
      webhookRequest('{"update_id":42,"message":{"text":"hello"}}'),
    );

    expect(result).toEqual({
      secretToken: SECRET_TOKEN,
      update: {
        update_id: 42,
        message: { text: "hello" },
      },
    });
  });
});
