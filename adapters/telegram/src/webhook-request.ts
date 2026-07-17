export const TELEGRAM_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;

const TELEGRAM_SECRET_TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;

export type TelegramWebhookRequestErrorCode =
  | "method_not_allowed"
  | "json_content_type_required"
  | "invalid_secret_token"
  | "invalid_content_length"
  | "request_too_large"
  | "invalid_json";

export class TelegramWebhookRequestError extends Error {
  constructor(
    readonly status: 400 | 401 | 405 | 413 | 415,
    readonly code: TelegramWebhookRequestErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TelegramWebhookRequestError";
  }
}

export type TelegramWebhookRequest = Readonly<{
  update: Record<string, unknown>;
  secretToken: string;
}>;

export async function readTelegramWebhookRequest(
  request: Request,
): Promise<TelegramWebhookRequest> {
  try {
    const secretToken = validateTelegramWebhookHeaders(request);
    const update = await readTelegramWebhookUpdate(request.body);
    return { update, secretToken };
  } catch (error) {
    if (error instanceof TelegramWebhookRequestError && !request.bodyUsed) {
      await request.body?.cancel("Telegram webhook request was rejected").catch(() => {});
    }
    throw error;
  }
}

export function validateTelegramWebhookRequest(request: Request): string {
  return validateTelegramWebhookHeaders(request);
}

export async function readTelegramWebhookUpdate(
  body: ReadableStream<Uint8Array> | null,
): Promise<Record<string, unknown>> {
  if (!body) {
    throw invalidJson();
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength === 0) continue;
      length += value.byteLength;
      if (length > TELEGRAM_WEBHOOK_MAX_BODY_BYTES) {
        await reader.cancel("Telegram webhook request exceeded the body limit").catch(() => {});
        throw new TelegramWebhookRequestError(
          413,
          "request_too_large",
          "Telegram webhook payload is too large",
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    );
  } catch {
    throw invalidJson();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw invalidJson();
  }
  return parsed as Record<string, unknown>;
}

function validateTelegramWebhookHeaders(request: Request): string {
  if (request.method !== "POST") {
    throw new TelegramWebhookRequestError(
      405,
      "method_not_allowed",
      "Telegram webhooks require POST",
    );
  }

  const contentType = request.headers.get("content-type")
    ?.split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    throw new TelegramWebhookRequestError(
      415,
      "json_content_type_required",
      "Telegram webhooks require application/json",
    );
  }

  const secretToken = request.headers.get("x-telegram-bot-api-secret-token");
  if (!secretToken || !TELEGRAM_SECRET_TOKEN_PATTERN.test(secretToken)) {
    throw new TelegramWebhookRequestError(
      401,
      "invalid_secret_token",
      "Invalid Telegram webhook secret token",
    );
  }

  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^(0|[1-9][0-9]*)$/.test(contentLength)) {
      throw new TelegramWebhookRequestError(
        400,
        "invalid_content_length",
        "Invalid Telegram webhook content length",
      );
    }
    const declaredLength = Number(contentLength);
    if (
      !Number.isSafeInteger(declaredLength) ||
      declaredLength > TELEGRAM_WEBHOOK_MAX_BODY_BYTES
    ) {
      throw new TelegramWebhookRequestError(
        413,
        "request_too_large",
        "Telegram webhook payload is too large",
      );
    }
  }

  return secretToken;
}

function invalidJson(): TelegramWebhookRequestError {
  return new TelegramWebhookRequestError(
    400,
    "invalid_json",
    "Invalid Telegram webhook payload",
  );
}
