import type { JsonObject, JsonValue } from "@humansandmachines/gsv/protocol";
import type { ExecutorEnvironment } from "./config";
import { raceWithAbort } from "../shared/abort";

type BindingResult = Response | ReadableStream<Uint8Array> | ArrayBuffer | ArrayBufferView | Blob | JsonValue;
type Binding = NonNullable<ExecutorEnvironment["AI"]>;

/** Bind native provider body ownership to the executor's terminal signal. */
export function requestBinding(binding: Binding | undefined, signal: AbortSignal): Binding | undefined {
  if (!binding) return undefined;
  const run = async (model: string, input: JsonObject, options?: { signal?: AbortSignal }): Promise<BindingResult> => {
    const combined = options?.signal ? AbortSignal.any([signal, options.signal]) : signal;
    combined.throwIfAborted();
    const result = await raceWithAbort(binding.run(model, input, { ...options, signal: combined }), combined, { onLateResolve: cancelResult });
    return ownResult(result, combined);
  };
  return {
    aiGatewayLogId: binding.aiGatewayLogId,
    models: binding.models?.bind(binding),
    fetch: binding.fetch ? async (input, init) => {
      signal.throwIfAborted();
      const requestSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      const combined = requestSignal ? AbortSignal.any([signal, requestSignal]) : signal;
      const response = await raceWithAbort(binding.fetch!(input, { ...init, signal: combined }), combined, { onLateResolve: cancelResult });
      return new Response(response.body ? ownBody(response.body, combined) : null, response);
    } : undefined,
    // SAFETY: this wrapper preserves every native run overload's input and result shape.
    run: run as Binding["run"],
  };
}

function ownResult(result: BindingResult, signal: AbortSignal): BindingResult {
  if (result instanceof Response) return new Response(result.body ? ownBody(result.body, signal) : null, result);
  if (result instanceof ReadableStream) return ownBody(result, signal);
  return result;
}

function cancelResult(result: BindingResult): void {
  const body = result instanceof Response ? result.body : result instanceof ReadableStream ? result : undefined;
  void body?.cancel().catch(() => {});
}

export function ownBody(body: ReadableStream<Uint8Array>, signal: AbortSignal): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let closed = false;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const cleanup = (cancel: boolean) => {
    signal.removeEventListener("abort", abort);
    if (cancel) void reader.cancel(signal.reason).catch(() => {});
    reader.releaseLock();
  };
  const abort = () => {
    if (closed) return;
    closed = true;
    cleanup(true);
    controller.error(signal.reason);
  };
  return new ReadableStream({
    start(value) {
      controller = value;
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    },
    async pull() {
      try {
        const next = await raceWithAbort(reader.read(), signal);
        if (closed) return;
        if (next.done) {
          closed = true;
          cleanup(false);
          controller.close();
        } else controller.enqueue(next.value);
      } catch (error) {
        if (closed) return;
        closed = true;
        cleanup(true);
        controller.error(error);
      }
    },
    cancel() {
      if (closed) return;
      closed = true;
      cleanup(true);
    },
  });
}
