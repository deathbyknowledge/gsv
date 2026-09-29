import {
  bundleAdapterMedia,
  cancelBinaryBody,
  SAFE_MATERIALIZED_MEDIA_PART_BYTES,
  SAFE_MATERIALIZED_MEDIA_TOTAL_BYTES,
  type AdapterMediaBundle,
  type AdapterMediaPart,
} from "../../shared/src/media-body";
import type { AdapterMedia } from "./types";
import type { SlackDownloadedFile } from "./slack-api";

export const MAX_SLACK_MEDIA_ITEMS = 20;

export type SlackInboundMediaSource = {
  fileId: string;
  size?: number;
};

export type SlackInboundMediaLoadResult = AdapterMediaBundle & {
  skipped: number;
};

export async function loadSlackInboundMedia(
  sources: readonly SlackInboundMediaSource[],
  loadFile: (
    fileId: string,
    maxBytes: number,
  ) => Promise<SlackDownloadedFile | null>,
): Promise<SlackInboundMediaLoadResult> {
  const parts: AdapterMediaPart[] = [];
  const accepted = sources.slice(0, MAX_SLACK_MEDIA_ITEMS);
  let skipped = sources.length - accepted.length;
  let bodyBytes = 0;

  try {
    for (const source of accepted) {
      const remaining = SAFE_MATERIALIZED_MEDIA_TOTAL_BYTES - bodyBytes;
      const maxBytes = Math.min(SAFE_MATERIALIZED_MEDIA_PART_BYTES, remaining);
      if (maxBytes <= 0 || (source.size !== undefined && source.size > maxBytes)) {
        skipped += 1;
        continue;
      }
      const file = await loadFile(source.fileId, maxBytes);
      if (!file) {
        skipped += 1;
        continue;
      }
      if (file.body.length > maxBytes) {
        await cancelBinaryBody(file.body, "Slack file exceeds the GSV media limit");
        skipped += 1;
        continue;
      }
      parts.push({
        media: {
          type: mediaTypeFromMime(file.mimeType),
          mimeType: file.mimeType,
          filename: file.filename,
          size: file.body.length,
        },
        body: file.body,
      });
      bodyBytes += file.body.length;
    }
    return { ...await bundleAdapterMedia(parts), skipped };
  } catch (error) {
    await Promise.all(parts.map((part) => cancelBinaryBody(part.body, error)));
    throw error;
  }
}

export function appendSlackMediaNotice(text: string, skipped: number): string {
  if (skipped <= 0) return text;
  const noun = skipped === 1 ? "attachment" : "attachments";
  return `${text}\n\n[${skipped} Slack ${noun} could not be imported.]`;
}

export function mediaTypeFromMime(mimeType: string): AdapterMedia["type"] {
  const normalized = mimeType.split(";", 1)[0]!.trim().toLowerCase();
  if (normalized.startsWith("image/")) return "image";
  if (normalized.startsWith("audio/")) return "audio";
  if (normalized.startsWith("video/")) return "video";
  return "document";
}

