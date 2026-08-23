import { byteStreamChunk } from "@humansandmachines/gsv/protocol";

export function abortError(reason: Error | string | null | undefined): Error {
  return reason instanceof Error ? reason : new Error("The operation was aborted");
}

export function bindStreamToAbort(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  let finished = false;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const finish = () => {
    if (finished) return;
    finished = true;
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  };
  const abort = () => {
    if (finished) return;
    const error = abortError(signal.reason);
    controller.error(error);
    void reader.cancel(error).catch(() => {}).finally(finish);
  };

  return new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    },
    async pull(value) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          finish();
          value.close();
        } else {
          value.enqueue(chunk.value);
        }
      } catch (error) {
        finish();
        value.error(error);
      }
    },
    async cancel(reason: Error | string | null | undefined) {
      await reader.cancel(reason).catch(() => {});
      finish();
    },
  });
}

/** Preserves abort ownership while producing a Worker-RPC transferable byte stream. */
export function bindByteStreamToAbort(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  let finished = false;
  let controller: ReadableByteStreamController;
  const finish = () => {
    if (finished) return;
    finished = true;
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  };
  const abort = () => {
    if (finished) return;
    const error = abortError(signal.reason);
    controller.error(error);
    void reader.cancel(error).catch(() => {}).finally(finish);
  };

  const source: UnderlyingByteSource = {
    type: "bytes",
    start(value) {
      controller = value;
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    },
    async pull(value) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          finish();
          value.close();
        } else {
          value.enqueue(byteStreamChunk(chunk.value));
        }
      } catch (error) {
        finish();
        value.error(error);
      }
    },
    async cancel(reason: Error | string | null | undefined) {
      await reader.cancel(reason).catch(() => {});
      finish();
    },
  };
  return new ReadableStream(source);
}
