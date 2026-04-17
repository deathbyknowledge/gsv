import type { ImageContent, TextContent } from "@mariozechner/pi-ai";

import type { ProcMediaInput } from "@gsv/protocol/syscalls/proc";

export type StoredProcessMedia = {
  type: ProcMediaInput["type"];
  mimeType: string;
  key?: string;
  url?: string;
  filename?: string;
  size?: number;
  duration?: number;
  transcription?: string;
};

export function processMediaPrefix(uid: number, pid: string): string {
  return `var/media/${uid}/${pid}/`;
}

export async function storeIncomingProcessMedia(
  bucket: R2Bucket,
  uid: number,
  pid: string,
  media: ProcMediaInput[] | undefined,
): Promise<string | null> {
  if (!media || media.length === 0) {
    return null;
  }

  const prefix = processMediaPrefix(uid, pid);
  const stored: StoredProcessMedia[] = [];

  for (const item of media) {
    const next: StoredProcessMedia = {
      type: item.type,
      mimeType: item.mimeType,
      filename: item.filename,
      size: item.size,
      duration: item.duration,
      transcription: item.transcription,
    };

    if (typeof item.data === "string" && item.data.length > 0) {
      const bytes = base64ToUint8Array(item.data);
      const key = `${prefix}${crypto.randomUUID()}${inferExtension(item.filename, item.mimeType)}`;
      await bucket.put(key, bytes, {
        httpMetadata: { contentType: item.mimeType },
      });
      next.key = key;
      next.size = bytes.byteLength;
    } else if (typeof item.url === "string" && item.url.length > 0) {
      next.url = item.url;
    }

    stored.push(next);
  }

  return stringifyStoredProcessMedia(stored);
}

export async function deleteProcessMedia(
  bucket: R2Bucket,
  uid: number,
  pid: string,
): Promise<void> {
  const prefix = processMediaPrefix(uid, pid);
  let cursor: string | undefined;

  for (;;) {
    const listing = await bucket.list({
      prefix,
      cursor,
      limit: 1000,
    });
    if (listing.objects.length > 0) {
      await bucket.delete(listing.objects.map((object) => object.key));
    }
    if (!listing.truncated) {
      break;
    }
    cursor = listing.cursor;
  }
}

export function parseStoredProcessMedia(raw: string | null): StoredProcessMedia[] {
  if (!raw) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed.flatMap((entry) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }
    const candidate = entry as Record<string, unknown>;
    const type = candidate.type;
    const mimeType = candidate.mimeType;
    if (
      (type !== "image" && type !== "audio" && type !== "video" && type !== "document")
      || typeof mimeType !== "string"
    ) {
      return [];
    }

    const next: StoredProcessMedia = {
      type,
      mimeType,
    };
    if (typeof candidate.key === "string" && candidate.key.length > 0) next.key = candidate.key;
    if (typeof candidate.url === "string" && candidate.url.length > 0) next.url = candidate.url;
    if (typeof candidate.filename === "string" && candidate.filename.length > 0) next.filename = candidate.filename;
    if (typeof candidate.size === "number" && Number.isFinite(candidate.size)) next.size = candidate.size;
    if (typeof candidate.duration === "number" && Number.isFinite(candidate.duration)) next.duration = candidate.duration;
    if (typeof candidate.transcription === "string" && candidate.transcription.length > 0) next.transcription = candidate.transcription;
    return [next];
  });
}

export function stringifyStoredProcessMedia(media: StoredProcessMedia[]): string | null {
  if (media.length === 0) {
    return null;
  }
  return JSON.stringify(media);
}

export function describeStoredProcessMedia(media: StoredProcessMedia): string {
  const parts = [`Attached ${media.type}`];
  if (media.filename) {
    parts.push(`"${media.filename}"`);
  }
  parts.push(`[${media.mimeType}]`);
  if (typeof media.size === "number" && Number.isFinite(media.size) && media.size > 0) {
    parts.push(formatSize(media.size));
  }
  if (typeof media.duration === "number" && Number.isFinite(media.duration) && media.duration > 0) {
    parts.push(`${media.duration}s`);
  }
  const base = parts.join(" ");
  if (media.transcription && media.transcription.trim().length > 0) {
    return `${base}\nTranscript: ${media.transcription.trim()}`;
  }
  if (media.url && !media.key) {
    return `${base}\nSource: remote URL`;
  }
  return base;
}

export function buildFallbackMediaBlocks(
  media: StoredProcessMedia[],
): TextContent[] {
  return media.map((item) => ({
    type: "text",
    text: describeStoredProcessMedia(item),
  }));
}

export function buildImageBlock(
  data: string,
  mimeType: string,
): ImageContent {
  return {
    type: "image",
    data,
    mimeType,
  };
}

function base64ToUint8Array(base64: string): Uint8Array {
  const normalized = base64.includes(",")
    ? base64.slice(base64.indexOf(",") + 1)
    : base64;
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function inferExtension(filename: string | undefined, mimeType: string): string {
  const fileMatch = filename?.match(/(\.[a-z0-9]+)$/i);
  if (fileMatch) {
    return fileMatch[1].toLowerCase();
  }

  switch (mimeType.split(";")[0].trim().toLowerCase()) {
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/webp":
      return ".webp";
    case "image/gif":
      return ".gif";
    case "audio/mpeg":
      return ".mp3";
    case "audio/ogg":
      return ".ogg";
    case "audio/wav":
      return ".wav";
    case "video/mp4":
      return ".mp4";
    case "application/pdf":
      return ".pdf";
    default:
      return "";
  }
}

function formatSize(size: number): string {
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
