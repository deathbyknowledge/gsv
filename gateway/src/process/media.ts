import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

import type { ProcMediaInput } from "@humansandmachines/gsv/protocol";
import {
  DEFAULT_AUDIO_TRANSCRIPTION_MODEL,
  DEFAULT_MAX_AUDIO_TRANSCRIPTION_BYTES,
  normalizeBase64Data,
  type AudioTranscriptionBinding,
} from "../inference/transcription";
import { transcribeAudio } from "../inference/capabilities";
import {
  DEFAULT_IMAGE_READING_MAX_TOKENS,
  DEFAULT_IMAGE_READING_INPUT_FORMAT,
  DEFAULT_IMAGE_READING_MODEL,
  DEFAULT_IMAGE_READING_PROMPT,
  DEFAULT_IMAGE_READING_TIMEOUT_MS,
  DEFAULT_MAX_IMAGE_READING_BYTES,
  readImageWithWorkersAi,
  readImageWithPiAi,
  type ImageReadingInputFormat,
  type ImageReadingBinding,
} from "../inference/image-reading";
import { isWorkersAiProvider } from "../inference/workers-ai";

export {
  DEFAULT_AUDIO_TRANSCRIPTION_MODEL,
  DEFAULT_MAX_AUDIO_TRANSCRIPTION_BYTES,
  type AudioTranscriptionBinding,
} from "../inference/transcription";

export {
  DEFAULT_IMAGE_READING_MODEL,
  DEFAULT_IMAGE_READING_PROMPT,
  DEFAULT_MAX_IMAGE_READING_BYTES,
  type ImageReadingInputFormat,
  type ImageReadingBinding,
} from "../inference/image-reading";

export type StoredProcessMedia = {
  type: ProcMediaInput["type"];
  mimeType: string;
  key?: string;
  url?: string;
  filename?: string;
  size?: number;
  duration?: number;
  transcription?: string;
  description?: string;
};

export type StoreIncomingProcessMediaOptions = {
  ai?: AudioTranscriptionBinding & ImageReadingBinding;
  audioTranscriptionProvider?: string;
  audioTranscriptionModel?: string;
  audioTranscriptionApiKey?: string;
  maxTranscriptionBytes?: number;
  imageReadingProvider?: string;
  imageReadingModel?: string;
  imageReadingApiKey?: string;
  imageReadingPrompt?: string;
  imageReadingInputFormat?: ImageReadingInputFormat | string;
  imageReadingMaxBytes?: number;
  imageReadingMaxTokens?: number;
  imageReadingTimeoutMs?: number;
};


export function processMediaPrefix(uid: number, pid: string): string {
  return `var/media/${uid}/${pid}/`;
}

