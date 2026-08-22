import {
  classifyNonIdempotentProviderStatus,
  type DeliveryFailureKind,
} from "../../shared/src/delivery-ledger";
import {
  cancelResponseBody,
  responseBodyToBinaryBody,
} from "../../shared/src/media-body";
import type { BinaryBody } from "./types";
import type { TelegramInboundFile } from "./telegram-inbound-media";
import { sendTelegramMarkdownMessage } from "./telegram-formatting";
type TelegramJsonValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | TelegramJsonValue[]
  | { [key: string]: TelegramJsonValue };
type TelegramApiPayload = FormData | { [key: string]: TelegramJsonValue };

const TELEGRAM_API_BASE = "https://api.telegram.org";
const TELEGRAM_FILE_BASE = "https://api.telegram.org/file";

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

export async function getManagedTelegramFile(
  botToken: string,
  fileId: string,
  fetcher: ManagedTelegramFetch = fetch,
): Promise<TelegramInboundFile> {
  return await callManagedTelegramApi<TelegramInboundFile>(
    botToken,
    "getFile",
    { file_id: fileId },
    fetcher,
  );
}

export async function downloadManagedTelegramFile(
  botToken: string,
  filePath: string,
  expectedSize: number | undefined,
  maxBytes: number,
  fetcher: ManagedTelegramFetch = fetch,
): Promise<BinaryBody & { length: number }> {
  const token = botToken.trim();
  if (!token) throw new Error("Managed Telegram bot token is not configured");
  const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
  let response: Response;
  try {
    response = await fetcher(`${TELEGRAM_FILE_BASE}/bot${token}/${encodedPath}`);
  } catch {
    throw new Error("Telegram media download transport failed");
  }
  if (!response.ok) {
    await cancelResponseBody(response, "Telegram media download failed");
    throw new Error(`Telegram media download failed (HTTP ${response.status})`);
  }
  return await responseBodyToBinaryBody(response, {
    maxBytes,
    expectedBytes: expectedSize,
    label: "Telegram media",
  });
}

export async function callManagedTelegramApi<T>(
  botToken: string,
  method: string,
  payload: TelegramApiPayload,
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
    parsed = responseText ? JSON.parse(responseText) : null;
  } catch {
    if (response.ok) {
      throw new ManagedTelegramDeliveryError(
        `Telegram API ${method} returned an invalid response`,
        "ambiguous",
      );
    }
  }

  if (!response.ok || !parsed || !parsed.ok) {
    const providerStatus = parsed && !parsed.ok && parsed.error_code !== undefined
      ? parsed.error_code
      : response.status;
    const description = parsed && !parsed.ok ? parsed.description : undefined;
    throw new ManagedTelegramDeliveryError(
      `Telegram API ${method} rejected the request`,
      response.ok && !parsed
        ? "ambiguous"
        : classifyNonIdempotentProviderStatus(providerStatus),
      providerStatus,
      description,
    );
  }
  return parsed.result;
}
