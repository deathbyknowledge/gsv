import {
  classifyNonIdempotentProviderStatus,
  type DeliveryFailureKind,
} from "../../shared/src/delivery-ledger";
import {
  cancelResponseBody,
  responseBodyToBinaryBody,
} from "../../shared/src/media-body";
import type { BinaryBody } from "./types";
import type { WhatsAppMediaLookup } from "./whatsapp-inbound-media";
import { z } from "zod";

export type WhatsAppJsonValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | WhatsAppJsonValue[]
  | { [key: string]: WhatsAppJsonValue };
/** One `messages` request body without the fixed `messaging_product` field. */
export type WhatsAppOutboundPayload = { [key: string]: WhatsAppJsonValue };
export type WhatsAppSentMessage = { messageId?: string };
export type ManagedWhatsAppFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export const WHATSAPP_GRAPH_VERSION = "v23.0";
export const WHATSAPP_GRAPH_BASE = `https://graph.facebook.com/${WHATSAPP_GRAPH_VERSION}`;
/** Meta's code for a free-form message sent outside the 24-hour customer service window. */
export const WHATSAPP_WINDOW_CLOSED_CODE = 131047;
export const WHATSAPP_WINDOW_CLOSED_ERROR =
  "WhatsApp customer service window is closed: this number has not messaged GSV in the last 24 hours, and template messages are not implemented yet";
const RATE_LIMIT_CODES = new Set([4, 80007, 130429, 131048, 131056]);

const graphErrorSchema = z.object({
  error: z.object({
    message: z.string().optional(),
    code: z.number().optional(),
    error_subcode: z.number().optional(),
    error_data: z.object({ details: z.string().optional() }).passthrough().optional(),
  }).passthrough(),
}).passthrough();
const sentMessageSchema = z.object({
  messages: z.array(z.object({ id: z.string().optional() }).passthrough()).optional(),
}).passthrough();
const mediaLookupSchema = z.object({
  url: z.string(),
  mime_type: z.string().optional(),
  file_size: z.union([z.number(), z.string()]).optional(),
}).passthrough();
const uploadedMediaSchema = z.object({ id: z.string() }).passthrough();

export class ManagedWhatsAppDeliveryError extends Error {
  constructor(
    message: string,
    readonly kind: DeliveryFailureKind,
    readonly graphStatus?: number,
    readonly graphCode?: number,
  ) {
    super(message);
    this.name = "ManagedWhatsAppDeliveryError";
  }

  get windowClosed(): boolean {
    return this.graphCode === WHATSAPP_WINDOW_CLOSED_CODE;
  }
}

export async function sendWhatsAppMessage(
  accessToken: string,
  phoneNumberId: string,
  payload: WhatsAppOutboundPayload,
  fetcher: ManagedWhatsAppFetch = fetch,
): Promise<WhatsAppSentMessage> {
  const result = await callWhatsAppGraph(
    accessToken,
    `${WHATSAPP_GRAPH_BASE}/${phoneNumberId}/messages`,
    { method: "POST", body: { messaging_product: "whatsapp", recipient_type: "individual", ...payload } },
    fetcher,
    { idempotent: false },
  );
  const parsed = sentMessageSchema.safeParse(result);
  if (!parsed.success) {
    throw new ManagedWhatsAppDeliveryError("WhatsApp message response is invalid", "ambiguous");
  }
  const messageId = parsed.data.messages?.[0]?.id?.trim();
  return messageId ? { messageId } : {};
}

/** Marks one inbound message read; the typing indicator rides on the same call. */
export async function markWhatsAppMessageRead(
  accessToken: string,
  phoneNumberId: string,
  messageId: string,
  fetcher: ManagedWhatsAppFetch = fetch,
  options: { typing?: boolean } = {},
): Promise<void> {
  await callWhatsAppGraph(
    accessToken,
    `${WHATSAPP_GRAPH_BASE}/${phoneNumberId}/messages`,
    {
      method: "POST",
      body: {
        messaging_product: "whatsapp",
        status: "read",
        message_id: messageId,
        ...(options.typing ? { typing_indicator: { type: "text" } } : {}),
      },
    },
    fetcher,
    { idempotent: true },
  );
}

export async function lookupWhatsAppMedia(
  accessToken: string,
  mediaId: string,
  phoneNumberId: string,
  fetcher: ManagedWhatsAppFetch = fetch,
): Promise<WhatsAppMediaLookup> {
  const url = new URL(`${WHATSAPP_GRAPH_BASE}/${encodeURIComponent(mediaId)}`);
  url.searchParams.set("phone_number_id", phoneNumberId);
  const result = await callWhatsAppGraph(accessToken, url.toString(), { method: "GET" }, fetcher, { idempotent: true });
  const parsed = mediaLookupSchema.safeParse(result);
  if (!parsed.success) throw new Error("WhatsApp media lookup response is invalid");
  const size = Number(parsed.data.file_size);
  return {
    url: parsed.data.url,
    mimeType: parsed.data.mime_type,
    size: Number.isSafeInteger(size) && size >= 0 ? size : undefined,
  };
}

