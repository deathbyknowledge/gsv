import {
  bodyToBytes,
  bodyToText,
} from "@humansandmachines/gsv/protocol";
import type { FrameBody } from "../protocol/frames";
import { formatSize } from "../fs";
import { encodeBase64Bytes } from "../shared/base64";

const MAX_TOOL_IMAGE_BYTES = 25 * 1024 * 1024;

export async function materializeToolResponse(
  call: string,
  data: unknown,
  body?: FrameBody,
  signal?: AbortSignal,
): Promise<unknown> {
  const record = asRecord(data);
  if (call === "net.fetch") {
    const bytes = body ? await bodyToBytes(body, Infinity, signal) : new Uint8Array();
    const text = decodeUtf8(bytes);
    return {
      ...(record ?? {}),
      bodyBase64: encodeBase64Bytes(bytes),
      ...(text === null ? {} : { bodyText: text }),
      bodyBytes: bytes.byteLength,
    };
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
    return data;
  }
  if (call === "fs.read" && record?.ok === true) {
    if (record.kind === "text") {
      return { ...record, content: await bodyToText(body, Infinity, signal) };
    }
    if (record.kind === "image") {
      const bytes = await bodyToBytes(body, MAX_TOOL_IMAGE_BYTES, signal);
      const mimeType = typeof record.contentType === "string"
        ? record.contentType
        : "application/octet-stream";
      const path = typeof record.path === "string" ? record.path : "image";
      const size = typeof record.size === "number" ? record.size : bytes.byteLength;
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
  args: unknown,
  result: unknown,
): unknown {
  const record = asRecord(result);
  if (call !== "fs.read" || record?.kind !== "text" || typeof record.content !== "string") {
    return result;
  }

  const request = asRecord(args);
  const offset = typeof request?.offset === "number" ? request.offset : 0;
  const lines = record.lines === 0 ? [] : record.content.split("\n");
  return {
    ...record,
    content: lines
      .map((line, index) => `${String(offset + index + 1).padStart(6)}\t${line}`)
      .join("\n"),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
}
