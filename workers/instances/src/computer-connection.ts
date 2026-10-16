import { BinaryBodyChannel } from "@humansandmachines/gsv/protocol/binary-body-channel";
import { cancelBinaryBody, wireFrameSchemas, type JsonValue } from "@humansandmachines/gsv/protocol";
import type { InstanceTargetRequest, InstanceTargetResponse } from "@humansandmachines/gsv/services/instances";

type Pending = {
  abort: AbortController;
  resolve: (response: InstanceTargetResponse) => void;
  reject: (cause: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** The machine protocol over a private container port, with the ordinary body flow control. */
export class ComputerConnection {
  private readonly bodies: BinaryBodyChannel;
  private readonly pending = new Map<string, Pending>();
  private closed = false;
  constructor(private readonly socket: WebSocket, onStatus: (payload: JsonValue | undefined) => void) {
    socket.binaryType = "arraybuffer";
    this.bodies = new BinaryBodyChannel({ sendFrame: frame => socket.send(frame) });
    socket.addEventListener("message", event => {
      try {
        // oxlint-disable-next-line anti-slop/no-runtime-typeof -- WebSocket defines text or binary payloads; each carrier branch validates its frame.
        if (typeof event.data !== "string") {
          if (!this.bodies.handleFrame(event.data)) throw new Error("Unknown computer binary frame");
          return;
        }
        const frame = wireFrameSchemas.frame.parse(JSON.parse(event.data));
        if (frame.type === "sig" && frame.signal === "exec.status") { onStatus(frame.payload); return; }
        if (frame.type !== "res") throw new Error("Unexpected computer frame");
        const pending = this.pending.get(frame.id);
        const body = frame.ok && frame.body ? this.bodies.receive(frame.body, pending?.abort.signal) : undefined;
        if (!pending) { void cancelBinaryBody(body, "Request no longer active"); return; }
        if (!body) {
          this.finish(frame.id);
          // SAFETY: The authenticated gsvd uses the same syscall response contracts.
          pending.resolve(frame as InstanceTargetResponse);
          return;
        }
        const reader = body.stream.getReader();
        const finish = () => { reader.releaseLock(); this.finish(frame.id); };
        const stream = new ReadableStream<Uint8Array>({
          pull: async controller => {
            try {
              const part = await reader.read();
              if (part.done) { finish(); controller.close(); }
              else controller.enqueue(part.value);
            } catch (cause) { finish(); controller.error(cause); }
          },
          cancel: async cause => { try { await reader.cancel(cause); } finally { finish(); } },
        });
        // Keep the request deadline and cancellation until its response body terminates.
        // SAFETY: Only the carrier's body descriptor is replaced, preserving the machine result.
        pending.resolve({ ...frame, body: { ...body, stream } } as InstanceTargetResponse);
      } catch (cause) { this.close(cause); }
    });
    socket.addEventListener("close", () => this.close(new Error("Computer connection closed")));
    socket.addEventListener("error", () => this.close(new Error("Computer connection failed")));
    socket.accept();
  }

  get connected(): boolean { return !this.closed; }

  async execute(frame: InstanceTargetRequest, deadlineAt: number): Promise<InstanceTargetResponse> {
    if (this.closed || this.pending.has(frame.id) || deadlineAt <= Date.now()) {
      await cancelBinaryBody(frame.body, "Computer request was not admitted");
      throw new Error("Computer connection is unavailable, request is duplicate, or deadline expired");
    }
    const abort = new AbortController();
    const outgoing = frame.body ? this.bodies.prepare(frame.body) : undefined;
    const response = new Promise<InstanceTargetResponse>((resolve, reject) => {
      const timer = setTimeout(() => this.cancel(frame.id, "Computer command deadline exceeded"), deadlineAt - Date.now());
      this.pending.set(frame.id, { abort, resolve, reject, timer });
    });
    try {
      this.socket.send(JSON.stringify({ ...frame, body: outgoing?.descriptor }));
      if (outgoing) void outgoing.send(abort.signal).catch(cause => this.cancel(frame.id, cause));
    } catch (cause) {
      if (outgoing) await outgoing.cancel(cause);
      this.cancel(frame.id, cause);
    }
    return response;
  }

  cancel(id: string, cause: unknown = "Computer request cancelled"): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    const error = cause instanceof Error ? cause : new Error(String(cause));
    pending.abort.abort(error);
    pending.reject(error);
    this.finish(id);
    if (!this.closed) {
      try { this.socket.send(JSON.stringify({ type: "sig", signal: "request.cancel", payload: { id } })); }
      catch (cause) { this.close(cause); }
    }
  }

  close(cause: unknown = new Error("Computer connection ended")): void {
    if (this.closed) return;
    this.closed = true;
    for (const id of this.pending.keys()) this.cancel(id, cause);
    this.bodies.close(cause);
    try { this.socket.close(1000, "Connection ended"); } catch { /* A failed transport may already be closed. */ }
  }

  private finish(id: string): void {
    const pending = this.pending.get(id);
    if (pending) {
      clearTimeout(pending.timer);
      pending.abort.abort(new Error("Computer request completed"));
    }
    this.pending.delete(id);
  }
}