export async function downloadWhatsAppMedia(
  accessToken: string,
  url: string,
  expectedSize: number | undefined,
  maxBytes: number,
  fetcher: ManagedWhatsAppFetch = fetch,
): Promise<BinaryBody & { length: number }> {
  const token = requireToken(accessToken);
  let response: Response;
  try {
    response = await fetcher(url, { headers: { Authorization: `Bearer ${token}` } });
  } catch {
    throw new Error("WhatsApp media download transport failed");
  }
  if (!response.ok) {
    await cancelResponseBody(response, "WhatsApp media download failed");
    throw new Error(`WhatsApp media download failed (HTTP ${response.status})`);
  }
  return await responseBodyToBinaryBody(response, {
    maxBytes,
    expectedBytes: expectedSize,
    label: "WhatsApp media",
  });
}

/** Uploads bytes to the business number's media store and returns the media id. */
export async function uploadWhatsAppMedia(
  accessToken: string,
  phoneNumberId: string,
  bytes: Uint8Array,
  mimeType: string,
  filename: string,
  fetcher: ManagedWhatsAppFetch = fetch,
): Promise<string> {
  const form = new FormData();
  form.set("messaging_product", "whatsapp");
  form.set("type", mimeType);
  form.set("file", new Blob([bytes], { type: mimeType }), filename);
  const result = await callWhatsAppGraph(
    accessToken,
    `${WHATSAPP_GRAPH_BASE}/${phoneNumberId}/media`,
    { method: "POST", body: form },
    fetcher,
    { idempotent: true },
  );
  const parsed = uploadedMediaSchema.safeParse(result);
  if (!parsed.success || !parsed.data.id.trim()) {
    throw new ManagedWhatsAppDeliveryError("WhatsApp media upload response is invalid", "retryable");
  }
  return parsed.data.id.trim();
}

/**
 * Calls one Graph endpoint with the platform access token. A message send has
 * no idempotency key, so its transport and server failures are ambiguous; the
 * other calls can be repeated safely and report the same failures as retryable.
 */
export async function callWhatsAppGraph(
  accessToken: string,
  url: string,
  init: { method: "GET" | "POST"; body?: FormData | WhatsAppOutboundPayload },
  fetcher: ManagedWhatsAppFetch,
  options: { idempotent: boolean },
): Promise<unknown> {
  const token = requireToken(accessToken);
  const formData = init.body instanceof FormData;
  const unknownOutcome: DeliveryFailureKind = options.idempotent ? "retryable" : "ambiguous";
  let response: Response;
  try {
    response = await fetcher(url, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body && !formData ? { "Content-Type": "application/json; charset=utf-8" } : {}),
      },
      body: init.body === undefined ? undefined : formData ? init.body as FormData : JSON.stringify(init.body),
    });
  } catch {
    throw new ManagedWhatsAppDeliveryError("WhatsApp Graph API transport failed", unknownOutcome);
  }

  let parsed: unknown = null;
  let malformed = false;
  try {
    const text = await response.text();
    parsed = text ? JSON.parse(text) : null;
  } catch {
    malformed = true;
  }
  const failure = graphErrorSchema.safeParse(parsed);
  if (!response.ok || failure.success || malformed || parsed === null) {
    if (response.ok && (malformed || parsed === null)) {
      throw new ManagedWhatsAppDeliveryError("WhatsApp Graph API returned an invalid response", unknownOutcome);
    }
    const code = failure.success ? failure.data.error.code : undefined;
    throw new ManagedWhatsAppDeliveryError(
      code === WHATSAPP_WINDOW_CLOSED_CODE
        ? WHATSAPP_WINDOW_CLOSED_ERROR
        : `WhatsApp Graph API rejected the request (HTTP ${response.status}${code === undefined ? "" : `, code ${code}`})`,
      classifyWhatsAppFailure(response.status, code, options.idempotent),
      response.status,
      code,
    );
  }
  return parsed;
}

export function classifyWhatsAppFailure(
  status: number,
  code: number | undefined,
  idempotent: boolean,
): DeliveryFailureKind {
  if (code === WHATSAPP_WINDOW_CLOSED_CODE) return "permanent";
  if (status === 429 || (code !== undefined && RATE_LIMIT_CODES.has(code))) return "retryable";
  const kind = classifyNonIdempotentProviderStatus(status);
  return kind === "ambiguous" && idempotent ? "retryable" : kind;
}

function requireToken(accessToken: string): string {
  const token = accessToken.trim();
  if (!token) {
    throw new ManagedWhatsAppDeliveryError("Managed WhatsApp access token is not configured", "permanent");
  }
  return token;
}
