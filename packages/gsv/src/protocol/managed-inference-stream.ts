import type { ManagedInferenceStreamEvent } from "./managed";

export const MAX_MANAGED_INFERENCE_STREAM_EVENT_BYTES = 16 * 1024 * 1024;

const encoder = new TextEncoder();

export function encodeManagedInferenceStreamEvent(
  event: ManagedInferenceStreamEvent,
): Uint8Array {
  const payload = encoder.encode(JSON.stringify(event));
  if (payload.byteLength > MAX_MANAGED_INFERENCE_STREAM_EVENT_BYTES) {
    throw new Error("Managed inference stream event is too large");
  }
  const framed = new Uint8Array(payload.byteLength + 1);
  framed.set(payload);
  framed[payload.byteLength] = 0x0a;
  return framed;
}

export async function* decodeManagedInferenceStream(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<unknown> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let eventBytes = 0;
  let completed = false;
  const cancelForAbort = () => {
    void reader.cancel(signal?.reason).catch(() => {});
  };
  signal?.addEventListener("abort", cancelForAbort, { once: true });

  try {
    if (signal?.aborted) throw abortError();
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        completed = true;
        break;
      }
      if (!(value instanceof Uint8Array)) {
        throw new Error("Managed inference stream emitted a non-byte chunk");
      }
      let start = 0;
      for (let index = 0; index < value.byteLength; index += 1) {
        if (value[index] !== 0x0a) continue;
        appendPart(value.subarray(start, index), parts, eventBytes);
        eventBytes += index - start;
        if (eventBytes === 0) {
          throw new Error("Managed inference stream emitted an empty event");
        }
        yield parseEvent(parts, eventBytes);
        parts.length = 0;
        eventBytes = 0;
        start = index + 1;
      }
      const remainder = value.subarray(start);
      appendPart(remainder, parts, eventBytes);
      eventBytes += remainder.byteLength;
    }
    if (eventBytes !== 0) {
      throw new Error("Managed inference stream ended with an incomplete event");
    }
  } finally {
    signal?.removeEventListener("abort", cancelForAbort);
    if (!completed) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function appendPart(
  part: Uint8Array,
  parts: Uint8Array[],
  previousBytes: number,
): void {
  if (previousBytes + part.byteLength > MAX_MANAGED_INFERENCE_STREAM_EVENT_BYTES) {
    throw new Error("Managed inference stream event is too large");
  }
  if (part.byteLength > 0) parts.push(part);
}

function parseEvent(parts: Uint8Array[], byteLength: number): unknown {
  const payload = new Uint8Array(byteLength);
  let offset = 0;
  for (const part of parts) {
    payload.set(part, offset);
    offset += part.byteLength;
  }
  let json: string;
  try {
    json = new TextDecoder("utf-8", { fatal: true }).decode(payload);
  } catch {
    throw new Error("Managed inference stream event is not UTF-8");
  }
  try {
    return JSON.parse(json) as unknown;
  } catch {
    throw new Error("Managed inference stream event is not valid JSON");
  }
}

function abortError(): Error {
  return new DOMException("Managed inference stream was aborted", "AbortError");
}
