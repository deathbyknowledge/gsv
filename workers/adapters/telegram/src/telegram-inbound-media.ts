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

const telegramFileSchema = z.object({
  file_id: z.string().optional(), file_size: z.number().optional(), file_path: z.string().optional(),
  mime_type: z.string().optional(), file_name: z.string().optional(), duration: z.number().optional(),
  is_video: z.boolean().optional(), is_animated: z.boolean().optional(), width: z.number().optional(), height: z.number().optional(),
}).passthrough();
const telegramMessageSchema = z.object({
  text: z.string().optional(), caption: z.string().optional(), photo: z.array(telegramFileSchema).optional(),
  video: telegramFileSchema.optional(), video_note: telegramFileSchema.optional(), audio: telegramFileSchema.optional(),
  voice: telegramFileSchema.optional(), document: telegramFileSchema.optional(), animation: telegramFileSchema.optional(),
  sticker: telegramFileSchema.optional(),
}).passthrough();
type TelegramFile = z.infer<typeof telegramFileSchema>;

export type TelegramInboundMediaSource = {
  type: AdapterMedia["type"];
  fileId: string;
  mimeType: string;
  filename?: string;
  size?: number;
  duration?: number;
};

export type TelegramInboundContent = {
  text: string | null;
  media: TelegramInboundMediaSource[];
};

export type TelegramInboundFile = {
  file_size?: number;
  file_path?: string;
};

export type TelegramInboundMediaLoadResult = AdapterMediaBundle & {
  skipped: number;
};

export function extractTelegramInboundContent(
  value: z.input<typeof telegramMessageSchema>,
  messageId: string,
): TelegramInboundContent {
  const parsed = telegramMessageSchema.safeParse(value);
  if (!parsed.success) return { text: null, media: [] };
  const message = parsed.data;

  const media: TelegramInboundMediaSource[] = [];
  let fallbackText: string | null = null;
  const add = (
    source: TelegramInboundMediaSource | null,
    placeholder: string,
  ): void => {
    if (!source) return;
    media.push(source);
    fallbackText ??= placeholder;
  };

  const photo = largestPhoto(message.photo);
  if (photo) {
    add({
      type: "image",
      fileId: photo.fileId,
      mimeType: "image/jpeg",
      filename: `telegram-photo-${messageId}.jpg`,
      size: photo.size,
    }, "[Photo]");
  }
  add(fileSource(
    message.video,
    "video",
    "video/mp4",
    `telegram-video-${messageId}.mp4`,
  ), "[Video]");
  add(fileSource(
    message.video_note,
    "video",
    "video/mp4",
    `telegram-video-note-${messageId}.mp4`,
  ), "[Video note]");
  add(fileSource(
    message.audio,
    "audio",
    "audio/mpeg",
    `telegram-audio-${messageId}.mp3`,
  ), "[Audio]");
  add(fileSource(
    message.voice,
    "audio",
    "audio/ogg",
    `telegram-voice-${messageId}.ogg`,
  ), "[Voice note]");
  add(fileSource(
    message.document,
    "document",
    "application/octet-stream",
    `telegram-document-${messageId}.bin`,
  ), "[Document]");

  const animation = message.animation;
  const animationMime = boundedString(animation?.mime_type, 255) ?? "video/mp4";
  const animationType = mediaTypeFromMime(animationMime);
  add(fileSource(
    animation,
    animationType,
    animationMime,
    `telegram-animation-${messageId}.${extensionFromMime(animationMime, animationType)}`,
  ), "[Animation]");
  add(stickerSource(message.sticker, messageId), "[Sticker]");

  return {
    text: normalizedText(message.text ?? message.caption) ?? fallbackText,
    media,
  };
}

