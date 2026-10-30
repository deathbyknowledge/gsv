import type { BinaryBody } from "@humansandmachines/gsv/protocol";
import type { PhoneWatchEvent } from "@humansandmachines/gsv/protocol";

const MAX_BUFFERED = 256;
const encoder = new TextEncoder();

/** One viewer's newline-delimited event stream. Closing it never affects the call. */
export class CallWatch {
  readonly body: BinaryBody;
  #controller!: ReadableStreamDefaultController<Uint8Array>;
  #closed = false;
  constructor(initial: PhoneWatchEvent[], private readonly onClose: () => void) {
    const stream = new ReadableStream<Uint8Array>({
      start: controller => { this.#controller = controller; },
      cancel: () => this.#finish(),
    });
    this.body = { delivery: "realtime", stream };
    for (const event of initial) this.send(event);
  }
  send(event: PhoneWatchEvent): void {
    if (this.#closed) return;
    // A viewer that stops reading is dropped rather than buffering a whole call.
    if ((this.#controller.desiredSize ?? 0) < -MAX_BUFFERED) { this.close(); return; }
    this.#controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
  }
  close(): void {
    if (this.#closed) return;
    this.#controller.close();
    this.#finish();
  }
  #finish(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.onClose();
  }
}
