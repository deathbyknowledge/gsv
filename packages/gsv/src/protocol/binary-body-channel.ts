import type { BinaryBody } from "./body";
import {
  BINARY_FRAME_CANCEL,
  BINARY_FRAME_DATA,
  BINARY_FRAME_END,
  BINARY_FRAME_ERROR,
  assertStreamId,
  buildBinaryFrame,
  parseBinaryFrame,
  type BinaryFrameDescriptor,
} from "./binary-frame";

const DEFAULT_CHUNK_BYTES = 1024 * 1024;
const DEFAULT_IDLE_TIMEOUT_MS = 120_000;

type PendingBinaryBody = {
  controller: ReadableStreamDefaultController<Uint8Array>;
  timeoutId: ReturnType<typeof setTimeout>;
  expectedBytes?: number;
  receivedBytes: number;
};

type OutgoingBinaryBodyState = {
  streamId: number;
  stream: ReadableStream<Uint8Array>;
  reader: ReadableStreamDefaultReader<Uint8Array> | null;
  status: "prepared" | "sending" | "cancelled" | "completed";
  cancelReason?: unknown;
  peerTerminated: boolean;
};

export type BinaryBodyChannelOptions = {
  sendFrame(frame: ArrayBuffer): void | Promise<void>;
  chunkBytes?: number;
  idleTimeoutMs?: number;
};

export type OutgoingBinaryBody = {
  descriptor: BinaryFrameDescriptor;
  send(signal?: AbortSignal): Promise<void>;
  cancel(reason?: unknown): Promise<void>;
};

/**
 * Streams binary bodies over a transport that carries the shared GSV binary-frame format.
 * The caller must send the returned descriptor in its JSON frame before calling `send()`.
 */
export class BinaryBodyChannel {
  private readonly pending = new Map<number, PendingBinaryBody>();
  private readonly outgoing = new Map<number, OutgoingBinaryBodyState>();
  private readonly sendFrame: BinaryBodyChannelOptions["sendFrame"];
  private readonly chunkBytes: number;
  private readonly idleTimeoutMs: number;
  private nextStreamId = 1;

