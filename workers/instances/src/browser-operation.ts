/** Bounds provider waits without replaying an operation whose outcome is unknown. */
export async function within<T>(work: Promise<T>, timeoutMs: number, operation = "Browser provider operation", signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal?.reason);
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
    return await Promise.race([work, cancelled, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${operation} timed out after ${timeoutMs}ms`)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); if (onAbort) signal?.removeEventListener("abort", onAbort); }
}
