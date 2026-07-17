const WINDOW_MS = 60 * 1000;
const MAX_OPEN_CONNECTIONS = 128;
const MAX_PENDING_MESSAGES_PER_WINDOW = 30;
const MAX_CONNECTED_MESSAGES_PER_WINDOW = 600;
const MAX_TENANT_MESSAGES_PER_WINDOW = 3_000;

export const MAX_JSON_FRAME_BYTES = 256 * 1024;
export const MAX_BINARY_FRAME_BYTES = 1024 * 1024 + 5;

type WindowCounter = {
  startedAt: number;
  count: number;
};

export type WebSocketAdmissionResult =
  | { admitted: true }
  | { admitted: false; reason: "connection_limit" | "frame_too_large" | "message_rate" };

export class WebSocketAdmission {
  private readonly connections = new Map<string, WindowCounter>();
  private tenant: WindowCounter = { startedAt: 0, count: 0 };

  open(connectionId: string, now = Date.now()): WebSocketAdmissionResult {
    if (this.connections.has(connectionId)) return { admitted: true };
    if (this.connections.size >= MAX_OPEN_CONNECTIONS) {
      return { admitted: false, reason: "connection_limit" };
    }
    this.connections.set(connectionId, { startedAt: now, count: 0 });
    return { admitted: true };
  }

  close(connectionId: string): void {
    this.connections.delete(connectionId);
  }

  admit(
    connectionId: string,
    phase: "pending" | "connected",
    kind: "json" | "binary",
    bytes: number,
    now = Date.now(),
  ): WebSocketAdmissionResult {
    const connection = this.connections.get(connectionId);
    if (!connection) return { admitted: false, reason: "connection_limit" };
    const byteLimit = kind === "json" ? MAX_JSON_FRAME_BYTES : MAX_BINARY_FRAME_BYTES;
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > byteLimit) {
      return { admitted: false, reason: "frame_too_large" };
    }

    resetCounter(connection, now);
    resetCounter(this.tenant, now);
    const connectionLimit = phase === "pending"
      ? MAX_PENDING_MESSAGES_PER_WINDOW
      : MAX_CONNECTED_MESSAGES_PER_WINDOW;
    if (connection.count >= connectionLimit || this.tenant.count >= MAX_TENANT_MESSAGES_PER_WINDOW) {
      return { admitted: false, reason: "message_rate" };
    }
    connection.count += 1;
    this.tenant.count += 1;
    return { admitted: true };
  }
}

export function webSocketMessageSize(message: string | ArrayBuffer | ArrayBufferView): {
  kind: "json" | "binary";
  bytes: number;
} {
  if (typeof message === "string") {
    if (message.length > MAX_JSON_FRAME_BYTES) {
      return { kind: "json", bytes: message.length };
    }
    return { kind: "json", bytes: new TextEncoder().encode(message).byteLength };
  }
  return { kind: "binary", bytes: message.byteLength };
}

function resetCounter(counter: WindowCounter, now: number): void {
  if (now < counter.startedAt || now - counter.startedAt >= WINDOW_MS) {
    counter.startedAt = now;
    counter.count = 0;
  }
}