  constructor(options: BinaryBodyChannelOptions) {
    const chunkBytes = options.chunkBytes ?? DEFAULT_CHUNK_BYTES;
    const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0) {
      throw new Error(`Invalid binary body chunk size: ${options.chunkBytes}`);
    }
    if (!Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs <= 0) {
      throw new Error(`Invalid binary body idle timeout: ${options.idleTimeoutMs}`);
    }
    this.sendFrame = options.sendFrame;
    this.chunkBytes = chunkBytes;
    this.idleTimeoutMs = idleTimeoutMs;
  }

  receive(descriptor: BinaryFrameDescriptor): BinaryBody {
    assertStreamId(descriptor.streamId);
    assertBodyLength(descriptor.length);
    if (this.pending.has(descriptor.streamId)) {
      throw new Error(`Binary stream already pending: ${descriptor.streamId}`);
    }

    const { streamId, length } = descriptor;
    return {
      stream: new ReadableStream<Uint8Array>({
        start: (controller) => {
          this.pending.set(streamId, {
            controller,
            timeoutId: this.receiveTimeout(streamId),
            expectedBytes: length,
            receivedBytes: 0,
          });
        },
        cancel: async (reason) => {
          if (this.clearPending(streamId)) {
            await this.sendCancel(streamId, reason);
          }
        },
      }),
      ...(length === undefined ? {} : { length }),
    };
  }

  handleFrame(data: ArrayBuffer | ArrayBufferView): boolean {
    const frame = parseBinaryFrame(data);
    if (!frame) {
      return false;
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
      clearTimeout(pending.timeoutId);
      pending.timeoutId = this.receiveTimeout(frame.streamId);
      pending.receivedBytes += frame.payload.byteLength;
      if (pending.expectedBytes !== undefined && pending.receivedBytes > pending.expectedBytes) {
        this.rejectPending(
          frame.streamId,
          new Error(`Body exceeded declared length ${pending.expectedBytes}`),
        );
        return true;
      }
      pending.controller.enqueue(frame.payload);
    }
    if ((frame.flags & BINARY_FRAME_END) !== 0) {
      if (pending.expectedBytes !== undefined && pending.receivedBytes !== pending.expectedBytes) {
        this.rejectPending(
          frame.streamId,
          new Error(`Body length ${pending.receivedBytes} did not match ${pending.expectedBytes}`),
        );
        return true;
      }
      this.clearPending(frame.streamId)?.controller.close();
    }
    return true;
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
    };
    this.outgoing.set(streamId, state);
    return {
      descriptor: {
        streamId,
        ...(body.length === undefined ? {} : { length: body.length }),
      },
      send: async (signal) => {
        if (state.status !== "prepared") {
          throw new Error(`Binary body send is ${state.status}: ${streamId}`);
        }
        state.status = "sending";
        await this.sendBody(state, signal);
      },
      cancel: async (reason) => {
        await this.cancelOutgoing(state, reason, true);
      },
    };
  }

  close(reason: unknown = new Error("Binary body channel closed")): void {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    for (const streamId of [...this.pending.keys()]) {
      this.rejectPending(streamId, error, false);
    }
    for (const state of [...this.outgoing.values()]) {
      void this.cancelOutgoing(state, reason, false).catch(() => {});
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
        for (let offset = 0; offset < value.byteLength; offset += this.chunkBytes) {
          if (cancelled()) {
            break sendLoop;
          }
          await this.sendFrame(buildBinaryFrame(
            state.streamId,
            BINARY_FRAME_DATA,
            value.subarray(offset, offset + this.chunkBytes),
          ));
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

  private async cancelOutgoing(
    state: OutgoingBinaryBodyState,
    reason: unknown,
    notifyPeer: boolean,
  ): Promise<void> {
    if (state.status === "cancelled" || state.status === "completed") {
      return;
    }
    const wasSending = state.status === "sending";
    state.status = "cancelled";
    state.cancelReason = reason;
    if (!notifyPeer) {
      state.peerTerminated = true;
    }
    await this.cancelSource(state, reason);
    if (notifyPeer && !state.peerTerminated) {
      state.peerTerminated = true;
      await this.sendError(state.streamId, reason);
    }
    if (!wasSending) {
      this.outgoing.delete(state.streamId);
    }
  }

  private async cancelSource(state: OutgoingBinaryBodyState, reason: unknown): Promise<void> {
    if (state.reader) {
      await state.reader.cancel(reason).catch(() => {});
    } else if (!state.stream.locked) {
      await state.stream.cancel(reason).catch(() => {});
    }
  }

  private async sendError(streamId: number, error: unknown): Promise<void> {
    await Promise.resolve(this.sendFrame(buildBinaryFrame(
      streamId,
      BINARY_FRAME_ERROR | BINARY_FRAME_END,
      new TextEncoder().encode(error instanceof Error ? error.message : String(error ?? "Binary transfer cancelled")),
    ))).catch(() => {});
  }

  private async sendCancel(streamId: number, reason: unknown): Promise<void> {
    await Promise.resolve(this.sendFrame(buildBinaryFrame(
      streamId,
      BINARY_FRAME_CANCEL | BINARY_FRAME_END,
      new TextEncoder().encode(reason instanceof Error ? reason.message : String(reason ?? "Binary body cancelled")),
    ))).catch(() => {});
  }

  private allocateStreamId(): number {
    const streamId = this.nextStreamId;
    this.nextStreamId = streamId === 0xffffffff ? 1 : streamId + 1;
    return streamId;
  }

  private receiveTimeout(streamId: number): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      this.rejectPending(streamId, new Error(`Binary transfer timed out: ${streamId}`));
    }, this.idleTimeoutMs);
  }

  private clearPending(streamId: number): PendingBinaryBody | null {
    const pending = this.pending.get(streamId) ?? null;
    if (!pending) {
      return null;
    }
    this.pending.delete(streamId);
    clearTimeout(pending.timeoutId);
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
