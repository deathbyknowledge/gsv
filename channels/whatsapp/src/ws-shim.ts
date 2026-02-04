/**
 * Shim for the 'ws' package to use native WebSocket in Workers
 * 
 * Baileys uses the 'ws' npm package which is Node.js specific.
 * This shim provides a compatible interface using the native WebSocket API.
 */

import { EventEmitter } from "node:events";

// Re-export WebSocket constants
export const CONNECTING = 0;
export const OPEN = 1;
export const CLOSING = 2;
export const CLOSED = 3;

export class WebSocket extends EventEmitter {
  static CONNECTING = CONNECTING;
  static OPEN = OPEN;
  static CLOSING = CLOSING;
  static CLOSED = CLOSED;

  private ws: globalThis.WebSocket | null = null;
  public readyState: number = CONNECTING;

  constructor(
    url: string | URL,
    options?: {
      origin?: string;
      headers?: Record<string, string>;
      handshakeTimeout?: number;
      timeout?: number;
      agent?: unknown;
    }
  ) {
    super();
    
    const urlString = typeof url === "string" ? url : url.toString();
    console.log(`[ws-shim] Connecting to ${urlString}`);

    try {
      // Native WebSocket doesn't support custom headers in the constructor
      // WhatsApp uses Origin header which we can't set in Workers
      // But let's try anyway - the server might not strictly require it
      this.ws = new globalThis.WebSocket(urlString);
      
      // Ensure binary messages are delivered as ArrayBuffer, not Blob
      this.ws.binaryType = "arraybuffer";
      
      this.ws.addEventListener("open", () => {
        console.log(`[ws-shim] Connection opened`);
        this.readyState = OPEN;
        this.emit("open");
      });

      this.ws.addEventListener("close", (event) => {
        console.log(`[ws-shim] Connection closed: code=${event.code}, reason=${event.reason}`);
        this.readyState = CLOSED;
        this.emit("close", event.code, event.reason);
      });

      this.ws.addEventListener("error", (event) => {
        console.error(`[ws-shim] Connection error:`, event);
        this.emit("error", new Error("WebSocket error"));
      });

      this.ws.addEventListener("message", (event) => {
        // Baileys expects Buffer/Uint8Array for binary messages
        try {
          if (event.data instanceof ArrayBuffer) {
            const size = event.data.byteLength;
            console.log(`[ws-shim] Received ${size} bytes`);
            this.emit("message", Buffer.from(event.data));
          } else if (event.data instanceof Blob) {
            // Convert Blob to ArrayBuffer
            console.log(`[ws-shim] Received Blob: ${event.data.size} bytes`);
            event.data.arrayBuffer().then((buffer) => {
              this.emit("message", Buffer.from(buffer));
            });
          } else if (typeof event.data === "string") {
            // String message
            console.log(`[ws-shim] Received string: ${event.data.length} chars`);
            this.emit("message", event.data);
          } else {
            console.log(`[ws-shim] Received unknown type:`, typeof event.data);
            this.emit("message", event.data);
          }
        } catch (e) {
          console.error(`[ws-shim] Error handling message:`, e);
        }
      });

      // Handle connection timeout
      if (options?.handshakeTimeout || options?.timeout) {
        const timeout = options.handshakeTimeout || options.timeout || 30000;
        setTimeout(() => {
          if (this.readyState === CONNECTING) {
            console.log(`[ws-shim] Connection timeout after ${timeout}ms`);
            this.ws?.close();
            this.emit("error", new Error("Connection timeout"));
          }
        }, timeout);
      }
    } catch (e) {
      console.error(`[ws-shim] Failed to create WebSocket:`, e);
      this.readyState = CLOSED;
      // Emit error async to allow event handlers to be attached
      setTimeout(() => this.emit("error", e), 0);
    }
  }

  send(data: string | ArrayBuffer | Uint8Array, callback?: (err?: Error) => void): void {
    try {
      if (this.ws && this.readyState === OPEN) {
        this.ws.send(data);
        callback?.();
      } else {
        callback?.(new Error("WebSocket is not open"));
      }
    } catch (e) {
      callback?.(e as Error);
    }
  }

  close(code?: number, reason?: string): void {
    this.readyState = CLOSING;
    this.ws?.close(code, reason);
  }

  // No-op methods that 'ws' has but we don't need
  setMaxListeners(_n: number): this {
    return this;
  }

  ping(_data?: unknown, _mask?: boolean, _cb?: () => void): void {
    // Native WebSocket doesn't have ping - it's handled automatically
  }

  pong(_data?: unknown, _mask?: boolean, _cb?: () => void): void {
    // Native WebSocket doesn't have pong - it's handled automatically
  }

  terminate(): void {
    this.close();
  }
}

export default WebSocket;
