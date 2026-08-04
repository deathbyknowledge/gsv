import {
  classifyNonIdempotentProviderStatus,
  type DeliveryFailureKind,
} from "../../shared/src/delivery-ledger";
import { sendTelegramMarkdownMessage } from "./telegram-formatting";

const TELEGRAM_API_BASE = "https://api.telegram.org";

type TelegramApiSuccess<T> = { ok: true; result: T };
type TelegramApiFailure = {
  ok: false;
  description?: string;
  error_code?: number;
};
type TelegramApiResponse<T> = TelegramApiSuccess<T> | TelegramApiFailure;

export type TelegramSentMessage = { message_id: number };

export class ManagedTelegramDeliveryError extends Error {
  constructor(
    message: string,
    readonly kind: DeliveryFailureKind,
    readonly telegramStatus?: number,
    readonly telegramDescription?: string,
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
): Promise<TelegramSentMessage> {
  return await sendTelegramMarkdownMessage(
    (method, payload) => callManagedTelegramApi<TelegramSentMessage>(
      botToken,
      method,
      payload,
    ),
    chatId,
    markdown,
    replyToMessageId,
  );
}

export async function sendManagedTelegramLink(
  botToken: string,
  chatId: string,
  input: {
    text: string;
    buttonText: string;
    url: string;
    replyToMessageId?: number;
  },
): Promise<TelegramSentMessage> {
  return await callManagedTelegramApi<TelegramSentMessage>(
    botToken,
    "sendMessage",
    {
      chat_id: chatId,
      text: input.text,
      ...(input.replyToMessageId
        ? { reply_parameters: { message_id: input.replyToMessageId } }
        : {}),
      reply_markup: {
        inline_keyboard: [[{ text: input.buttonText, url: input.url }]],
      },
    },
  );
}

export async function setManagedTelegramTyping(
  botToken: string,
  chatId: string,
): Promise<void> {
  await callManagedTelegramApi<boolean>(botToken, "sendChatAction", {
    chat_id: chatId,
    action: "typing",
  });
}

async function callManagedTelegramApi<T>(
  botToken: string,
  method: string,
  payload: Record<string, unknown> | FormData,
): Promise<T> {
  const token = botToken.trim();
  if (!token) {
    throw new ManagedTelegramDeliveryError(
      "Managed Telegram bot token is not configured",
      "permanent",
    );
  }
  const formData = typeof FormData !== "undefined" && payload instanceof FormData;
  let response: Response;
  try {
    response = await fetch(`${TELEGRAM_API_BASE}/bot${token}/${method}`, {
      method: "POST",
      headers: formData
        ? undefined
        : { "Content-Type": "application/json; charset=utf-8" },
      body: formData ? payload : JSON.stringify(payload),
    });
  } catch (error) {
    throw new ManagedTelegramDeliveryError(
      `Telegram API ${method} transport failed: ${errorMessage(error)}`,
      "ambiguous",
    );
  }

  let responseText: string;
  try {
    responseText = await response.text();
  } catch (error) {
    throw new ManagedTelegramDeliveryError(
      `Telegram API ${method} response could not be read: ${errorMessage(error)}`,
      response.ok
        ? "ambiguous"
        : classifyNonIdempotentProviderStatus(response.status),
    );
  }

  let parsed: TelegramApiResponse<T> | null = null;
  try {
    parsed = responseText ? JSON.parse(responseText) as TelegramApiResponse<T> : null;
  } catch {
    parsed = null;
  }
  if (!response.ok || !parsed || !parsed.ok) {
    const providerError = parsed && !parsed.ok ? parsed : null;
    const status = providerError?.error_code ?? response.status;
    const description = providerError?.description
      || response.statusText
      || "Invalid Telegram response";
    throw new ManagedTelegramDeliveryError(
      `Telegram API ${method} failed (${status}): ${description}`,
      response.ok && !parsed
        ? "ambiguous"
        : classifyNonIdempotentProviderStatus(status),
      status,
      description,
    );
  }
  return parsed.result;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
