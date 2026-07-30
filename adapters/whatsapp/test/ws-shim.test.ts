import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

import WebSocket, {
  CLOSED,
  OPEN,
  toFetchWebSocketUrl,
  webSocketHandshakeHeaders,
} from "../src/ws-shim";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

class FakeWorkerWebSocket extends EventTarget {
  binaryType: "blob" | "arraybuffer" = "blob";
  readonly accept = vi.fn();
  readonly send = vi.fn();
  readonly close = vi.fn();
}

function upgradeResponse(socket: FakeWorkerWebSocket): Response {
  return {
    status: 101,
    webSocket: socket,
    body: null,
  } as unknown as Response;
}

describe("Workers WebSocket shim", () => {
  it("uses an Upgrade fetch and forwards Origin plus custom headers", async () => {
    const workerSocket = new FakeWorkerWebSocket();
    const fetchMock = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => upgradeResponse(workerSocket));
    vi.stubGlobal("fetch", fetchMock);

    const socket = new WebSocket("wss://web.whatsapp.com/ws/chat?ED=value", {
      origin: "https://web.whatsapp.com",
      headers: { "X-Test": "value", "X-Multi": ["one", "two"] },
      handshakeTimeout: 1_000,
    });
    await once(socket, "open");

    expect(socket.readyState).toBe(OPEN);
    expect(workerSocket.accept).toHaveBeenCalledOnce();
    expect(workerSocket.binaryType).toBe("arraybuffer");
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://web.whatsapp.com/ws/chat?ED=value");
    expect(init).toMatchObject({ method: "GET", redirect: "manual" });
    const headers = new Headers(init?.headers);
    expect(headers.get("upgrade")).toBe("websocket");
    expect(headers.get("origin")).toBe("https://web.whatsapp.com");
    expect(headers.get("x-test")).toBe("value");

    const callback = vi.fn();
    socket.send(new Uint8Array([1, 2, 3]), callback);
    expect(workerSocket.send).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith();
  });

  it("finishes close when a deferred upgrade resolves after cancellation", async () => {
    const workerSocket = new FakeWorkerWebSocket();
    let resolveFetch!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(async () => await new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    })));
    const socket = new WebSocket("wss://web.whatsapp.com/ws/chat");
    const closed = once(socket, "close");

    socket.close();
    resolveFetch(upgradeResponse(workerSocket));
    await closed;

    expect(socket.readyState).toBe(CLOSED);
    expect(workerSocket.close).toHaveBeenCalledWith(1000, "Connection cancelled");
  });

  it("finishes close when a timed-out fetch later returns an upgrade", async () => {
    vi.useFakeTimers();
    const workerSocket = new FakeWorkerWebSocket();
    let resolveFetch!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(async () => await new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    })));
    const socket = new WebSocket("wss://web.whatsapp.com/ws/chat", {
      handshakeTimeout: 10,
    });
    const closed = once(socket, "close");

    await vi.advanceTimersByTimeAsync(10);
    resolveFetch(upgradeResponse(workerSocket));
    await closed;

    expect(socket.readyState).toBe(CLOSED);
  });

  it("validates handshake URL schemes and headers independently", () => {
    expect(toFetchWebSocketUrl("ws://example.com/socket")).toBe(
      "http://example.com/socket",
    );
    expect(() => toFetchWebSocketUrl("https://example.com/socket")).toThrow(
      "must use ws or wss",
    );
    const headers = webSocketHandshakeHeaders({ origin: "https://example.com" });
    expect(headers.get("origin")).toBe("https://example.com");
    expect(headers.get("upgrade")).toBe("websocket");
  });
});
