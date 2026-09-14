import type { InferenceMediaRequest, InferenceMediaResult } from "@humansandmachines/gsv/services/inference-execution";
import { transcribeAudio, synthesizeSpeech, generateImage, readImage, encodeBase64Bytes } from "../media";
import { raceWithAbort } from "../shared/abort";
import type { ExecutorEnvironment } from "./config";
import { requestBinding } from "./bodies";

export async function executeMedia(
  env: ExecutorEnvironment,
  request: InferenceMediaRequest,
  body: ReadableStream<Uint8Array> | undefined,
  signal: AbortSignal,
  providerFetch: typeof fetch,
): Promise<InferenceMediaResult> {
  const binding = requestBinding(env.AI, signal);
  const runtime = { workersAi: binding, fetch: providerFetch };
  const timeoutMs = Math.max(1, Math.min(request.timeoutMs, request.deadlineAt - Date.now()));
  switch (request.kind) {
    case "transcription": {
      const data = await readInput(body, Math.min(request.input.maxInputBytes, 25 * 1024 * 1024), signal);
      const result = await transcribeAudio(runtime, { ...request.input, data, timeoutMs, signal });
      if (!result) throw new Error("Audio transcription returned no result");
      return { kind: request.kind, result };
    }
    case "image-read": {
      const data = await readInput(body, Math.min(request.input.maxInputBytes, 10 * 1024 * 1024), signal);
      const result = await readImage(binding, { ...request.input, data, timeoutMs, signal });
      if (!result) throw new Error("Image reading returned no result");
      return { kind: request.kind, result: result.result, body: result.stream };
    }
    case "image-generate": {
      const result = await generateImage(runtime, { ...request.input, timeoutMs });
      if (!result) throw new Error("Image generation returned no result");
      const { bytes, ...metadata } = result;
      return { kind: request.kind, result: { ...metadata, size: bytes?.byteLength ?? 0 }, body: bytes ? bytesBody(bytes) : undefined };
    }
    case "speech": {
      const result = await synthesizeSpeech(runtime, { ...request.input, timeoutMs });
      if (!result) throw new Error("Speech generation returned no result");
      const { bytes, ...metadata } = result;
      return { kind: request.kind, result: { ...metadata, size: bytes.byteLength }, body: bytesBody(bytes) };
    }
  }
}

async function readInput(body: ReadableStream<Uint8Array> | undefined, maxBytes: number, signal: AbortSignal): Promise<string> {
  if (!body) throw new Error("Inference media body is required");
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("Invalid inference media byte limit");
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let complete = false;
  try {
    while (true) {
      const next = await raceWithAbort(reader.read(), signal);
      if (next.done) { complete = true; break; }
      if (!(next.value instanceof Uint8Array)) throw new Error("Invalid inference media bytes");
      size += next.value.byteLength;
      if (size > maxBytes) throw new Error("Inference media input is too large");
      chunks.push(next.value);
    }
  } finally {
    if (!complete) void reader.cancel(signal.reason).catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return encodeBase64Bytes(bytes);
}

function bytesBody(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } });
}
