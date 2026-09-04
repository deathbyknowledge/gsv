import { byteStreamChunk, type BinaryBody } from "./body";
import {
  BINARY_FRAME_CANCEL,
  BINARY_FRAME_DATA,
  BINARY_FRAME_END,
  BINARY_FRAME_ERROR,
  BINARY_FRAME_WINDOW,
  BINARY_INITIAL_WINDOW_BYTES,
  assertStreamId,
  buildBinaryFrame,
  buildWindowFrame,
  parseBinaryFrame,
  parseWindowCredit,
  type BinaryFrameDescriptor,
} from "./binary-frame";

const DEFAULT_CHUNK_BYTES = 1024 * 1024;
const DEFAULT_IDLE_TIMEOUT_MS = 120_000;

/**
 * Which end of the transport a channel sits on. The initiator opened the
 * connection and allocates odd stream ids; the acceptor allocates even ones,
 * so both sides can announce bodies without coordinating.
 */
export type BinaryBodyChannelRole = "initiator" | "acceptor";

type PendingBinaryBody = {
  controller: ReadableByteStreamController;
  timeoutId: ReturnType<typeof setTimeout> | null;
  expectedBytes?: number;
  receivedBytes: number;
  /** Bytes handed to the consumer; the difference from `receivedBytes` is queued here. */
  consumedBytes: number;
  /** Credit granted to the sender so far, including the protocol's initial window. */
  grantedBytes: number;
  /** Chunks received ahead of the consumer, delivered one per pull. */
  queue: Uint8Array[];
  /** The consumer is waiting for a chunk that has not arrived yet. */
  pullPending: boolean;
  /** END arrived; close once the queue drains. */
  ended: boolean;
  signal?: AbortSignal;
  abort: () => void;
};

type OutgoingBinaryBodyState = {
  streamId: number;
  stream: ReadableStream<Uint8Array>;
  reader: ReadableStreamDefaultReader<Uint8Array> | null;
  status: "prepared" | "sending" | "cancelled" | "completed";
  cancelReason?: unknown;
  peerTerminated: boolean;
  /** Bytes the receiver allows on the wire that have not been sent yet. */
  creditBytes: number;
  /** Resumes a send loop that is waiting for credit or cancellation. */
  wake: (() => void) | null;
};

export type BinaryBodyChannelOptions = {
  sendFrame(frame: ArrayBuffer): void | Promise<void>;
  /** Defaults to `"initiator"`; the side that accepted the connection must say so. */
  role?: BinaryBodyChannelRole;
  chunkBytes?: number;
  /**
   * Bytes this channel lets a sender keep in flight per stream while the
   * consumer drains. Defaults to the protocol's initial window.
   */
  windowBytes?: number;
  /**
   * Longest a stream may sit without progress: no frame from a sender that
   * still holds credit, or no credit for a sender that is waiting for it.
   */
  idleTimeoutMs?: number;
};

export type OutgoingBinaryBody = {
  descriptor: BinaryFrameDescriptor;
  send(signal?: AbortSignal): Promise<void>;
  cancel(cause?: unknown): Promise<void>;
};

/**
 * Streams binary bodies over a transport that carries the shared GSV binary-frame format.
 * The caller must send the returned descriptor in its JSON frame before calling `send()`.
 *
 * Receivers are pull-based: credit is granted to the sender as the consumer
 * reads, so a slow consumer stalls the sender instead of growing a buffer.
 */
export class BinaryBodyChannel {
  private readonly pending = new Map<number, PendingBinaryBody>();
  private readonly outgoing = new Map<number, OutgoingBinaryBodyState>();
  private readonly sendFrame: BinaryBodyChannelOptions["sendFrame"];
  private readonly chunkBytes: number;
  private readonly windowBytes: number;
  private readonly idleTimeoutMs: number;
  private readonly firstStreamId: number;
  private nextStreamId: number;