export async function storeIncomingProcessMedia(
  bucket: R2Bucket,
  uid: number,
  pid: string,
  media: ProcMediaInput[] | undefined,
  options: StoreIncomingProcessMediaOptions = {},
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

    let bytes: Uint8Array | null = null;
    let base64: string | null = null;

    if (typeof item.data === "string" && item.data.length > 0) {
      base64 = normalizeBase64Data(item.data);
      bytes = base64ToUint8Array(base64);
      const key = `${prefix}${crypto.randomUUID()}${inferExtension(item.filename, item.mimeType)}`;
      await bucket.put(key, bytes, {
        httpMetadata: { contentType: item.mimeType },
      });
      next.key = key;
      next.size = bytes.byteLength;
    } else if (typeof item.url === "string" && item.url.length > 0) {
      next.url = item.url;
    }

    if (shouldTranscribeAudio(item, next, bytes, options)) {
      const result = await transcribeIncomingAudio(options.ai, base64!, {
        provider: options.audioTranscriptionProvider,
        apiKey: options.audioTranscriptionApiKey,
        model: options.audioTranscriptionModel,
        mimeType: item.mimeType,
        filename: item.filename,
      });
      if (result) {
        next.transcription = result.text;
        if (next.duration === undefined && typeof result.duration === "number") {
          next.duration = result.duration;
        }
      }
    }

    if (shouldReadImage(item, next, bytes, options)) {
      const result = await describeIncomingImage(options.ai, base64!, item.mimeType, {
        provider: options.imageReadingProvider,
        model: options.imageReadingModel,
        apiKey: options.imageReadingApiKey,
        prompt: options.imageReadingPrompt,
        inputFormat: options.imageReadingInputFormat,
        maxTokens: options.imageReadingMaxTokens,
        timeoutMs: options.imageReadingTimeoutMs,
      });
      if (result) {
        next.description = result.text;
      }
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
    if (typeof candidate.description === "string" && candidate.description.length > 0) next.description = candidate.description;
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
  if (media.description && media.description.trim().length > 0) {
    return `${base}\nImage description: ${media.description.trim()}`;
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

function shouldTranscribeAudio(
  input: ProcMediaInput,
  stored: StoredProcessMedia,
  bytes: Uint8Array | null,
  options: StoreIncomingProcessMediaOptions,
): boolean {
  if (input.type !== "audio") {
    return false;
  }
  if (typeof stored.transcription === "string" && stored.transcription.trim().length > 0) {
    return false;
  }
  const provider = options.audioTranscriptionProvider?.trim() || "workers-ai";
  if (isWorkersAiProvider(provider) && (!options.ai || typeof options.ai.run !== "function")) {
    return false;
  }
  if (!bytes || bytes.byteLength === 0) {
    return false;
  }
  const maxBytes = options.maxTranscriptionBytes ?? DEFAULT_MAX_AUDIO_TRANSCRIPTION_BYTES;
  return bytes.byteLength <= maxBytes;
}

function shouldReadImage(
  input: ProcMediaInput,
  stored: StoredProcessMedia,
  bytes: Uint8Array | null,
  options: StoreIncomingProcessMediaOptions,
): boolean {
  if (input.type !== "image") {
    return false;
  }
  if (typeof stored.description === "string" && stored.description.trim().length > 0) {
    return false;
  }
  const provider = options.imageReadingProvider?.trim() || "workers-ai";
  if (isWorkersAiProvider(provider) && (!options.ai || typeof options.ai.run !== "function")) {
    return false;
  }
  if (!bytes || bytes.byteLength === 0) {
    return false;
  }
  const model = options.imageReadingModel ?? DEFAULT_IMAGE_READING_MODEL;
  if (!model.trim()) {
    return false;
  }
  const maxBytes = options.imageReadingMaxBytes ?? DEFAULT_MAX_IMAGE_READING_BYTES;
  return bytes.byteLength <= maxBytes;
}

async function transcribeIncomingAudio(
  ai: AudioTranscriptionBinding | undefined,
  base64: string,
  options: {
    provider?: string;
    apiKey?: string;
    model?: string;
    mimeType?: string;
    filename?: string;
  },
): Promise<{ text: string; duration?: number } | null> {
  try {
    return await transcribeAudio({ workersAi: ai }, {
      data: base64,
      provider: options.provider,
      apiKey: options.apiKey,
      model: options.model,
      mimeType: options.mimeType,
      filename: options.filename,
      mode: "transcribe",
      vadFilter: true,
      conditionOnPreviousText: false,
    });
  } catch (error) {
    console.warn("[ProcessMedia] audio transcription failed:", error);
    return null;
  }
}

async function describeIncomingImage(
  ai: ImageReadingBinding | undefined,
  base64: string,
  mimeType: string,
  options: {
    provider?: string;
    model?: string;
    apiKey?: string;
    prompt?: string;
    inputFormat?: ImageReadingInputFormat | string;
    maxTokens?: number;
    timeoutMs?: number;
  },
): Promise<{ text: string } | null> {
  const provider = options.provider?.trim() || "workers-ai";

  try {
    if (!isWorkersAiProvider(provider)) {
      return await readImageWithPiAi({
        provider,
        apiKey: options.apiKey,
        data: base64,
        mimeType,
        model: options.model,
        prompt: options.prompt || DEFAULT_IMAGE_READING_PROMPT,
        maxTokens: options.maxTokens ?? DEFAULT_IMAGE_READING_MAX_TOKENS,
        timeoutMs: options.timeoutMs ?? DEFAULT_IMAGE_READING_TIMEOUT_MS,
      });
    }

    return await readImageWithWorkersAi(ai, {
      data: base64,
      mimeType,
      model: options.model,
      prompt: options.prompt || DEFAULT_IMAGE_READING_PROMPT,
      inputFormat: options.inputFormat || DEFAULT_IMAGE_READING_INPUT_FORMAT,
      maxTokens: options.maxTokens ?? DEFAULT_IMAGE_READING_MAX_TOKENS,
      timeoutMs: options.timeoutMs ?? DEFAULT_IMAGE_READING_TIMEOUT_MS,
    });
  } catch (error) {
    console.warn("[ProcessMedia] image reading failed:", error);
    return null;
  }
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
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
