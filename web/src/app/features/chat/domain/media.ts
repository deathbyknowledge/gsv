function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function chatMediaKind(media: unknown): "audio" | "document" | "image" | "video" {
  const record = asRecord(media);
  const type = asString(record?.type);
  if (type === "image" || type === "audio" || type === "video" || type === "document") {
    return type;
  }
  const mimeType = asString(record?.mimeType)?.toLowerCase() ?? "";
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("video/")) return "video";
  return "document";
}

export function chatMediaKey(media: unknown): string {
  return asString(asRecord(media)?.key) ?? "";
}

export function chatMediaMimeType(media: unknown): string {
  return asString(asRecord(media)?.mimeType) ?? "application/octet-stream";
}

export function chatMediaFilename(media: unknown): string {
  return asString(asRecord(media)?.filename) ?? "attachment";
}

export function chatMediaSize(media: unknown): number | null {
  return asNumber(asRecord(media)?.size);
}

export function chatMediaDuration(media: unknown): number | null {
  return asNumber(asRecord(media)?.duration);
}

export function chatMediaTranscription(media: unknown): string {
  return asString(asRecord(media)?.transcription) ?? "";
}

export function chatMediaDescription(media: unknown): string {
  return asString(asRecord(media)?.description) ?? "";
}

export function chatMediaSource(media: unknown, storedSource = ""): string {
  const record = asRecord(media);
  const url = asString(record?.url);
  if (url) return safeMediaSourceUrl(url, ["https:", "http:"]);
  return storedSource ? safeMediaSourceUrl(storedSource, ["blob:"]) : "";
}

export function formatChatMediaSize(size: number | null | undefined): string {
  if (!size || size <= 0) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatChatMediaDuration(duration: number | null | undefined): string {
  if (!duration || duration <= 0 || !Number.isFinite(duration)) return "";
  const totalSeconds = Math.max(1, Math.round(duration));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function safeMediaSourceUrl(value: string, allowedProtocols: string[]): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  try {
    const base = typeof window !== "undefined" ? window.location.href : "https://gsv.local/";
    const url = new URL(trimmed, base);
    return allowedProtocols.includes(url.protocol) ? trimmed : "";
  } catch {
    return "";
  }
}
