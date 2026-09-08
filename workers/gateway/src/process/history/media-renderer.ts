/** Model-facing attachment descriptions and content blocks. */

import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { processMediaPath } from "../../shared/process-media-path";
import type { StoredProcessMedia } from "../media";

export function describeStoredProcessMedia(media: StoredProcessMedia): string {
  const parts = [`Attached ${media.type}`];
  if (media.filename) {
    parts.push(`"${media.filename}"`);
  }
  parts.push(`[${media.mimeType}]`);
  if (media.size !== undefined && media.size > 0) {
    parts.push(formatSize(media.size));
  }
  if (media.duration !== undefined && media.duration > 0) {
    parts.push(`${media.duration}s`);
  }
  const base = parts.join(" ");
  const path = media.path ?? (media.key ? processMediaPath(media.key) : null);
  const location = path ? `\nPath: ${path}` : "";
  if (media.transcription && media.transcription.trim().length > 0) {
    return `${base}${location}\nTranscript: ${media.transcription.trim()}`;
  }
  if (media.description && media.description.trim().length > 0) {
    return `${base}${location}\nImage description: ${media.description.trim()}`;
  }
  if (media.url && !media.key) {
    return `${base}\nSource: remote URL`;
  }
  return `${base}${location}`;
}

export function buildFallbackMediaBlocks(media: StoredProcessMedia[]): TextContent[] {
  return media.map((item) => ({
    type: "text",
    text: describeStoredProcessMedia(item),
  }));
}

export function buildImageBlock(data: string, mimeType: string): ImageContent {
  return {
    type: "image",
    data,
    mimeType,
  };
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
