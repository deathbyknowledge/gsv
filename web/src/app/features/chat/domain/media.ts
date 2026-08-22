import {
  resourceBlockSchema,
  type FileResourceReference,
} from "@humansandmachines/gsv/protocol";
import { z } from "zod";

const mediaKindSchema = z.enum(["audio", "document", "image", "video"]);
const optionalMediaStringSchema = z.string().trim().min(1).optional().catch(undefined);
const optionalMediaNumberSchema = z.number().finite().optional().catch(undefined);

const chatMediaObjectSchema = z.object({
  type: mediaKindSchema.optional().catch(undefined),
  mimeType: optionalMediaStringSchema,
  key: optionalMediaStringSchema,
  conversationId: optionalMediaStringSchema,
  url: optionalMediaStringSchema,
  filename: optionalMediaStringSchema,
  size: optionalMediaNumberSchema,
  duration: optionalMediaNumberSchema,
  transcription: optionalMediaStringSchema,
  description: optionalMediaStringSchema,
  resource: z.undefined().optional(),
});

const chatResourceMediaSchema = resourceBlockSchema.transform(({ ref }) => ({
  type: mediaKindFromContentType(ref.contentType),
  mimeType: ref.contentType,
  key: undefined,
  conversationId: undefined,
  url: undefined,
  filename: resourceFilename(ref.path),
  size: ref.size,
  duration: undefined,
  transcription: undefined,
  description: undefined,
  resource: ref,
}));

const chatMediaWireSchema = z.unknown().pipe(z.union([
  chatResourceMediaSchema,
  chatMediaObjectSchema,
]));

export type ChatMediaDescriptor = z.output<typeof chatMediaWireSchema>;
type ChatMediaWireValue = z.input<typeof chatMediaWireSchema>;

export function parseChatMedia(value: ChatMediaWireValue): ChatMediaDescriptor {
  return chatMediaWireSchema.parse(value);
}

function parsedMedia(media: ChatMediaWireValue): ChatMediaDescriptor {
  return parseChatMedia(media);
}

export function chatMediaKind(media: ChatMediaWireValue): "audio" | "document" | "image" | "video" {
  const parsed = parsedMedia(media);
  if (parsed.type) return parsed.type;
  const mimeType = parsed.mimeType?.toLowerCase() ?? "";
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("video/")) return "video";
  return "document";
}

export function chatMediaKey(media: ChatMediaWireValue): string {
  return parsedMedia(media).key ?? "";
}

export function chatMediaConversationId(media: ChatMediaWireValue): string {
  return parsedMedia(media).conversationId ?? "";
}

export function chatMediaMimeType(media: ChatMediaWireValue): string {
  return parsedMedia(media).mimeType ?? "application/octet-stream";
}

export function chatMediaFilename(media: ChatMediaWireValue): string {
  return parsedMedia(media).filename ?? "attachment";
}

export function chatMediaSize(media: ChatMediaWireValue): number | null {
  return parsedMedia(media).size ?? null;
}

export function chatMediaDuration(media: ChatMediaWireValue): number | null {
  return parsedMedia(media).duration ?? null;
}

export function chatMediaTranscription(media: ChatMediaWireValue): string {
  return parsedMedia(media).transcription ?? "";
}

export function chatMediaDescription(media: ChatMediaWireValue): string {
  return parsedMedia(media).description ?? "";
}

export function chatMediaResource(media: ChatMediaWireValue): FileResourceReference | null {
  return parsedMedia(media).resource ?? null;
}

export function chatMediaSource(media: ChatMediaWireValue, storedSource = ""): string {
  const parsed = parsedMedia(media);
  if (parsed.url) return safeMediaSourceUrl(parsed.url, ["https:", "http:"]);
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
    const base = globalThis.window?.location.href ?? "https://gsv.local/";
    const url = new URL(trimmed, base);
    return allowedProtocols.includes(url.protocol) ? trimmed : "";
  } catch {
    return "";
  }
}

function mediaKindFromContentType(contentType: string): "audio" | "document" | "image" | "video" {
  const normalized = contentType.toLowerCase();
  if (normalized.startsWith("image/")) return "image";
  if (normalized.startsWith("audio/")) return "audio";
  if (normalized.startsWith("video/")) return "video";
  return "document";
}

function resourceFilename(path: string): string {
  const filename = path.split("/").filter(Boolean).at(-1)?.trim();
  return filename || "resource";
}
