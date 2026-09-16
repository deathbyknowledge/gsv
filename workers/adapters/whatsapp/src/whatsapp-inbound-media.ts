import {
  bundleAdapterMedia,
  cancelBinaryBody,
  SAFE_MATERIALIZED_MEDIA_PART_BYTES,
  SAFE_MATERIALIZED_MEDIA_TOTAL_BYTES,
  type AdapterMediaBundle,
  type AdapterMediaPart,
} from "../../shared/src/media-body";
import type { AdapterMedia, BinaryBody } from "./types";
import { z } from "zod";

const whatsAppMediaSchema = z.object({
  id: z.string().optional(),
  mime_type: z.string().optional(),
  caption: z.string().optional(),
  filename: z.string().optional(),
  voice: z.boolean().optional(),
  animated: z.boolean().optional(),
}).passthrough();
const whatsAppMessageSchema = z.object({
  text: z.object({ body: z.string().optional() }).passthrough().optional(),
  image: whatsAppMediaSchema.optional(),
  video: whatsAppMediaSchema.optional(),
  audio: whatsAppMediaSchema.optional(),
  document: whatsAppMediaSchema.optional(),
  sticker: whatsAppMediaSchema.optional(),
}).passthrough();
type WhatsAppMediaField = z.infer<typeof whatsAppMediaSchema>;

export type WhatsAppInboundMediaSource = {
  type: AdapterMedia["type"];
  mediaId: string;
  mimeType: string;
  filename?: string;
  size?: number;
};

export type WhatsAppInboundContent = {
  text: string | null;
  media: WhatsAppInboundMediaSource[];
};

/** The Graph media lookup result that precedes a download. */
export type WhatsAppMediaLookup = {
  url: string;
  mimeType?: string;
  size?: number;
};

export type WhatsAppInboundMediaLoadResult = AdapterMediaBundle & {
  skipped: number;
};

export function extractWhatsAppInboundContent(
  value: z.input<typeof whatsAppMessageSchema>,
): WhatsAppInboundContent {
  const parsed = whatsAppMessageSchema.safeParse(value);
  if (!parsed.success) return { text: null, media: [] };
  const message = parsed.data;

  const media: WhatsAppInboundMediaSource[] = [];
  let caption: string | null = null;
  let fallbackText: string | null = null;
  const add = (source: WhatsAppInboundMediaSource | null, field: WhatsAppMediaField | undefined, placeholder: string): void => {
    if (!source) return;
    media.push(source);
    caption ??= normalizedText(field?.caption);
    fallbackText ??= placeholder;
  };

  add(mediaSource(message.image, "image", "image/jpeg", "jpg"), message.image, "[Image]");
  add(mediaSource(message.video, "video", "video/mp4", "mp4"), message.video, "[Video]");
  add(
    mediaSource(message.audio, "audio", "audio/ogg", "ogg"),
    message.audio,
    message.audio?.voice === true ? "[Voice note]" : "[Audio]",
  );
  add(mediaSource(message.document, "document", "application/octet-stream", "bin"), message.document, "[Document]");
  add(mediaSource(message.sticker, "image", "image/webp", "webp"), message.sticker, "[Sticker]");

  return {
    text: normalizedText(message.text?.body) ?? caption ?? fallbackText,
    media,
  };
}

/** Looks each media id up, downloads it through the Graph media URL, and packs one frame body. */
export async function loadWhatsAppInboundMedia(
  sources: readonly WhatsAppInboundMediaSource[],
  options: {
    lookupMedia(mediaId: string): Promise<WhatsAppMediaLookup>;
    downloadMedia(
      url: string,
      expectedSize: number | undefined,
      maxBytes: number,
    ): Promise<(BinaryBody & { length: number }) | null>;
    skipFailures?: boolean;
    onFailure?(error: Error | string): void;
  },
): Promise<WhatsAppInboundMediaLoadResult> {
  const parts: AdapterMediaPart[] = [];
  let bodyBytes = 0;
  let skipped = 0;

  for (const source of sources) {
    const remaining = SAFE_MATERIALIZED_MEDIA_TOTAL_BYTES - bodyBytes;
    const maxBytes = Math.min(SAFE_MATERIALIZED_MEDIA_PART_BYTES, remaining);
    if (maxBytes <= 0 || (source.size !== undefined && source.size > maxBytes)) {
      skipped += 1;
      continue;
    }

    try {
      const lookup = await options.lookupMedia(source.mediaId);
      const size = safeNonNegativeInteger(lookup.size) ?? source.size;
      const url = mediaUrl(lookup.url);
      if (!url || (size !== undefined && size > maxBytes)) {
        skipped += 1;
        continue;
      }
      const body = await options.downloadMedia(url, size, maxBytes);
      if (!body) {
        skipped += 1;
        continue;
      }
      parts.push({
        media: {
          type: source.type,
          mimeType: boundedString(lookup.mimeType, 255) ?? source.mimeType,
          filename: source.filename,
          size: body.length,
        },
        body,
      });
      bodyBytes += body.length;
    } catch (error) {
      options.onFailure?.(error instanceof Error ? error : String(error));
      if (options.skipFailures) {
        skipped += 1;
        continue;
      }
      await Promise.all(parts.map((part) => cancelBinaryBody(part.body, error)));
      throw error;
    }
  }

  return { ...await bundleAdapterMedia(parts), skipped };
}

function mediaSource(
  value: WhatsAppMediaField | undefined,
  type: AdapterMedia["type"],
  defaultMimeType: string,
  defaultExtension: string,
): WhatsAppInboundMediaSource | null {
  const mediaId = providerMediaId(value?.id);
  if (!mediaId) return null;
  const mimeType = boundedString(value?.mime_type, 255) ?? defaultMimeType;
  const filename = boundedString(value?.filename, 255)
    ?? `whatsapp-${type}-${mediaId}.${extensionFromMime(mimeType) ?? defaultExtension}`;
  return { type, mediaId, mimeType, filename };
}

function extensionFromMime(mimeType: string): string | undefined {
  const normalized = mimeType.split(";", 1)[0]!.trim().toLowerCase();
  const mapping = {
    "application/pdf": "pdf",
    "audio/aac": "aac",
    "audio/amr": "amr",
    "audio/mp4": "m4a",
    "audio/mpeg": "mp3",
    "audio/ogg": "ogg",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "video/3gpp": "3gp",
    "video/mp4": "mp4",
  } satisfies Record<string, string>;
  return Object.entries(mapping).find(([key]) => key === normalized)?.[1];
}

function mediaUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function normalizedText(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function providerMediaId(value: string | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return /^[A-Za-z0-9._-]{1,128}$/.test(normalized) ? normalized : null;
}

function boundedString(value: string | undefined, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maxLength) : undefined;
}

function safeNonNegativeInteger(value: number | undefined): number | undefined {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}
