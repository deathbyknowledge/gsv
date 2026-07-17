import { bodyToBytes } from "../../../packages/gsv/src/protocol/body.js";
import type { BinaryBody } from "./types";

export {
  binaryBodyFromBytes,
  bundleAdapterMedia,
  cancelBinaryBody,
  readAdapterMediaBody,
  validateAdapterMediaBody,
} from "../../../packages/gsv/src/protocol/adapter-media-body.js";
export type {
  AdapterMediaBundle,
  AdapterMediaPart,
  ReadAdapterMediaBodyOptions,
} from "../../../packages/gsv/src/protocol/adapter-media-body.js";

export const SAFE_MATERIALIZED_MEDIA_PART_BYTES = 25 * 1024 * 1024;
export const SAFE_MATERIALIZED_MEDIA_TOTAL_BYTES = 48 * 1024 * 1024;

export type ResponseBodyReadOptions = {
  maxBytes: number;
  expectedBytes?: number;
  label?: string;
  signal?: AbortSignal;
};

/**
 * Reads an HTTP response body with a hard limit even when Content-Length is
 * missing or dishonest. The response body is consumed on success and
 * cancelled on every failure path.
 */
export async function readResponseBodyBytes(
  response: Response,
  options: ResponseBodyReadOptions,
): Promise<Uint8Array> {
  const maxBytes = requireByteLimit(options.maxBytes);
  const label = options.label?.trim() || "Response body";
  let declaredBytes: number | undefined;
  try {
    declaredBytes = responseBodyLength(response, options.expectedBytes);
  } catch (error) {
    await cancelResponseBody(response, error);
    throw error;
  }
  if (declaredBytes !== undefined && declaredBytes > maxBytes) {
    await cancelResponseBody(response, `${label} exceeds transfer limit`);
    throw new Error(`${label} exceeds transfer limit (${declaredBytes} bytes, max ${maxBytes})`);
  }
  if (!response.body) {
    if ((declaredBytes ?? 0) !== 0) {
      throw new Error(`${label} did not include a readable body`);
    }
    return new Uint8Array();
  }

  try {
    return await bodyToBytes(
      { stream: response.body },
      maxBytes,
      options.signal,
    );
  } catch (error) {
    await cancelResponseBody(response, error);
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} could not be read: ${detail}`);
  }
}

/**
 * Keeps a response streaming when it has a trustworthy exact length. Unknown
 * length bodies are materialized through the capped reader so the resulting
 * binary frame can still declare an exact length.
 */
export async function responseBodyToBinaryBody(
  response: Response,
  options: ResponseBodyReadOptions,
): Promise<BinaryBody & { length: number }> {
  const maxBytes = requireByteLimit(options.maxBytes);
  const label = options.label?.trim() || "Response body";
  let declaredBytes: number | undefined;
  try {
    declaredBytes = responseBodyLength(response, options.expectedBytes);
  } catch (error) {
    await cancelResponseBody(response, error);
    throw error;
  }
  if (declaredBytes !== undefined && declaredBytes > maxBytes) {
    await cancelResponseBody(response, `${label} exceeds transfer limit`);
    throw new Error(`${label} exceeds transfer limit (${declaredBytes} bytes, max ${maxBytes})`);
  }
  if (!response.body) {
    if ((declaredBytes ?? 0) !== 0) {
      throw new Error(`${label} did not include a readable body`);
    }
    return binaryBodyFromOwnedBytes(new Uint8Array());
  }
  if (declaredBytes !== undefined) {
    return { stream: response.body, length: declaredBytes };
  }
  return binaryBodyFromOwnedBytes(await readResponseBodyBytes(response, options));
}

/**
 * Converts newly-created bytes into a body without cloning them. Callers must
 * relinquish the byte array after passing it here.
 */
export function binaryBodyFromOwnedBytes(
  bytes: Uint8Array,
): BinaryBody & { length: number } {
  return {
    length: bytes.byteLength,
    stream: new ReadableStream<Uint8Array>({
      start(controller) {
        if (bytes.byteLength > 0) {
          controller.enqueue(bytes);
        }
        controller.close();
      },
    }),
  };
}

export async function cancelResponseBody(
  response: Response,
  reason?: unknown,
): Promise<void> {
  if (response.body && !response.body.locked) {
    await response.body.cancel(reason).catch(() => {});
  }
}

function responseBodyLength(
  response: Response,
  expectedBytes: number | undefined,
): number | undefined {
  const rawContentLength = response.headers.get("content-length")?.trim();
  if (rawContentLength && /^\d+$/.test(rawContentLength)) {
    const contentLength = Number(rawContentLength);
    if (Number.isSafeInteger(contentLength)) {
      return contentLength;
    }
  }
  if (expectedBytes === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0) {
    throw new Error("Expected response body length must be a non-negative safe integer");
  }
  return expectedBytes;
}

function requireByteLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Response body limit must be a non-negative safe integer");
  }
  return value;
}
