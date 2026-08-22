import type { StoredProcessMedia } from "./media";
import {
  jsonObjectSchema,
  jsonValueSchema,
  type JsonObject,
  type JsonValue,
} from "@humansandmachines/gsv/protocol";
import {
  binaryDataFromBase64,
  encodeBase64Bytes,
} from "../shared/base64";
import { z } from "zod";

const STORED_TOOL_RESULT_VERSION = 1;
const MAX_TOOL_RESULT_DEPTH = 64;
const MAX_LEGACY_TOOL_RESULT_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_LEGACY_TOOL_RESULT_IMAGES = 20;

type ToolResultValue = JsonValue;
type ToolResultRecord = JsonObject;
type ToolResultImage = ToolResultRecord & {
  type: "image";
  data: string;
  mimeType: string;
};
type UnwrappedToolResult = {
  output: ToolResultValue;
  media: StoredProcessMedia[];
};
type ExtractedToolResult = {
  output: ToolResultValue;
  images: ExtractedToolResultImage[];
};

const toolResultRecordSchema = jsonObjectSchema;
const imageContentSchema = z.object({
  type: z.literal("image"),
  data: z.string(),
  mimeType: z.string(),
}).catchall(jsonValueSchema);
const storedMediaSchema = z.object({
  type: z.enum(["image", "audio", "video", "document"]),
  mimeType: z.string(),
  key: z.string().optional(),
  path: z.string().optional(),
  url: z.string().optional(),
  filename: z.string().optional(),
  size: z.number().optional(),
  duration: z.number().optional(),
  transcription: z.string().optional(),
});
const storedToolResultSchema = z.object({
  __gsvStoredToolResult: z.literal(STORED_TOOL_RESULT_VERSION),
  output: z.json(),
  media: z.array(storedMediaSchema),
});

export type ExtractedToolResultImage = {
  bytes: Uint8Array;
  mimeType: string;
  placeholder: ToolResultRecord;
};

export type StoredToolResultEnvelope = {
  __gsvStoredToolResult: typeof STORED_TOOL_RESULT_VERSION;
  output: ToolResultValue;
  media: StoredProcessMedia[];
};

export function extractToolResultImages(
  value: ToolResultValue,
  limits: { maxImages: number; maxBytes: number },
): ExtractedToolResult {
  const images: ExtractedToolResultImage[] = [];
  let totalBytes = 0;
  const ancestors = new WeakSet<object>();

  const visit = (candidate: ToolResultValue, depth: number): ToolResultValue => {
    if (depth > MAX_TOOL_RESULT_DEPTH) {
      throw new Error("Tool result nesting exceeds the supported depth");
    }
    if (candidate === null) {
      return candidate;
    }

    if (Array.isArray(candidate)) {
      return candidate.map((item) => visit(item, depth + 1));
    }

    if (!isToolResultRecord(candidate)) {
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
      const placeholder = {
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
      const output: ToolResultRecord = {};
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
  output: ToolResultValue,
  media: StoredProcessMedia[],
): StoredToolResultEnvelope {
  return {
    __gsvStoredToolResult: STORED_TOOL_RESULT_VERSION,
    output: output ?? null,
    media,
  };
}

export function unwrapStoredToolResult(value: ToolResultValue): UnwrappedToolResult {
  const parsed = storedToolResultSchema.safeParse(value);
  if (!parsed.success) {
    return { output: value, media: [] };
  }
  return {
    output: parsed.data.output,
    media: parsed.data.media,
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
  let parsed: JsonValue;
  try {
    parsed = jsonValueSchema.parse(JSON.parse(content));
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

function isToolResultRecord(value: ToolResultValue): value is ToolResultRecord {
  return toolResultRecordSchema.safeParse(value).success;
}

function isImageContent(value: ToolResultRecord): value is ToolResultImage {
  return imageContentSchema.safeParse(value).success;
}
