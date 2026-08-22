import {
  bodyToBytes,
  bodyToText,
  jsonValueSchema,
} from "@humansandmachines/gsv/protocol";
import type {
  JsonValue,
} from "@humansandmachines/gsv/protocol";
import type {
  FrameBody,
  ResponseOkFrame,
} from "../protocol/frames";
import { formatSize } from "../fs";
import { encodeBase64Bytes } from "../shared/base64";
import { z } from "zod";

const MAX_TOOL_IMAGE_BYTES = 25 * 1024 * 1024;

const toolResponseRecordSchema = z.object({
  ok: z.boolean().optional(),
  files: z.array(z.json()).optional(),
  directories: z.array(z.json()).optional(),
  kind: z.enum(["text", "image"]).optional(),
  content: z.json().optional(),
  contentType: z.string().optional(),
  path: z.string().optional(),
  size: z.number().optional(),
  lines: z.number().optional(),
}).catchall(z.json());

const textToolResponseSchema = toolResponseRecordSchema.extend({
  kind: z.literal("text"),
  content: z.string(),
});

const toolRequestSchema = z.object({
  offset: z.number().optional(),
}).catchall(z.json());

type ToolResponseRecord = z.infer<typeof toolResponseRecordSchema>;
type ToolResponseInput = ResponseOkFrame["data"] | null;

export async function materializeToolResponse(
  call: string,
  data: ToolResponseInput | null,
  body?: FrameBody,
  signal?: AbortSignal,
): Promise<JsonValue> {
  const record = parseToolResponseRecord(data);
  if (call === "net.fetch") {
    const bytes = body ? await bodyToBytes(body, Infinity, signal) : new Uint8Array();
    const text = decodeUtf8(bytes);
    const result: ToolResponseRecord = {
      ...record,
      bodyBase64: encodeBase64Bytes(bytes),
      bodyBytes: bytes.byteLength,
    };
    if (text !== null) {
      result.bodyText = text;
    }
    return result;
  }
  if (
    call === "fs.read"
    && record?.ok === true
    && !("files" in record)
    && !("directories" in record)
    && !body
  ) {
    throw new Error("fs.read file response did not include a body");
  }
  if (!body) {
    return jsonValueSchema.parse(data);
  }
  if (call === "fs.read" && record?.ok === true) {
    if (record.kind === "text") {
      return { ...record, content: await bodyToText(body, Infinity, signal) };
    }
    if (record.kind === "image") {
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
  }
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
  return {
    ...record.data,
    content: lines
      .map((line, index) => `${String(offset + index + 1).padStart(6)}\t${line}`)
      .join("\n"),
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
