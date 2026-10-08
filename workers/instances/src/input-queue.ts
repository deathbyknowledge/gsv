type InputOwner = "ship" | "human";
type PendingInput = { owner: InputOwner; run: () => Promise<void>; cancel?: () => void };

/** Keeps actions intact and yields to a person who is still typing or clicking. */
export class BrowserInputQueue {
  private readonly pending: PendingInput[] = [];
  private running = false;
  private humanUntil = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  run<T>(work: () => Promise<T>, signal?: AbortSignal, owner: InputOwner = "ship"): Promise<T> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (owner === "human") this.humanUntil = Date.now() + 1000;
    return new Promise<T>((resolve, reject) => {
      const item: PendingInput = { owner, run: async () => {
        if (item.cancel) signal?.removeEventListener("abort", item.cancel);
        try { signal?.throwIfAborted(); resolve(await work()); }
        catch (error) { reject(error); }
      } };
      item.cancel = () => {
        const index = this.pending.indexOf(item);
        if (index < 0) return;
        this.pending.splice(index, 1);
        signal?.removeEventListener("abort", item.cancel!);
        reject(signal?.reason);
        this.drain();
      };
      signal?.addEventListener("abort", item.cancel, { once: true });
      this.pending.push(item);
      this.drain();
    });
  }

  private drain(): void {
    clearTimeout(this.timer);
    if (this.running || !this.pending.length) return;
    const human = this.pending.findIndex(item => item.owner === "human");
    const delay = this.humanUntil - Date.now();
    if (human < 0 && delay > 0) {
      this.timer = setTimeout(() => this.drain(), delay);
      return;
    }
    const [item] = this.pending.splice(human >= 0 ? human : 0, 1);
    this.running = true;
    void item.run().finally(() => { this.running = false; this.drain(); });
  }
}
