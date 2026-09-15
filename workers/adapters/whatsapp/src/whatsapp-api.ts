import {
  classifyNonIdempotentProviderStatus,
  type DeliveryFailureKind,
} from "../../shared/src/delivery-ledger";
import {
  cancelResponseBody,
  responseBodyToBinaryBody,
} from "../../shared/src/media-body";
import { jsonValueSchema } from "../../../../packages/gsv/src/protocol/json.js";
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
type WhatsAppReadReceipt = {
  messaging_product: "whatsapp";
  status: "read";
  message_id: string;
  typing_indicator?: { type: "text" };
};
export type ManagedWhatsAppFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export const WHATSAPP_GRAPH_VERSION = "v23.0";
export const WHATSAPP_GRAPH_BASE = `https://graph.facebook.com/${WHATSAPP_GRAPH_VERSION}`;
/** Meta's code for a free-form message sent outside the 24-hour customer service window. */
export const WHATSAPP_WINDOW_CLOSED_CODE = 131047;
export const WHATSAPP_WINDOW_CLOSED_ERROR =
  "WhatsApp customer service window is closed: this number has not messaged GSV in the last 24 hours";
/** Meta's template errors (missing, unapproved, paused, parameter mismatch) share the 1320xx range. */
const TEMPLATE_ERROR_MIN = 132000;
const TEMPLATE_ERROR_MAX = 132999;
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
const acknowledgedSchema = z.object({}).passthrough();
type GraphBody =
  | { kind: "json"; value: z.infer<typeof jsonValueSchema> }
  | { kind: "empty" }
  | { kind: "malformed" };

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

  get templateRejected(): boolean {
    return isWhatsAppTemplateErrorCode(this.graphCode);
  }
}

export function isWhatsAppTemplateErrorCode(code: number | undefined): boolean {
  return code !== undefined && code >= TEMPLATE_ERROR_MIN && code <= TEMPLATE_ERROR_MAX;
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
    { idempotent: false, schema: sentMessageSchema },
  );
  const messageId = result.messages?.[0]?.id?.trim();
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
  const body: WhatsAppReadReceipt = {
    messaging_product: "whatsapp",
    status: "read",
    message_id: messageId,
  };
  if (options.typing) body.typing_indicator = { type: "text" };
  await callWhatsAppGraph(
    accessToken,
    `${WHATSAPP_GRAPH_BASE}/${phoneNumberId}/messages`,
    { method: "POST", body },
    fetcher,
    { idempotent: true, schema: acknowledgedSchema },
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
  const result = await callWhatsAppGraph(
    accessToken,
    url.toString(),
    { method: "GET" },
    fetcher,
    { idempotent: true, schema: mediaLookupSchema },
  );
  const size = Number(result.file_size);
  return {
    url: result.url,
    mimeType: result.mime_type,
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
    throw new ManagedWhatsAppDeliveryError("WhatsApp media download transport failed", "retryable");
  }
  // Media Meta no longer serves (deleted, expired, unavailable) answers 4xx
  // and will not reappear on retry; server and transport trouble is retried.
  if (!response.ok) {
    await cancelResponseBody(response, "WhatsApp media download failed");
    throw new ManagedWhatsAppDeliveryError(
      `WhatsApp media download failed (HTTP ${response.status})`,
      classifyWhatsAppFailure(response.status, undefined, true),
      response.status,
    );
  }
  try {
    return await responseBodyToBinaryBody(response, {
      maxBytes,
      expectedBytes: expectedSize,
      label: "WhatsApp media",
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "WhatsApp media body could not be read";
    // A body past the transfer limit stays past it; an interrupted read may succeed next time.
    throw new ManagedWhatsAppDeliveryError(
      detail,
      detail.includes("exceeds transfer limit") ? "permanent" : "retryable",
    );
  }
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
    { idempotent: true, schema: uploadedMediaSchema },
  );
  const mediaId = result.id.trim();
  if (!mediaId) {
    throw new ManagedWhatsAppDeliveryError("WhatsApp media upload response is invalid", "retryable");
  }
  return mediaId;
}

/**
 * Calls one Graph endpoint with the platform access token and parses the
 * response with the caller's schema. A message send has no idempotency key,
 * so its transport and server failures are ambiguous; the other calls can be
 * repeated safely and report the same failures as retryable.
 */
export async function callWhatsAppGraph<T>(
  accessToken: string,
  url: string,
  init: { method: "GET" | "POST"; body?: FormData | WhatsAppOutboundPayload },
  fetcher: ManagedWhatsAppFetch,
  options: { idempotent: boolean; schema: z.ZodType<T> },
): Promise<T> {
  const token = requireToken(accessToken);
  const unknownOutcome: DeliveryFailureKind = options.idempotent ? "retryable" : "ambiguous";
  const headers = new Headers({ Authorization: `Bearer ${token}` });
  let body: FormData | string | undefined;
  if (init.body instanceof FormData) {
    body = init.body;
  } else if (init.body !== undefined) {
    headers.set("Content-Type", "application/json; charset=utf-8");
    body = JSON.stringify(init.body);
  }
  let response: Response;
  try {
    response = await fetcher(url, { method: init.method, headers, body });
  } catch {
    throw new ManagedWhatsAppDeliveryError("WhatsApp Graph API transport failed", unknownOutcome);
  }

  const graphBody = await readGraphBody(response);
  const failure = graphBody.kind === "json" ? graphErrorSchema.safeParse(graphBody.value) : null;
  if (response.ok && graphBody.kind === "json" && !failure?.success) {
    const parsed = options.schema.safeParse(graphBody.value);
    if (parsed.success) return parsed.data;
    throw new ManagedWhatsAppDeliveryError("WhatsApp Graph API returned an invalid response", unknownOutcome);
  }
  if (response.ok && graphBody.kind !== "json") {
    throw new ManagedWhatsAppDeliveryError("WhatsApp Graph API returned an invalid response", unknownOutcome);
  }
  const code = failure?.success ? failure.data.error.code : undefined;
  throw new ManagedWhatsAppDeliveryError(
    rejectionMessage(response.status, code),
    classifyWhatsAppFailure(response.status, code, options.idempotent),
    response.status,
    code,
  );
}

function rejectionMessage(status: number, code: number | undefined): string {
  if (code === WHATSAPP_WINDOW_CLOSED_CODE) return WHATSAPP_WINDOW_CLOSED_ERROR;
  if (isWhatsAppTemplateErrorCode(code)) {
    return `WhatsApp template message was rejected by Meta (code ${code}); check the template filed in the Meta app against the message templates section of workers/adapters/whatsapp/README.md`;
  }
  return `WhatsApp Graph API rejected the request (HTTP ${status}${code === undefined ? "" : `, code ${code}`})`;
}

async function readGraphBody(response: Response): Promise<GraphBody> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return { kind: "malformed" };
  }
  if (!text) return { kind: "empty" };
  try {
    const decoded = jsonValueSchema.safeParse(JSON.parse(text));
    return decoded.success ? { kind: "json", value: decoded.data } : { kind: "malformed" };
  } catch {
    return { kind: "malformed" };
  }
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
