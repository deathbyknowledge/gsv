import { cancelBinaryBody, type BinaryBody } from "@humansandmachines/gsv/protocol";
import type { InstanceTargetRequest, InstanceTargetResponse } from "@humansandmachines/gsv/services/instances";

/** Owns admission, dispatch and the returned body as one cancellable request. */
export class ComputerRequest {
  readonly abort = new AbortController();
  readonly done: Promise<void>;
  private readonly timer: ReturnType<typeof setTimeout>;
  private release!: () => void;
  private finished = false;
  private abortBody: ((cause: unknown) => void) | undefined;

  constructor(
    private readonly frame: InstanceTargetRequest,
    deadlineAt: number,
    private readonly cancel: () => void,
    private readonly complete: () => void,
  ) {
    this.done = new Promise(resolve => { this.release = resolve; });
    this.abort.signal.addEventListener("abort", this.onAbort, { once: true });
    this.timer = setTimeout(() => this.abort.abort(new Error("Computer request deadline exceeded")), Math.max(0, deadlineAt - Date.now()));
  }

  async run(work: (signal: AbortSignal) => Promise<InstanceTargetResponse>): Promise<InstanceTargetResponse> {
    const signal = this.abort.signal;
    let onAbort: (() => void) | undefined;
    try {
      signal.throwIfAborted();
      const cancelled = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
      });
      const pending = work(signal);
      // An RPC can settle after cancellation. Its body still belongs to this request.
      void pending.then(response => {
        if (signal.aborted && response.ok) void cancelBinaryBody(response.body, signal.reason);
      }, () => {});
      const response = await Promise.race([pending, cancelled]);
      signal.throwIfAborted();
      if (response.ok && response.body) return { ...response, body: this.ownBody(response.body) };
      this.finish();
      return response;
    } catch (cause) {
      void cancelBinaryBody(this.frame.body, cause);
      this.finish();
      throw cause;
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  }

  private readonly onAbort = (): void => {
    this.cancel();
    void cancelBinaryBody(this.frame.body, this.abort.signal.reason);
    this.abortBody?.(this.abort.signal.reason);
    this.finish();
  };

  private ownBody(body: BinaryBody): BinaryBody {
    const reader = body.stream.getReader();
    let ended = false;
    const finish = (): boolean => {
      if (ended) return false;
      ended = true;
      reader.releaseLock();
      this.finish();
      return true;
    };
    const stream = new ReadableStream<Uint8Array>({
      start: controller => {
        this.abortBody = cause => {
          if (ended) return;
          void reader.cancel(cause).catch(() => {});
          if (finish()) controller.error(cause);
        };
      },
      pull: async controller => {
        try {
          const part = await reader.read();
          if (ended) return;
          if (part.done) { finish(); controller.close(); }
          else controller.enqueue(part.value);
        } catch (cause) {
          if (ended) return;
          this.abort.abort(cause);
        }
      },
      cancel: cause => { this.abort.abort(cause ?? new Error("Computer response body cancelled")); },
    }, { highWaterMark: 0 });
    return { ...body, stream };
  }

  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    clearTimeout(this.timer);
    this.abort.signal.removeEventListener("abort", this.onAbort);
    this.complete();
    this.release();
  }
}