  constructor(options: BinaryBodyChannelOptions) {
    const chunkBytes = options.chunkBytes ?? DEFAULT_CHUNK_BYTES;
    const windowBytes = options.windowBytes ?? BINARY_INITIAL_WINDOW_BYTES;
    const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0) {
      throw new Error(`Invalid binary body chunk size: ${options.chunkBytes}`);
    }
    if (!Number.isSafeInteger(windowBytes) || windowBytes <= 0 || windowBytes > 0xffffffff) {
      throw new Error(`Invalid binary body window: ${options.windowBytes}`);
    }
    if (!Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs <= 0) {
      throw new Error(`Invalid binary body idle timeout: ${options.idleTimeoutMs}`);
    }
    this.sendFrame = options.sendFrame;
    this.chunkBytes = chunkBytes;
    this.windowBytes = windowBytes;
    this.idleTimeoutMs = idleTimeoutMs;
    this.firstStreamId = options.role === "acceptor" ? 2 : 1;
    this.nextStreamId = this.firstStreamId;
  }

  receive(descriptor: BinaryFrameDescriptor, signal?: AbortSignal): BinaryBody {
    assertStreamId(descriptor.streamId);
    assertBodyLength(descriptor.length);
    if (this.pending.has(descriptor.streamId)) {
      throw new Error(`Binary stream already pending: ${descriptor.streamId}`);
    }

    const { streamId, length } = descriptor;
    const source: UnderlyingByteSource = {
      type: "bytes",
      start: (controller) => {
        const abort = () => {
          if (signal) {
            this.rejectPending(streamId, abortError(signal));
          }
        };
        const pending: PendingBinaryBody = {
          controller,
          timeoutId: null,
          expectedBytes: length,
          receivedBytes: 0,
          consumedBytes: 0,
          grantedBytes: BINARY_INITIAL_WINDOW_BYTES,
          queue: [],
          pullPending: false,
          ended: false,
          signal,
          abort,
        };
        this.pending.set(streamId, pending);
        this.armReceiveTimeout(streamId, pending);
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) {
          abort();
        }
      },
      // Called once per consumer read: hand over the next queued chunk, or
      // remember that a read is waiting so the next frame goes straight through.
      pull: (controller) => {
        const pending = this.pending.get(streamId);
        if (!pending) {
          return;
        }
        const chunk = pending.queue.shift();
        if (chunk) {
          this.deliver(streamId, pending, controller, chunk);
          return;
        }
        if (pending.ended) {
          this.clearPending(streamId);
          controller.close();
          return;
        }
        pending.pullPending = true;
        this.replenishWindow(streamId, pending);
      },
      cancel: async (cause) => {
        if (this.clearPending(streamId)) {
          await this.sendCancel(streamId, cause);
        }
      },
    };
    const body: BinaryBody = {
      stream: new ReadableStream(source, { highWaterMark: 0 }),
    };
    if (length !== undefined) {
      body.length = length;
    }
    return body;
  }

  handleFrame(data: ArrayBuffer | ArrayBufferView): boolean {
    const frame = parseBinaryFrame(data);
    if (!frame) {
      return false;
    }
    if ((frame.flags & BINARY_FRAME_WINDOW) !== 0) {
      const outgoing = this.outgoing.get(frame.streamId);
      const credit = parseWindowCredit(frame.payload);
      if (outgoing && credit !== null) {
        outgoing.creditBytes += credit;
        outgoing.wake?.();
      }
      return true;
    }
    if ((frame.flags & BINARY_FRAME_CANCEL) !== 0) {
      const outgoing = this.outgoing.get(frame.streamId);
      if (outgoing) {
        const message = new TextDecoder().decode(frame.payload) || "Binary transfer cancelled by receiver";
        void this.cancelOutgoing(outgoing, new Error(message), false);
      }
      return true;
    }

    const pending = this.pending.get(frame.streamId);
    if (!pending) {
      return true;
    }

    if ((frame.flags & BINARY_FRAME_ERROR) !== 0) {
      const message = new TextDecoder().decode(frame.payload) || "Binary transfer failed";
      this.rejectPending(frame.streamId, new Error(message), false);
      return true;
    }
    if ((frame.flags & BINARY_FRAME_DATA) !== 0 && frame.payload.byteLength > 0) {
      pending.receivedBytes += frame.payload.byteLength;
      if (pending.expectedBytes !== undefined && pending.receivedBytes > pending.expectedBytes) {
        this.rejectPending(
          frame.streamId,
          new Error(`Body exceeded declared length ${pending.expectedBytes}`),
        );
        return true;
      }
      if (pending.receivedBytes > pending.grantedBytes) {
        this.rejectPending(
          frame.streamId,
          new Error(`Body exceeded its receive window of ${pending.grantedBytes} bytes`),
        );
        return true;
      }
      if (pending.pullPending) {
        pending.pullPending = false;
        this.deliver(frame.streamId, pending, pending.controller, frame.payload);
      } else {
        pending.queue.push(frame.payload);
      }
      this.armReceiveTimeout(frame.streamId, pending);
    }
    if ((frame.flags & BINARY_FRAME_END) !== 0) {
      if (pending.expectedBytes !== undefined && pending.receivedBytes !== pending.expectedBytes) {
        this.rejectPending(
          frame.streamId,
          new Error(`Body length ${pending.receivedBytes} did not match ${pending.expectedBytes}`),
        );
        return true;
      }
      if (pending.queue.length > 0) {
        pending.ended = true;
        this.armReceiveTimeout(frame.streamId, pending);
      } else {
        this.clearPending(frame.streamId)?.controller.close();
      }
    }
    return true;
  }

  private deliver(
    streamId: number,
    pending: PendingBinaryBody,
    controller: ReadableByteStreamController,
    chunk: Uint8Array,
  ): void {
    pending.consumedBytes += chunk.byteLength;
    controller.enqueue(byteStreamChunk(chunk));
    this.replenishWindow(streamId, pending);
  }

  prepare(body: BinaryBody): OutgoingBinaryBody {
    try {
      assertBodyLength(body.length);
    } catch (error) {
      void body.stream.cancel(error).catch(() => {});
      throw error;
    }
    const streamId = this.allocateStreamId();
    const state: OutgoingBinaryBodyState = {
      stream: body.stream,
      streamId,
      reader: null,
      status: "prepared",
      peerTerminated: false,
      creditBytes: BINARY_INITIAL_WINDOW_BYTES,
      wake: null,
    };
    this.outgoing.set(streamId, state);
    const descriptor: BinaryFrameDescriptor = { streamId };
    if (body.length !== undefined) {
      descriptor.length = body.length;
    }
    return {
      descriptor,
      send: async (signal) => {
        if (state.status !== "prepared") {
          throw new Error(`Binary body send is ${state.status}: ${streamId}`);
        }
        state.status = "sending";
        await this.sendBody(state, signal);
      },
      cancel: async (cause) => {
        await this.cancelOutgoing(state, cause, true);
      },
    };
  }

  close(cause: unknown = new Error("Binary body channel closed")): void {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    for (const streamId of this.pending.keys()) {
      this.rejectPending(streamId, error, false);
    }
    for (const state of this.outgoing.values()) {
      void this.cancelOutgoing(state, cause, false).catch(() => {});
    }
  }

  private async sendBody(
    state: OutgoingBinaryBodyState,
    signal?: AbortSignal,
  ): Promise<void> {
    const cancelled = () => state.status === "cancelled";
    const abort = () => {
      state.cancelReason = signal?.reason;
      void state.reader?.cancel(signal?.reason).catch(() => {});
      state.wake?.();
    };
    try {
      state.reader = state.stream.getReader();
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) {
        await this.cancelOutgoing(state, signal.reason, true);
        return;
      }
      sendLoop: while (true) {
        const { done, value } = await state.reader.read();
        if (done || cancelled()) {
          break;
        }
        for (let offset = 0; offset < value.byteLength;) {
          const credit = await this.awaitCredit(state);
          if (cancelled() || signal?.aborted) {
            break sendLoop;
          }
          const size = Math.min(this.chunkBytes, credit, value.byteLength - offset);
          state.creditBytes -= size;
          await this.sendFrame(buildBinaryFrame(
            state.streamId,
            BINARY_FRAME_DATA,
            value.subarray(offset, offset + size),
          ));
          offset += size;
        }
      }
      if (cancelled() || signal?.aborted) {
        if (!state.peerTerminated) {
          state.peerTerminated = true;
          await this.sendError(state.streamId, state.cancelReason ?? signal?.reason);
        }
        return;
      }
      await this.sendFrame(buildBinaryFrame(state.streamId, BINARY_FRAME_END));
      state.peerTerminated = true;
      state.status = "completed";
    } catch (error) {
      if (cancelled() || signal?.aborted) {
        await this.cancelSource(state, state.cancelReason ?? signal?.reason);
        if (!state.peerTerminated) {
          state.peerTerminated = true;
          await this.sendError(state.streamId, state.cancelReason ?? signal?.reason);
        }
        return;
      }
      state.status = "cancelled";
      state.cancelReason = error;
      await this.cancelSource(state, error);
      state.peerTerminated = true;
      await this.sendError(state.streamId, error);
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
      if (state.reader) {
        state.reader.releaseLock();
        state.reader = null;
      }
      this.outgoing.delete(state.streamId);
    }
  }

  /**
   * Resolves with the credit available to the next chunk. Waits for a WINDOW
   * frame when the receiver has consumed everything it allowed, and fails the
   * transfer when no credit arrives within the idle timeout.
   */
  private awaitCredit(state: OutgoingBinaryBodyState): Promise<number> {
    if (state.creditBytes > 0 || state.status === "cancelled") {
      return Promise.resolve(state.creditBytes);
    }
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        state.wake = null;
        reject(new Error(
          `Binary transfer stalled: no receive window for ${this.idleTimeoutMs}ms on stream ${state.streamId}`,
        ));
      }, this.idleTimeoutMs);
      state.wake = () => {
        clearTimeout(timeoutId);
        state.wake = null;
        resolve(state.creditBytes);
      };
    });
  }

  private async cancelOutgoing(
    state: OutgoingBinaryBodyState,
    cause: unknown,
    notifyPeer: boolean,
  ): Promise<void> {
    if (state.status === "cancelled" || state.status === "completed") {
      return;
    }
    const wasSending = state.status === "sending";
    state.status = "cancelled";
    state.cancelReason = cause;
    if (!notifyPeer) {
      state.peerTerminated = true;
    }
    state.wake?.();
    await this.cancelSource(state, cause);
    if (notifyPeer && !state.peerTerminated) {
      state.peerTerminated = true;
      await this.sendError(state.streamId, cause);
    }
    if (!wasSending) {
      this.outgoing.delete(state.streamId);
    }
  }

  private async cancelSource(state: OutgoingBinaryBodyState, cause: unknown): Promise<void> {
    if (state.reader) {
      await state.reader.cancel(cause).catch(() => {});
    } else if (!state.stream.locked) {
      await state.stream.cancel(cause).catch(() => {});
    }
  }

  private async sendError(streamId: number, cause: unknown): Promise<void> {
    await Promise.resolve(this.sendFrame(buildBinaryFrame(
      streamId,
      BINARY_FRAME_ERROR | BINARY_FRAME_END,
      new TextEncoder().encode(cause instanceof Error ? cause.message : String(cause ?? "Binary transfer cancelled")),
    ))).catch(() => {});
  }

  private async sendCancel(streamId: number, cause: unknown): Promise<void> {
    await Promise.resolve(this.sendFrame(buildBinaryFrame(
      streamId,
      BINARY_FRAME_CANCEL | BINARY_FRAME_END,
      new TextEncoder().encode(cause instanceof Error ? cause.message : String(cause ?? "Binary body cancelled")),
    ))).catch(() => {});
  }

  /**
   * Grants the sender enough credit to keep one window in flight beyond what
   * the consumer has already drained. Small top-ups are batched until half a
   * window is owed, unless the sender is out of credit entirely.
   */
  private replenishWindow(streamId: number, pending: PendingBinaryBody): void {
    if (pending.ended) {
      return;
    }
    const increment = pending.consumedBytes + this.windowBytes - pending.grantedBytes;
    if (increment <= 0) {
      return;
    }
    const senderStalled = pending.grantedBytes === pending.receivedBytes;
    if (!senderStalled && increment < Math.ceil(this.windowBytes / 2)) {
      return;
    }
    pending.grantedBytes += increment;
    void Promise.resolve(this.sendFrame(buildWindowFrame(streamId, increment))).catch(() => {});
    this.armReceiveTimeout(streamId, pending);
  }

  private allocateStreamId(): number {
    const streamId = this.nextStreamId;
    this.nextStreamId = streamId + 2 > 0xffffffff ? this.firstStreamId : streamId + 2;
    return streamId;
  }

  /**
   * The sender is only on the clock while it holds credit; a sender waiting
   * for this side to drain is not idle.
   */
  private armReceiveTimeout(streamId: number, pending: PendingBinaryBody): void {
    if (pending.timeoutId !== null) {
      clearTimeout(pending.timeoutId);
      pending.timeoutId = null;
    }
    if (!pending.ended && pending.grantedBytes > pending.receivedBytes) {
      pending.timeoutId = setTimeout(() => {
        this.rejectPending(streamId, new Error(`Binary transfer timed out: ${streamId}`));
      }, this.idleTimeoutMs);
    }
  }

  private clearPending(streamId: number): PendingBinaryBody | null {
    const pending = this.pending.get(streamId) ?? null;
    if (!pending) {
      return null;
    }
    this.pending.delete(streamId);
    if (pending.timeoutId !== null) {
      clearTimeout(pending.timeoutId);
    }
    pending.signal?.removeEventListener("abort", pending.abort);
    return pending;
  }

  private rejectPending(streamId: number, error: Error, notifyPeer = true): void {
    const pending = this.clearPending(streamId);
    pending?.controller.error(error);
    if (pending && notifyPeer) {
      void this.sendCancel(streamId, error);
    }
  }
}

function assertBodyLength(length: number | undefined): void {
  if (length !== undefined && (!Number.isSafeInteger(length) || length < 0)) {
    throw new Error(`Invalid body length: ${length}`);
  }
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(String(signal.reason ?? "Binary body cancelled"));
}
