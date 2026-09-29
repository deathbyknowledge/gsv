import type { z } from "zod";
import {
bundleAdapterMedia,
cancelResponseBody,
responseBodyToBinaryBody,
SAFE_MATERIALIZED_MEDIA_PART_BYTES,
SAFE_MATERIALIZED_MEDIA_TOTAL_BYTES,
} from "../../shared/src/media-body";
import type {
AdapterMediaBundle,
AdapterMediaPart,
} from "../../shared/src/media-body";
import type { AdapterMedia } from "../../shared/src/types";
import { type DiscordMessagePayload, discordAttachmentPayloadSchema } from "./discord-events";

const MAX_MEDIA_BODY_BYTES = SAFE_MATERIALIZED_MEDIA_PART_BYTES;
const MAX_MEDIA_TOTAL_BODY_BYTES = SAFE_MATERIALIZED_MEDIA_TOTAL_BYTES;

type DiscordAttachment = {
id: string;
filename: string;
size?: number;
url?: string;
proxyUrl?: string;
contentType?: string;
duration?: number;
};

export async function extractDiscordMedia(
  data: DiscordMessagePayload,
  providerFetch: typeof fetch = fetch,
): Promise<AdapterMediaBundle> {
  if (!Array.isArray(data.attachments)) {
    return { media: [] };
  }

  const media: AdapterMediaPart[] = [];
  let bodyBytes = 0;
  for (const rawAttachment of data.attachments.slice(0, 10)) {
    const attachment = parseAttachment(rawAttachment);
    if (!attachment) continue;

    const converted = await attachmentToMedia(
      attachment,
      MAX_MEDIA_TOTAL_BODY_BYTES - bodyBytes,
      providerFetch,
    );
    if (converted) {
      media.push(converted);
      bodyBytes += converted.body?.length ?? 0;
    }
  }

  return await bundleAdapterMedia(media);
}

function parseAttachment(value: z.infer<typeof discordAttachmentPayloadSchema>): DiscordAttachment {
  const { id, filename, url, proxy_url: proxyUrl } = value;
  return {
    id,
    filename,
    size: value.size,
    url,
    proxyUrl,
    contentType: value.content_type,
    duration: value.duration_secs,
  };
}

async function attachmentToMedia(
  attachment: DiscordAttachment,
  remainingBodyBytes: number,
  providerFetch: typeof fetch,
): Promise<AdapterMediaPart | null> {
  const mimeType =
    attachment.contentType || inferMimeTypeFromFilename(attachment.filename);
  const type = inferMediaTypeFromMime(mimeType);
  const url = attachment.url || attachment.proxyUrl;

  const base: Omit<AdapterMedia, "body"> = {
    type,
    mimeType,
    filename: attachment.filename,
    size: attachment.size,
    duration: attachment.duration,
  };

  if (!url || remainingBodyBytes <= 0) {
    return null;
  }

  const maxBytes = Math.min(MAX_MEDIA_BODY_BYTES, remainingBodyBytes);
  if (
    attachment.size !== undefined
    && (!Number.isSafeInteger(attachment.size) || attachment.size < 0)
  ) {
    console.log(
      `[DiscordGateway] Attachment ${attachment.id} has an invalid size`,
    );
    return null;
  }
  if (attachment.size !== undefined && attachment.size > maxBytes) {
    console.log(
      `[DiscordGateway] Attachment ${attachment.id} exceeds transfer limit (${attachment.size} bytes)`,
    );
    return null;
  }

  try {
    const response = await providerFetch(url);
    if (!response.ok) {
      await cancelResponseBody(response, "Discord attachment download failed");
      console.warn(
        `[DiscordGateway] Failed to download attachment ${attachment.id}: HTTP ${response.status}`,
      );
      return null;
    }

    const body = await responseBodyToBinaryBody(response, {
      maxBytes,
      expectedBytes: attachment.size,
      label: "Discord attachment",
    });
    return {
      media: { ...base, size: body.length },
      body,
    };
  } catch (e) {
    console.warn(
      `[DiscordGateway] Error downloading attachment ${attachment.id}: ${e}`,
    );
    return null;
  }
}

function inferMediaTypeFromMime(mimeType: string): AdapterMedia["type"] {
  const normalized = mimeType.split(";")[0].trim().toLowerCase();
  if (normalized.startsWith("image/")) return "image";
  if (normalized.startsWith("audio/")) return "audio";
  if (normalized.startsWith("video/")) return "video";
  return "document";
}

function inferMimeTypeFromFilename(filename: string): string {
  const extension = filename.split(".").pop()?.toLowerCase() || "";
  const map = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    mp3: "audio/mpeg",
    ogg: "audio/ogg",
    opus: "audio/opus",
    wav: "audio/wav",
    m4a: "audio/mp4",
    webm: "audio/webm",
    mp4: "video/mp4",
    mov: "video/quicktime",
    pdf: "application/pdf",
  } satisfies Record<string, string>;
  return Object.entries(map).find(([key]) => key === extension)?.[1] || "application/octet-stream";
}

