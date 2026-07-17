import {
  readTelegramWebhookUpdate,
  TelegramWebhookRequestError,
  validateTelegramWebhookRequest,
} from "./webhook-request";

type TelegramWebhookAccount = {
  authorizeWebhook(secretToken: string): Promise<
    | { ok: true; acceptBody: boolean }
    | { ok: false; status: number; error: string }
  >;
  handleWebhook(
    update: unknown,
    secretToken: string,
  ): Promise<{ ok: boolean; status?: number; error?: string }>;
};

export async function handleTelegramWebhookRequest(
  request: Request,
  account: TelegramWebhookAccount,
): Promise<Response> {
  let secretToken: string;
  try {
    secretToken = validateTelegramWebhookRequest(request);
  } catch (error) {
    if (error instanceof TelegramWebhookRequestError) {
      await request.body?.cancel("Telegram webhook request was rejected").catch(() => {});
      const headers = error.status === 405 ? { Allow: "POST" } : undefined;
      return Response.json(
        { ok: false, error: error.message },
        { status: error.status, headers },
      );
    }
    return toJsonError("Failed to read Telegram webhook payload", 400);
  }

  const authorization = await account.authorizeWebhook(secretToken);
  if (!authorization.ok) {
    await request.body?.cancel("Telegram webhook authorization failed").catch(() => {});
    return toJsonError(
      authorization.error || "Invalid webhook secret token",
      authorization.status || 401,
    );
  }
  if (!authorization.acceptBody) {
    await request.body?.cancel("Telegram webhook was dropped while the account is paused")
      .catch(() => {});
    return Response.json({ ok: true });
  }

  let update: Record<string, unknown>;
  try {
    update = await readTelegramWebhookUpdate(request.body);
  } catch (error) {
    if (error instanceof TelegramWebhookRequestError) {
      return Response.json(
        { ok: false, error: error.message },
        { status: error.status },
      );
    }
    return toJsonError("Failed to read Telegram webhook payload", 400);
  }

  const result = await account.handleWebhook(update, secretToken);
  if (!result.ok) {
    return toJsonError(
      result.error || "Failed to handle Telegram webhook",
      result.status || 500,
    );
  }
  return Response.json({ ok: true });
}

function toJsonError(message: string, status = 500): Response {
  return Response.json({ ok: false, error: message }, { status });
}
