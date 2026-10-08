import { abortable } from "@humansandmachines/gsv-browser/abort";

/** Lets browser work overlap, but gives a save exclusive ownership until it settles. */
export class BrowserOperationGate {
  private readonly pending = new Set<Promise<void>>();
  private barrier: Promise<void> = Promise.resolve();

  run<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
    return this.enter(work, signal, false);
  }

  save<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
    return this.enter(work, signal, true);
  }

  private async enter<T>(work: () => Promise<T>, signal: AbortSignal, exclusive: boolean): Promise<T> {
    const previous = exclusive ? Promise.all(this.pending).then(() => {}) : this.barrier;
    let resolve!: () => void;
    const done = new Promise<void>(release => { resolve = release; });
    this.pending.add(done);
    if (exclusive) this.barrier = done;
    const release = () => { this.pending.delete(done); resolve(); };
    let acquired = false;
    try {
      await abortable(previous, signal);
      signal.throwIfAborted();
      acquired = true;
      return await work();
    } finally {
      // A cancelled waiter must not let later work bypass an earlier save.
      if (acquired) release();
      else void previous.then(release);
    }
  }
}

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
