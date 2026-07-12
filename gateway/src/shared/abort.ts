type AbortablePromiseOptions<T> = {
  abortReason?: () => unknown;
  onAbort?: () => void;
  onLateResolve?: (value: T) => void;
};

export function raceWithAbort<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
  options: AbortablePromiseOptions<T> = {},
): Promise<T> {
  if (!signal) return promise;

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const abort = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      options.onAbort?.();
      reject(options.abortReason?.() ?? signal.reason ?? new Error("Request cancelled"));
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();

    promise.then(
      (value) => {
        if (settled) {
          options.onLateResolve?.(value);
          return;
        }
        settled = true;
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}