export async function loadTelegramInboundMedia(
  sources: readonly TelegramInboundMediaSource[],
  options: {
    getFile(fileId: string): Promise<TelegramInboundFile>;
    downloadFile(
      filePath: string,
      expectedSize: number | undefined,
      maxBytes: number,
    ): Promise<(BinaryBody & { length: number }) | null>;
    skipFailures?: boolean;
    onFailure?(error: Error | string): void;
  },
): Promise<TelegramInboundMediaLoadResult> {
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
      const file = await options.getFile(source.fileId);
      const size = safeNonNegativeInteger(file.file_size) ?? source.size;
      const filePath = boundedOpaque(file.file_path, 2_048);
      if (!filePath || (size !== undefined && size > maxBytes)) {
        skipped += 1;
        continue;
      }
      const body = await options.downloadFile(filePath, size, maxBytes);
      if (!body) {
        skipped += 1;
        continue;
      }
      parts.push({
        media: {
          type: source.type,
          mimeType: source.mimeType,
          filename: source.filename,
          size: body.length,
          duration: source.duration,
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

function largestPhoto(value: readonly TelegramFile[] | undefined): { fileId: string; size?: number } | null {
  if (!value) return null;
  let largest: { fileId: string; size?: number; pixels: number } | null = null;
  for (const candidate of value) {
    const photo = candidate;
    const fileId = providerFileId(photo.file_id);
    if (!fileId) continue;
    const size = safeNonNegativeInteger(photo.file_size);
    const width = safeNonNegativeInteger(photo.width) ?? 0;
    const height = safeNonNegativeInteger(photo.height) ?? 0;
    const next = { fileId, size, pixels: width * height };
    if (
      !largest
      || (next.size ?? 0) > (largest.size ?? 0)
      || ((next.size ?? 0) === (largest.size ?? 0) && next.pixels > largest.pixels)
    ) {
      largest = next;
    }
  }
  return largest ? {
    fileId: largest.fileId,
    size: largest.size,
  } : null;
}

function fileSource(
  value: TelegramFile | undefined,
  type: AdapterMedia["type"],
  defaultMimeType: string,
  defaultFilename: string,
): TelegramInboundMediaSource | null {
  const file = value;
  const fileId = providerFileId(file?.file_id);
  if (!fileId) return null;
  const mimeType = boundedString(file?.mime_type, 255) ?? defaultMimeType;
  const filename = boundedString(file?.file_name, 255) ?? defaultFilename;
  const size = safeNonNegativeInteger(file?.file_size);
  const duration = safeNonNegativeInteger(file?.duration);
  return {
    type,
    fileId,
    mimeType,
    filename,
    size,
    duration,
  };
}

function stickerSource(value: TelegramFile | undefined, messageId: string): TelegramInboundMediaSource | null {
  const sticker = value;
  const fileId = providerFileId(sticker?.file_id);
  if (!fileId) return null;
  const isVideo = sticker?.is_video === true;
  const isAnimated = sticker?.is_animated === true;
  const mimeType = boundedString(sticker?.mime_type, 255)
    ?? (isVideo ? "video/webm" : isAnimated ? "application/x-tgsticker" : "image/webp");
  const type: AdapterMedia["type"] = isVideo ? "video" : isAnimated ? "document" : "image";
  const filename = boundedString(sticker?.file_name, 255)
    ?? `telegram-sticker-${messageId}.${extensionFromMime(mimeType, type)}`;
  const size = safeNonNegativeInteger(sticker?.file_size);
  return {
    type,
    fileId,
    mimeType,
    filename,
    size,
  };
}

function mediaTypeFromMime(mimeType: string): AdapterMedia["type"] {
  const normalized = mimeType.split(";", 1)[0]!.trim().toLowerCase();
  if (normalized.startsWith("image/")) return "image";
  if (normalized.startsWith("audio/")) return "audio";
  if (normalized.startsWith("video/")) return "video";
  return "document";
}

function extensionFromMime(mimeType: string, mediaType: AdapterMedia["type"]): string {
  const normalized = mimeType.split(";", 1)[0]!.trim().toLowerCase();
  const mapping = {
    "application/pdf": "pdf",
    "application/x-tgsticker": "tgs",
    "audio/mpeg": "mp3",
    "audio/ogg": "ogg",
    "image/gif": "gif",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "video/mp4": "mp4",
    "video/webm": "webm",
  } satisfies Record<string, string>;
  return Object.entries(mapping).find(([key]) => key === normalized)?.[1]
    ?? (mediaType === "document" ? "bin" : mediaType);
}

function normalizedText(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function providerFileId(value: string | undefined): string | null {
  return boundedOpaque(value, 1_024) ?? null;
}

function boundedString(value: string | undefined, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maxLength) : undefined;
}

function boundedOpaque(value: string | undefined, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  return normalized
    && normalized.length <= maxLength
    && ![...normalized].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
    ? normalized
    : undefined;
}

function safeNonNegativeInteger(value: number | undefined): number | undefined {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}
