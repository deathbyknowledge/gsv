import type { ConnectResult } from "@humansandmachines/gsv/protocol/syscalls/system";
import {
  BINARY_FRAME_DATA,
  BINARY_FRAME_END,
  BINARY_FRAME_ERROR,
  buildBinaryFrame,
  parseBinaryFrame,
} from "@humansandmachines/gsv/protocol/binary-frame";
import type { ExtensionConfig } from "../shared/config";
import type { GatewayFrame, GatewayRequestFrame, GatewayResponseFrame } from "../shared/frames";
import { errorFrame, isRequestFrame } from "../shared/frames";

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
};

type PendingBinaryStream = {
  controller: ReadableStreamDefaultController<Uint8Array>;
  timeoutId: ReturnType<typeof setTimeout>;
};

export type GatewayDriverStatus = {
  state: "disconnected" | "connecting" | "connected";
  connectionId: string | null;
  message: string | null;
};

export type GatewayRequestHandler = (frame: GatewayRequestFrame) => Promise<unknown>;

const REQUEST_TIMEOUT_MS = 20_000;
const BINARY_TIMEOUT_MS = 120_000;
const KEEPALIVE_MS = 25_000;
const IMPLEMENTS = ["fs.*", "shell.exec"];

export class GatewayDriverClient {
  private socket: WebSocket | null = null;
  private statusListeners = new Set<(status: GatewayDriverStatus) => void>();
  private pending = new Map<string, PendingRequest>();
  private binaryStreams = new Map<number, PendingBinaryStream>();
  private requestHandler: GatewayRequestHandler | null = null;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private status: GatewayDriverStatus = {
    state: "disconnected",
    connectionId: null,
    message: null,
  };

