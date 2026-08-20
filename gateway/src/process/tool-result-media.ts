import type { StoredProcessMedia } from "./media";
import {
  binaryDataFromBase64,
  encodeBase64Bytes,
} from "../shared/base64";

const STORED_TOOL_RESULT_VERSION = 1;
const MAX_TOOL_RESULT_DEPTH = 64;
const MAX_LEGACY_TOOL_RESULT_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_LEGACY_TOOL_RESULT_IMAGES = 20;

export type ExtractedToolResultImage = {
  bytes: Uint8Array;
  mimeType: string;
  placeholder: Record<string, unknown>;
};

export type StoredToolResultEnvelope = {
  __gsvStoredToolResult: typeof STORED_TOOL_RESULT_VERSION;
  output: unknown;
  media: StoredProcessMedia[];
};

export function extractToolResultImages(
  value: unknown,
  limits: { maxImages: number; maxBytes: number },
): { output: unknown; images: ExtractedToolResultImage[] } {
  const images: ExtractedToolResultImage[] = [];
  let totalBytes = 0;
  const ancestors = new WeakSet<object>();

  const visit = (candidate: unknown, depth: number): unknown => {
    if (depth > MAX_TOOL_RESULT_DEPTH) {
      throw new Error("Tool result nesting exceeds the supported depth");
    }
    if (!candidate || typeof candidate !== "object") {
      return candidate;
    }

    if (isImageContent(candidate)) {
      if (images.length >= limits.maxImages) {
        throw new Error(`Tool result contains more than ${limits.maxImages} images`);
      }
      let binary: ReturnType<typeof binaryDataFromBase64>;
      try {
        binary = binaryDataFromBase64(candidate.data, candidate.mimeType);
      } catch {
        throw new Error("Tool result image data is not valid base64");
      }
      if (!binary || !binary.mimeType.toLowerCase().startsWith("image/")) {
        throw new Error("Tool result image data is empty or has an invalid MIME type");
      }
      totalBytes += binary.bytes.byteLength;
      if (binary.bytes.byteLength > limits.maxBytes || totalBytes > limits.maxBytes) {
        throw new Error(`Tool result images exceed the ${limits.maxBytes}-byte limit`);
      }

      const { data: _data, ...metadata } = candidate;
      const placeholder: Record<string, unknown> = {
        ...metadata,
        type: "image",
        mimeType: binary.mimeType,
      };
      images.push({
        bytes: binary.bytes,
        mimeType: binary.mimeType,
        placeholder,
      });
      return placeholder;
    }

    if (ancestors.has(candidate)) {
      throw new Error("Tool result cannot contain circular data");
    }
    ancestors.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        return candidate.map((item) => visit(item, depth + 1));
      }
      const output: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(candidate)) {
        output[key] = visit(item, depth + 1);
      }
      return output;
    } finally {
      ancestors.delete(candidate);
    }
  };

  return {
    output: visit(value ?? null, 0),
    images,
  };
}

export function wrapStoredToolResult(
  output: unknown,
  media: StoredProcessMedia[],
): StoredToolResultEnvelope {
  return {
    __gsvStoredToolResult: STORED_TOOL_RESULT_VERSION,
    output: output ?? null,
    media,
  };
}

export function unwrapStoredToolResult(value: unknown): {
  output: unknown;
  media: unknown[];
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { output: value, media: [] };
  }
  const record = value as Record<string, unknown>;
  if (
    record.__gsvStoredToolResult !== STORED_TOOL_RESULT_VERSION
    || !("output" in record)
    || !Array.isArray(record.media)
  ) {
    return { output: value, media: [] };
  }
  return {
    output: record.output,
    media: record.media,
  };
}

/**
 * Histories written before tool-result media externalization contain image
 * blocks inside a JSON string. Keep that explicit upgrade path visual while
 * ensuring the base64 is no longer presented to the provider as text.
 */
export function materializeLegacyToolResultImages(
  content: string,
): Array<
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }

  let extracted: ReturnType<typeof extractToolResultImages>;
  try {
    extracted = extractToolResultImages(parsed, {
      maxImages: MAX_LEGACY_TOOL_RESULT_IMAGES,
      maxBytes: MAX_LEGACY_TOOL_RESULT_IMAGE_BYTES,
    });
  } catch {
    return null;
  }
  if (extracted.images.length === 0) {
    return null;
  }

  return [
    { type: "text", text: JSON.stringify(extracted.output) },
    ...extracted.images.map((image) => ({
      type: "image" as const,
      data: encodeBase64Bytes(image.bytes),
      mimeType: image.mimeType,
    })),
  ];
}

function isImageContent(
  value: object,
): value is { type: "image"; data: string; mimeType: string; [key: string]: unknown } {
  const candidate = value as Record<string, unknown>;
  return candidate.type === "image"
    && typeof candidate.data === "string"
    && typeof candidate.mimeType === "string";
}
