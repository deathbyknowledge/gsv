/** Own the response until consumption or cancellation, including while nobody is reading. */
export function ownInferenceBody(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onCancel: (reason: Error | string | null | undefined) => void,
  onFinish: () => void,
): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  let closed = false;
  let controller: ReadableByteStreamController;
  const finish = () => {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
    onFinish();
  };
  const cancel = (reason: Error | string | null | undefined) => {
    if (closed) return;
    closed = true;
    signal.removeEventListener("abort", abort);
    onCancel(reason);
    void reader.cancel(reason).catch(() => {});
    finish();
  };
  const abort = () => {
    if (closed) return;
    controller.error(signal.reason);
    void cancel(signal.reason);
  };
  return new ReadableStream({
    type: "bytes",
    start(value) {
      controller = value;
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    },
    async pull(value) {
      try {
        const chunk = await reader.read();
        if (closed) return;
        if (chunk.done) {
          closed = true;
          finish();
          value.close();
        } else value.enqueue(chunk.value);
      } catch (error) {
        if (closed) return;
        value.error(error);
        await cancel(error instanceof Error ? error : new Error("Inference response failed"));
      }
    },
    cancel,
  });
}
