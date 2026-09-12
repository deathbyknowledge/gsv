import type { InferenceTransport } from "@humansandmachines/gsv/services/inference-execution";
import { raceWithAbort } from "./shared/abort";

/** Provider HTTP through the one target authorized by the Kernel for this run. */
export function createInferenceTransportFetch(
  transport: InferenceTransport,
  generationSignal?: AbortSignal,
): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const signal = generationSignal
      ? AbortSignal.any([generationSignal, request.signal])
      : request.signal;
    signal.throwIfAborted();
    const requestId = crypto.randomUUID();
    let aborted = false;
    let cancelBody: ((reason: Error | string | null | undefined) => void) | undefined;
    const abort = () => {
      cancelBody?.(signal.reason ?? new DOMException("Inference transport cancelled", "AbortError"));
      if (aborted) return;
      aborted = true;
      void transport.abort(requestId).catch(() => {});
    };
    signal.addEventListener("abort", abort, { once: true });
    const cleanup = () => signal.removeEventListener("abort", abort);
    try {
      const outbound = new Request(request, { signal: null });
      const response = await raceWithAbort(transport.fetch(requestId, outbound), signal, {
        onAbort: abort,
        onLateResolve: (late) => { void late.body?.cancel(signal.reason).catch(() => {}); },
      });
      if (!response.body) {
        cleanup();
        return response;
      }
      const reader = response.body.getReader();
      let closed = false;
      let cancellation: Promise<void> | undefined;
      const cancelReader = (reason: Error | string | null | undefined) => {
        cancellation ??= reader.cancel(reason).catch(() => {}).finally(() => reader.releaseLock());
        return cancellation;
      };
      const body: ReadableStream<Uint8Array> = new ReadableStream({
        type: "bytes",
        start(controller) {
          cancelBody = (reason) => {
            if (closed) return;
            closed = true;
            cleanup();
            void cancelReader(reason);
            controller.error(reason);
          };
          if (signal.aborted) abort();
        },
        async pull(controller) {
          try {
            const chunk = await raceWithAbort(reader.read(), signal, { onAbort: abort });
            if (closed) return;
            if (chunk.done) {
              closed = true;
              cleanup();
              reader.releaseLock();
              controller.close();
            } else {
              controller.enqueue(chunk.value);
            }
          } catch (error) {
            cancelBody?.(error instanceof Error ? error : new Error("Inference response failed"));
            abort();
          }
        },
        async cancel(reason) {
          if (closed) return cancellation;
          closed = true;
          cleanup();
          abort();
          await cancelReader(reason);
        },
      });
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (error) {
      cleanup();
      abort();
      throw error;
    }
  };
}
