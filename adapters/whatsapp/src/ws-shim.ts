import { EventEmitter } from "node:events";
import {
  readResponseBodyBytes,
  SAFE_MATERIALIZED_MEDIA_PART_BYTES,
} from "../../shared/src/media-body";
import { errorFields, logWhatsApp } from "./logging";

export const CONNECTING = 0;
export const OPEN = 1;
export const CLOSING = 2;
export const CLOSED = 3;

export type WebSocketOptions = {
  origin?: string;
  headers?: Record<string, string | string[] | number | undefined>;
  handshakeTimeout?: number;
  timeout?: number;
  agent?: unknown;
};

export class WebSocket extends EventEmitter {
  static readonly CONNECTING = CONNECTING;
  static readonly OPEN = OPEN;
  static readonly CLOSING = CLOSING;
  static readonly CLOSED = CLOSED;

  private socket: globalThis.WebSocket | null = null;
  private handshakeAbort: AbortController | null = null;
  private handshakeTimer: ReturnType<typeof setTimeout> | undefined;
  private messageTail: Promise<void> = Promise.resolve();
  readyState = CONNECTING;

  constructor(url: string | URL, options?: WebSocketOptions) {
    super();
    this.handshakeAbort = new AbortController();
    const timeout = options?.handshakeTimeout ?? options?.timeout;
    if (timeout && timeout > 0) {
      this.handshakeTimer = setTimeout(() => {
        if (this.readyState !== CONNECTING) return;
        this.readyState = CLOSING;
        this.handshakeAbort?.abort(new Error("WebSocket connection timeout"));
      }, timeout);
    }
    void this.connect(url, options).catch((error) => {
      if (this.readyState === CLOSED) return;
      const wasClosing = this.readyState === CLOSING;
      this.finishClose(wasClosing ? 1000 : 1006, wasClosing ? "" : "Connection failed");
      if (!wasClosing) {
        this.emit(
          "error",
          error instanceof Error ? error : new Error("WebSocket construction failed"),
        );
      }
    });
  }

  send(
    data: string | ArrayBuffer | Uint8Array,
    callback?: (error?: Error) => void,
  ): void {
    try {
      if (!this.socket || this.readyState !== OPEN) {
        callback?.(new Error("WebSocket is not open"));
        return;
      }
      this.socket.send(data);
      callback?.();
    } catch (error) {
      callback?.(error instanceof Error ? error : new Error("WebSocket send failed"));
    }
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === CLOSED || this.readyState === CLOSING) return;
    this.clearHandshakeTimer();
    this.readyState = CLOSING;
    if (this.socket) {
      this.socket.close(code, reason);
    } else {
      this.handshakeAbort?.abort(new Error("WebSocket connection closed"));
    }
  }

  terminate(): void {
    this.close();
  }

  setMaxListeners(_count: number): this {
    return this;
  }

  ping(_data?: unknown, _mask?: boolean, callback?: () => void): void {
    callback?.();
  }

  pong(_data?: unknown, _mask?: boolean, callback?: () => void): void {
    callback?.();
  }

  private async handleMessage(data: unknown): Promise<void> {
    if (data instanceof ArrayBuffer) {
      this.requireMessageSize(data.byteLength);
      this.emit("message", Buffer.from(data));
      return;
    }
    if (data instanceof Blob) {
      this.requireMessageSize(data.size);
      const bytes = await readResponseBodyBytes(new Response(data), {
        maxBytes: SAFE_MATERIALIZED_MEDIA_PART_BYTES,
        expectedBytes: data.size,
        label: "WebSocket message",
      });
      this.emit(
        "message",
        Buffer.from(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength),
      );
      return;
    }
    if (typeof data === "string" || data instanceof Uint8Array) {
      this.requireMessageSize(
        typeof data === "string" ? new TextEncoder().encode(data).byteLength : data.byteLength,
      );
      this.emit("message", data);
      return;
    }
    throw new Error("Unsupported WebSocket message type");
  }

  private async connect(url: string | URL, options?: WebSocketOptions): Promise<void> {
    const response = await fetch(toFetchWebSocketUrl(url), {
      method: "GET",
      headers: webSocketHandshakeHeaders(options),
      redirect: "manual",
      signal: this.handshakeAbort?.signal,
    });
    if (this.readyState !== CONNECTING) {
      response.webSocket?.close(1000, "Connection cancelled");
      await response.body?.cancel().catch(() => undefined);
      this.finishClose(1000, "");
      return;
    }
    if (response.status !== 101 || !response.webSocket) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`WebSocket upgrade failed with HTTP ${response.status}`);
    }

    this.clearHandshakeTimer();
    this.handshakeAbort = null;
    this.socket = response.webSocket;
    this.socket.binaryType = "arraybuffer";
    this.socket.addEventListener("close", (event) => {
      this.finishClose(event.code, event.reason);
    });
    this.socket.addEventListener("error", () => {
      this.emit("error", new Error("WebSocket transport error"));
    });
    this.socket.addEventListener("message", (event) => {
      this.messageTail = this.messageTail
        .then(async () => this.handleMessage(event.data))
        .catch((error) => {
          logWhatsApp("warn", "websocket_message_failed", errorFields(error));
          this.emit("error", error instanceof Error ? error : new Error("WebSocket message failed"));
        });
    });
    this.socket.accept();
    this.readyState = OPEN;
    this.emit("upgrade", response);
    this.emit("open");
  }

  private requireMessageSize(size: number): void {
    if (size <= SAFE_MATERIALIZED_MEDIA_PART_BYTES) return;
    this.close(1009, "Message too large");
    throw new Error("WebSocket message exceeds the adapter limit");
  }

  private clearHandshakeTimer(): void {
    if (this.handshakeTimer !== undefined) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = undefined;
    }
  }

  private finishClose(code: number, reason: string): void {
    if (this.readyState === CLOSED) return;
    this.clearHandshakeTimer();
    this.handshakeAbort = null;
    this.readyState = CLOSED;
    this.emit("close", code, reason);
  }
}

export function webSocketHandshakeHeaders(options?: WebSocketOptions): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(options?.headers ?? {})) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const entry of value) headers.append(name, entry);
    } else {
      headers.set(name, String(value));
    }
  }
  if (options?.origin) headers.set("Origin", options.origin);
  headers.set("Upgrade", "websocket");
  return headers;
}

export function toFetchWebSocketUrl(value: string | URL): string {
  const url = new URL(value.toString());
  if (url.protocol === "wss:") url.protocol = "https:";
  else if (url.protocol === "ws:") url.protocol = "http:";
  else throw new Error("WebSocket URL must use ws or wss");
  return url.toString();
}

export default WebSocket;
