import type { GsvBody } from "@humansandmachines/gsv/client";
import { bodyToBytes } from "@humansandmachines/gsv/protocol";

type ReadFrameBodyOptions = {
  mimeType: string;
  expectedLength?: number;
  label?: string;
};

export function frameBodyFromBlob(blob: Blob): GsvBody {
  return {
    stream: blob.stream(),
    length: blob.size,
  };
}

export async function frameBodyToBlob(
  body: GsvBody,
  options: ReadFrameBodyOptions,
): Promise<Blob> {
  const label = options.label?.trim() || "Response body";
  const expectedLength = options.expectedLength;
  if (expectedLength !== undefined && (!Number.isSafeInteger(expectedLength) || expectedLength < 0)) {
    const error = new Error(`${label} length is invalid: ${expectedLength}`);
    await body.stream.cancel(error).catch(() => {});
    throw error;
  }
  if (
    expectedLength !== undefined
    && body.length !== undefined
    && body.length !== expectedLength
  ) {
    await body.stream.cancel(`${label} length does not match response metadata`).catch(() => {});
    throw new Error(`${label} length mismatch: expected ${expectedLength}, got ${body.length}`);
  }

  let bytes: Uint8Array;
  try {
    bytes = await bodyToBytes(body, expectedLength ?? Infinity);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} could not be read: ${message}`);
  }

  if (expectedLength !== undefined && bytes.byteLength !== expectedLength) {
    throw new Error(`${label} length mismatch: expected ${expectedLength}, got ${bytes.byteLength}`);
  }
  return new Blob([new Uint8Array(bytes)], { type: options.mimeType });
}
