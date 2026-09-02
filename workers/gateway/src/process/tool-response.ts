import {
  bodyToBytes, bodyToText, fileResourceReferenceSchema, jsonValueSchema, type JsonValue,
} from "@humansandmachines/gsv/protocol";
import type { FrameBody, ResponseOkFrame } from "../protocol/frames";
import { formatSize } from "../fs";
import { encodeBase64Bytes } from "../shared/base64";
import { z } from "zod";

const MAX_TOOL_IMAGE_BYTES = 25 * 1024 * 1024;

const toolResponseRecordSchema = z
  .object({
    ok: z.boolean().optional(),
    files: z.array(z.json()).optional(),
    directories: z.array(z.json()).optional(),
    kind: z.enum(["text", "image"]).optional(),
    content: z.json().optional(),
    contentType: z.string().optional(),
    path: z.string().optional(),
    size: z.number().optional(),
    lines: z.number().optional(),
    truncated: z.boolean().optional(),
    nextOffset: z.number().int().nonnegative().optional(),
    resource: fileResourceReferenceSchema.optional(),
  })
  .catchall(z.json());

const textToolResponseSchema = toolResponseRecordSchema.extend({
  kind: z.literal("text"),
  content: z.string(),
});

const toolRequestSchema = z
  .object({
    offset: z.number().optional(),
  })
  .catchall(z.json());

type ToolResponseRecord = z.infer<typeof toolResponseRecordSchema>;
type ToolResponseInput = ResponseOkFrame["data"] | null;
type ToolResponseMaterializationOptions = {
  maxTextBytes?: number;
};

export async function materializeToolResponse(
  call: string,
  data: ToolResponseInput | null,
  body?: FrameBody,
  signal?: AbortSignal,
  options?: ToolResponseMaterializationOptions,
): Promise<JsonValue> {
  const record = parseToolResponseRecord(data);
  if (call === "net.fetch") {
    return materializeNetworkResponse(record, body, signal);
  }
  if (call === "fs.read") {
    return materializeFileReadResponse(record, data, body, signal, options);
  }
  if (!body) return jsonValueSchema.parse(data);
  return rejectUnexpectedResponseBody(call, body);
}

async function materializeNetworkResponse(
  record: ToolResponseRecord | null,
  body: FrameBody | undefined,
  signal: AbortSignal | undefined,
): Promise<JsonValue> {
  const bytes = body ? await bodyToBytes(body, Infinity, signal) : new Uint8Array();
  const text = decodeUtf8(bytes);
  const result: ToolResponseRecord = {
    ...record,
    bodyBase64: encodeBase64Bytes(bytes),
    bodyBytes: bytes.byteLength,
  };
  if (text !== null) result.bodyText = text;
  return result;
}

async function materializeFileReadResponse(
  record: ToolResponseRecord | null,
  data: ToolResponseInput | null,
  body: FrameBody | undefined,
  signal: AbortSignal | undefined,
  options: ToolResponseMaterializationOptions | undefined,
): Promise<JsonValue> {
  if (record?.ok !== true) {
    if (!body) return jsonValueSchema.parse(data);
    return rejectUnexpectedResponseBody("fs.read", body);
  }
  if (!body) {
    if (record.kind === "image" && record.resource) {
      return storedImageReadResponse(record);
    }
    if ("files" in record || "directories" in record) {
      return jsonValueSchema.parse(data);
    }
    throw new Error("fs.read file response did not include a body");
  }
  if (record.kind === "text") {
    return {
      ...record,
      content: await bodyToText(body, options?.maxTextBytes ?? Infinity, signal),
    };
  }
  if (record.kind === "image") return inlineImageReadResponse(record, body, signal);
  return rejectUnexpectedResponseBody("fs.read", body);
}

function storedImageReadResponse(record: ToolResponseRecord): JsonValue {
  const resource = fileResourceReferenceSchema.parse(record.resource);
  const path = record.path ?? resource.path;
  const mimeType = record.contentType ?? resource.contentType;
  const size = record.size ?? resource.size;
  return {
    ...record,
    content: [
      { type: "text", text: `Read image ${path} [${mimeType}, ${formatSize(size)}]` },
      { type: "resource", ref: resource },
    ],
  };
}

async function inlineImageReadResponse(
  record: ToolResponseRecord,
  body: FrameBody,
  signal: AbortSignal | undefined,
): Promise<JsonValue> {
  const bytes = await bodyToBytes(body, MAX_TOOL_IMAGE_BYTES, signal);
  const mimeType = record.contentType ?? "application/octet-stream";
  const path = record.path ?? "image";
  const size = record.size ?? bytes.byteLength;
  return {
    ...record,
    content: [
      { type: "text", text: `Read image ${path} [${mimeType}, ${formatSize(size)}]` },
      { type: "image", data: encodeBase64Bytes(bytes), mimeType },
    ],
  };
}

async function rejectUnexpectedResponseBody(call: string, body: FrameBody): Promise<never> {
  await body.stream.cancel().catch(() => {});
  throw new Error(`Unexpected response body for ${call}`);
}

export function formatAgentToolResponse(
  call: string,
  args: JsonValue,
  result: JsonValue,
): JsonValue {
  const record = textToolResponseSchema.safeParse(result);
  if (call !== "fs.read" || !record.success) {
    return result;
  }

  const request = parseToolRequest(args);
  const offset = request?.offset ?? 0;
  const lines = record.data.lines === 0 ? [] : record.data.content.split("\n");
  const numbered = lines
    .map((line, index) => `${String(offset + index + 1).padStart(6)}\t${line}`)
    .join("\n");
  const truncationNotice = record.data.truncated
    ? record.data.nextOffset === undefined
      ? "[Read truncated inside a line. Use Shell for byte-range inspection.]"
      : `[Read truncated. Continue with Read using offset ${record.data.nextOffset}.]`
    : "";
  return {
    ...record.data,
    content: [numbered, truncationNotice].filter(Boolean).join("\n\n"),
  };
}

function parseToolResponseRecord(value: ToolResponseInput | JsonValue): ToolResponseRecord | null {
  const parsed = toolResponseRecordSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseToolRequest(value: JsonValue): z.infer<typeof toolRequestSchema> | null {
  const parsed = toolRequestSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
}
