import { asRecord, asString } from "../view-helpers";

export function isAudioMedia(media: unknown): boolean {
  return mediaKind(media) === "audio";
}

export function mediaKind(media: unknown): string {
  const record = asRecord(media);
  const type = asString(record?.type);
  const mimeType = asString(record?.mimeType);
  if (type === "image" || type === "audio" || type === "video" || type === "document") {
    return type;
  }
  const normalizedMimeType = mimeType?.toLowerCase() || "";
  if (normalizedMimeType.startsWith("image/")) return "image";
  if (normalizedMimeType.startsWith("audio/")) return "audio";
  if (normalizedMimeType.startsWith("video/")) return "video";
  return "document";
}

export function mediaSourceFor(media: unknown, sources: Record<string, string>): string | null {
  const record = asRecord(media);
  const previewUrl = asString(record?.previewUrl);
  if (previewUrl) return safeMediaSourceUrl(previewUrl, ["blob:", "data:", "https:", "http:"]);
  const url = asString(record?.url);
  if (url) return safeMediaSourceUrl(url, ["https:", "http:"]);
  const data = asString(record?.data);
  if (data) {
    const dataUrl = data.startsWith("data:")
      ? data
      : `data:${asString(record?.mimeType) || "application/octet-stream"};base64,${data}`;
    return safeMediaSourceUrl(dataUrl, ["data:"]);
  }
  const key = mediaSourceKey(media);
  return key ? sources[key] ?? null : null;
}

export function safeMediaSourceUrl(value: string, allowedProtocols: string[]): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const base = typeof window !== "undefined" ? window.location.href : "https://gsv.local/";
    const url = new URL(trimmed, base);
    return allowedProtocols.includes(url.protocol) ? trimmed : null;
  } catch {
    return null;
  }
}

export function mediaSourceKey(media: unknown): string | null {
  const record = asRecord(media);
  return asString(record?.key);
}

export function mediaSourceErrorFor(media: unknown, errors: Record<string, string>): string {
  const key = mediaSourceKey(media);
  return key ? errors[key] || "" : "";
}

export function mediaTranscription(media: unknown): string {
  const record = asRecord(media);
  return asString(record?.transcription)?.trim() || "";
}

export function mediaFilename(media: unknown): string | null {
  const record = asRecord(media);
  return asString(record?.filename);
}

export function mediaMimeType(media: unknown): string | null {
  const record = asRecord(media);
  return asString(record?.mimeType);
}