  onStatus(listener: (status: GatewayDriverStatus) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  getStatus(): GatewayDriverStatus {
    return this.status;
  }

  setRequestHandler(handler: GatewayRequestHandler): void {
    this.requestHandler = handler;
  }

  async connect(config: ExtensionConfig): Promise<ConnectResult> {
    this.disconnect("reconnect");
    this.setStatus({ state: "connecting", connectionId: null, message: "Opening WebSocket..." });

    const socket = await this.openSocket(config.gatewayUrl);
    this.socket = socket;
    this.attachSocket(socket);

    try {
      const result = await this.request<ConnectResult>("sys.connect", {
        protocol: 1,
        client: {
          id: config.deviceId,
          version: "0.2.5",
          platform: "browser-extension",
          role: "driver",
        },
        driver: {
          implements: IMPLEMENTS,
        },
        auth: {
          username: config.username,
          token: config.token,
        },
      });
      this.setStatus({
        state: "connected",
        connectionId: result.server.connectionId,
        message: null,
      });
      this.startKeepalive();
      return result;
    } catch (error) {
      this.disconnect(error instanceof Error ? error.message : "Handshake failed");
      throw error;
    }
  }

  disconnect(reason = "disconnect"): void {
    this.stopKeepalive();
    const socket = this.socket;
    this.socket = null;
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      socket.close(1000, reason);
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error("Disconnected"));
    }
    this.pending.clear();
    for (const stream of this.binaryStreams.values()) {
      clearTimeout(stream.timeoutId);
      stream.controller.error(new Error("Disconnected"));
    }
    this.binaryStreams.clear();
    this.setStatus({ state: "disconnected", connectionId: null, message: reason === "disconnect" ? null : reason });
  }

  sendBinaryFrame(streamId: number, flags: number, payload?: Uint8Array): void {
    const socket = this.requireSocket();
    socket.send(buildBinaryFrame(streamId, flags, payload));
  }

  openBinaryStream(streamId: number, timeoutMs = BINARY_TIMEOUT_MS): {
    stream: ReadableStream<Uint8Array>;
    cancel: (reason?: string) => void;
  } {
    if (!Number.isSafeInteger(streamId) || streamId <= 0 || streamId > 0xffffffff) {
      throw new Error(`Invalid binary stream id: ${streamId}`);
    }
    if (this.binaryStreams.has(streamId)) {
      throw new Error(`Binary stream already pending: ${streamId}`);
    }

    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const timeoutId = setTimeout(() => {
          this.rejectBinaryStream(streamId, `Binary stream timed out: ${streamId}`);
        }, timeoutMs);
        this.binaryStreams.set(streamId, { controller, timeoutId });
      },
      cancel: () => {
        this.clearBinaryStream(streamId);
      },
    });

    return {
      stream,
      cancel: (reason?: string) => {
        this.rejectBinaryStream(streamId, reason ?? "Binary stream cancelled");
      },
    };
  }

  private request<T>(call: string, args: unknown): Promise<T> {
    const id = crypto.randomUUID();
    const socket = this.requireSocket();

    const promise = new Promise<T>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${call} timed out`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timeoutId,
      });
    });

    socket.send(JSON.stringify({ type: "req", id, call, args }));
    return promise;
  }

  private async handleRequest(frame: GatewayRequestFrame): Promise<void> {
    const handler = this.requestHandler;
    if (!handler) {
      this.sendJson(errorFrame(frame.id, 503, "Driver is not ready"));
      return;
    }

    try {
      const data = await handler(frame);
      this.sendJson({ type: "res", id: frame.id, ok: true, data });
    } catch (error) {
      this.sendJson(errorFrame(frame.id, 500, error instanceof Error ? error.message : String(error)));
    }
  }

  private sendJson(frame: GatewayResponseFrame): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }
    socket.send(JSON.stringify(frame));
  }

  private attachSocket(socket: WebSocket): void {
    socket.addEventListener("message", (event) => {
      void this.handleMessage(event.data);
    });
    socket.addEventListener("close", () => {
      if (this.socket === socket) {
        this.disconnect("WebSocket closed");
      }
    });
    socket.addEventListener("error", () => {
      if (this.socket === socket) {
        this.disconnect("WebSocket error");
      }
    });
  }

  private async handleMessage(raw: unknown): Promise<void> {
    const binary = await normalizeBinary(raw);
    if (binary) {
      this.handleBinary(binary);
      return;
    }
    if (typeof raw !== "string") {
      return;
    }

    let frame: GatewayFrame;
    try {
      frame = JSON.parse(raw) as GatewayFrame;
    } catch {
      return;
    }

    if (frame.type === "res") {
      const pending = this.pending.get(frame.id);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timeoutId);
      this.pending.delete(frame.id);
      if (frame.ok) {
        pending.resolve(frame.data);
      } else {
        const error = new Error(frame.error.message) as Error & { code?: number; details?: unknown };
        error.code = frame.error.code;
        error.details = frame.error.details;
        pending.reject(error);
      }
      return;
    }

    if (isRequestFrame(frame)) {
      await this.handleRequest(frame);
    }
  }

  private handleBinary(bytes: ArrayBuffer): void {
    const frame = parseBinaryFrame(bytes);
    if (!frame) {
      return;
    }
    const pending = this.binaryStreams.get(frame.streamId);
    if (!pending) {
      return;
    }

    if ((frame.flags & BINARY_FRAME_ERROR) !== 0) {
      const message = new TextDecoder().decode(frame.payload);
      this.rejectBinaryStream(frame.streamId, message || "Binary stream failed");
      return;
    }

    if ((frame.flags & BINARY_FRAME_DATA) !== 0 && frame.payload.byteLength > 0) {
      pending.controller.enqueue(frame.payload);
    }

    if ((frame.flags & BINARY_FRAME_END) !== 0) {
      pending.controller.close();
      this.clearBinaryStream(frame.streamId);
    }
  }

  private clearBinaryStream(streamId: number): void {
    const pending = this.binaryStreams.get(streamId);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeoutId);
    this.binaryStreams.delete(streamId);
  }

  private rejectBinaryStream(streamId: number, reason: string): void {
    const pending = this.binaryStreams.get(streamId);
    if (!pending) {
      return;
    }
    pending.controller.error(new Error(reason));
    this.clearBinaryStream(streamId);
  }

  private requireSocket(): WebSocket {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket is not connected");
    }
    return this.socket;
  }

  private startKeepalive(): void {
    this.stopKeepalive();
    this.keepaliveTimer = setInterval(() => {
      const socket = this.socket;
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "sig", signal: "device.ping", payload: { at: Date.now() } }));
      }
    }, KEEPALIVE_MS);
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }

  private setStatus(status: GatewayDriverStatus): void {
    this.status = status;
    for (const listener of this.statusListeners) {
      listener(status);
    }
  }

  private async openSocket(url: string): Promise<WebSocket> {
    return await new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      const timeout = setTimeout(() => {
        socket.close();
        reject(new Error("WebSocket connection timed out"));
      }, 15_000);
      socket.addEventListener("open", () => {
        clearTimeout(timeout);
        resolve(socket);
      }, { once: true });
      socket.addEventListener("error", () => {
        clearTimeout(timeout);
        reject(new Error("WebSocket connection failed"));
      }, { once: true });
    });
  }
}

async function normalizeBinary(raw: unknown): Promise<ArrayBuffer | null> {
  if (raw instanceof ArrayBuffer) {
    return raw;
  }
  if (ArrayBuffer.isView(raw)) {
    return raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
  }
  if (typeof Blob !== "undefined" && raw instanceof Blob) {
    return await raw.arrayBuffer();
  }
  return null;
}
