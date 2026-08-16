import {
  classifyNonIdempotentProviderStatus,
  type DeliveryFailureKind,
} from "../../shared/src/delivery-ledger";
import { sendTelegramMarkdownMessage } from "./telegram-formatting";

const TELEGRAM_API_BASE = "https://api.telegram.org";

type TelegramApiSuccess<T> = { ok: true; result: T };
type TelegramApiFailure = { ok: false; description?: string; error_code?: number };
type TelegramApiResponse<T> = TelegramApiSuccess<T> | TelegramApiFailure;

export type TelegramSentMessage = { message_id: number };
export type ManagedTelegramFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export class ManagedTelegramDeliveryError extends Error {
  constructor(
    message: string,
    readonly kind: DeliveryFailureKind,
  ) {
    super(message);
    this.name = "ManagedTelegramDeliveryError";
  }
}

export async function sendManagedTelegramText(
  botToken: string,
  chatId: string,
  markdown: string,
  replyToMessageId?: number,
  fetcher: ManagedTelegramFetch = fetch,
): Promise<TelegramSentMessage> {
  return await sendTelegramMarkdownMessage(
    (method, payload) => callManagedTelegramApi<TelegramSentMessage>(
      botToken,
      method,
      payload,
      fetcher,
    ),
    chatId,
    markdown,
    replyToMessageId,
  );
}

export async function setManagedTelegramTyping(
  botToken: string,
  chatId: string,
  fetcher: ManagedTelegramFetch = fetch,
): Promise<void> {
  await callManagedTelegramApi<boolean>(botToken, "sendChatAction", {
    chat_id: chatId,
    action: "typing",
  }, fetcher);
}

async function callManagedTelegramApi<T>(
  botToken: string,
  method: string,
  payload: Record<string, unknown> | FormData,
  fetcher: ManagedTelegramFetch,
): Promise<T> {
  const token = botToken.trim();
  if (!token) {
    throw new ManagedTelegramDeliveryError(
      "Managed Telegram bot token is not configured",
      "permanent",
    );
  }

  let response: Response;
  try {
    const formData = payload instanceof FormData;
    response = await fetcher(`${TELEGRAM_API_BASE}/bot${token}/${method}`, {
      method: "POST",
      headers: formData ? undefined : { "Content-Type": "application/json; charset=utf-8" },
      body: formData ? payload : JSON.stringify(payload),
    });
  } catch {
    throw new ManagedTelegramDeliveryError(
      `Telegram API ${method} transport failed`,
      "ambiguous",
    );
  }

  let parsed: TelegramApiResponse<T> | null = null;
  try {
    const responseText = await response.text();
    parsed = responseText ? JSON.parse(responseText) as TelegramApiResponse<T> : null;
  } catch {
    if (response.ok) {
      throw new ManagedTelegramDeliveryError(
        `Telegram API ${method} returned an invalid response`,
        "ambiguous",
      );
    }
  }

  if (!response.ok || !parsed || !parsed.ok) {
    const providerStatus = parsed && !parsed.ok && Number.isFinite(parsed.error_code)
      ? parsed.error_code as number
      : response.status;
    throw new ManagedTelegramDeliveryError(
      `Telegram API ${method} rejected the request`,
      response.ok && !parsed
        ? "ambiguous"
        : classifyNonIdempotentProviderStatus(providerStatus),
    );
  }
  return parsed.result;
}
