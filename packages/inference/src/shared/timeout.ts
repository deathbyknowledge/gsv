export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

export function generationTimeoutMessage(timeoutMs: number): string {
  return `Model generation timed out after ${timeoutMs}ms`;
}

type GenerationAbort = { signal: AbortSignal; deadlineAt: number; clear: () => void };

export function createGenerationAbort(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
  deadlineAt = Date.now() + timeoutMs,
): GenerationAbort {
  deadlineAt = Math.min(deadlineAt, Date.now() + timeoutMs);
  const timeoutController = new AbortController();
  const remainingMs = Math.max(0, deadlineAt - Date.now());
  const abort = () => timeoutController.abort(new TimeoutError(generationTimeoutMessage(timeoutMs)));
  const timeout = remainingMs > 0 ? setTimeout(abort, remainingMs) : undefined;
  if (remainingMs === 0) abort();
  return {
    signal: callerSignal
      ? AbortSignal.any([callerSignal, timeoutController.signal])
      : timeoutController.signal,
    deadlineAt,
    clear: () => clearTimeout(timeout),
  };
}

export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return promise;
  }

  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => reject(new TimeoutError(message)), timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
  });
}
