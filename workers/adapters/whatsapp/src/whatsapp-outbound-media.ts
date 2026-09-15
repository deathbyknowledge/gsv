import type { AdapterMedia } from "./types";
import {
  ManagedWhatsAppDeliveryError,
  type WhatsAppOutboundPayload,
  type WhatsAppSentMessage,
} from "./whatsapp-api";
import { WHATSAPP_CAPTION_LIMIT } from "./whatsapp-formatting";

const MEGABYTE = 1_000_000;
/** Meta's per-type upload limits for outbound media. */
export const WHATSAPP_MEDIA_BYTE_LIMITS = {
  image: 5 * MEGABYTE,
  video: 16 * MEGABYTE,
  audio: 16 * MEGABYTE,
  document: 100 * MEGABYTE,
} satisfies Record<AdapterMedia["type"], number>;

export type WhatsAppMediaApi = {
  upload(bytes: Uint8Array, mimeType: string, filename: string): Promise<string>;
  send(payload: WhatsAppOutboundPayload): Promise<WhatsAppSentMessage>;
};

/** Audio messages carry no caption on WhatsApp. */
export function whatsAppMediaSupportsCaption(type: AdapterMedia["type"]): boolean {
  return type !== "audio";
}

export function whatsAppCaptionFits(text: string): boolean {
  return [...text].length <= WHATSAPP_CAPTION_LIMIT;
}

/**
 * Sends one attachment: bytes are uploaded first and referenced by media id,
 * a URL is passed through as a link. The caption is applied only when the
 * media type supports one and the text fits Meta's caption limit.
 */
export async function sendWhatsAppMediaMessage(
  api: WhatsAppMediaApi,
  to: string,
  media: AdapterMedia,
  bytes: Uint8Array | undefined,
  caption: string | undefined,
  replyToId?: string,
): Promise<WhatsAppSentMessage> {
  const limit = WHATSAPP_MEDIA_BYTE_LIMITS[media.type];
  let reference: { id: string } | { link: string };
  if (bytes) {
    if (bytes.byteLength > limit) {
      throw new ManagedWhatsAppDeliveryError(
        `WhatsApp ${media.type} attachments must be at most ${limit / MEGABYTE} MB`,
        "permanent",
      );
    }
    reference = { id: await api.upload(bytes, media.mimeType, whatsAppMediaFilename(media)) };
  } else if (media.url) {
    reference = { link: media.url };
  } else {
    throw new ManagedWhatsAppDeliveryError(
      "WhatsApp media attachment must include either a binary body or a URL",
      "permanent",
    );
  }

  const attachment: { [key: string]: string } = { ...reference };
  const trimmedCaption = caption?.trim();
  if (trimmedCaption && whatsAppMediaSupportsCaption(media.type) && whatsAppCaptionFits(trimmedCaption)) {
    attachment.caption = trimmedCaption;
  }
  if (media.type === "document") attachment.filename = whatsAppMediaFilename(media);

  const payload: WhatsAppOutboundPayload = {
    to,
    type: media.type,
    [media.type]: attachment,
  };
  if (replyToId) payload.context = { message_id: replyToId };
  return await api.send(payload);
}

export function whatsAppMediaFilename(media: AdapterMedia): string {
  const provided = media.filename?.trim();
  if (provided) return provided;
  const normalized = media.mimeType.split(";", 1)[0]!.trim().toLowerCase();
  const mapping = {
    "application/json": "json",
    "application/pdf": "pdf",
    "application/zip": "zip",
    "audio/aac": "aac",
    "audio/mp4": "m4a",
    "audio/mpeg": "mp3",
    "audio/ogg": "ogg",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "text/plain": "txt",
    "video/3gpp": "3gp",
    "video/mp4": "mp4",
  } satisfies Record<string, string>;
  const extension = Object.entries(mapping).find(([mimeType]) => mimeType === normalized)?.[1]
    ?? (media.type === "document" ? "bin" : media.type);
  return `attachment.${extension}`;
}
