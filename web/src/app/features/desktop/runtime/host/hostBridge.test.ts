import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GsvClientStatus } from "@humansandmachines/gsv/client";
import { attachHostBridge } from "./hostBridge";

type IframeMock = HTMLIFrameElement & {
  dispatchLoad(): void;
};

let windowListeners: Map<string, Set<EventListenerOrEventListenerObject>>;

beforeEach(() => {
  windowListeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  vi.stubGlobal("window", {
    location: { href: "http://localhost/shell", origin: "http://localhost" },
    addEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
      const typeListeners = windowListeners.get(type) ?? new Set<EventListenerOrEventListenerObject>();
      typeListeners.add(listener);
      windowListeners.set(type, typeListeners);
    }),
    removeEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
      windowListeners.get(type)?.delete(listener);
    }),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function createHostStatusClient() {
  return {
    onStatus: (listener: (status: GsvClientStatus) => void) => {
      listener({
        state: "connected",
        url: "ws://gateway.test",
        username: "alice",
        connectionId: "conn",
        message: null,
      });
      return () => {};
    },
    call: vi.fn(),
    proc: {
      spawn: vi.fn(),
      send: vi.fn(),
      history: vi.fn(),
    },
  };
}

function createIframeMock(
  postMessage: (message: unknown, targetOrigin: string, ports?: Transferable[]) => void,
): IframeMock {
  const listeners = new Set<() => void>();
  return {
    contentWindow: { postMessage },
    addEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
      if (type !== "load") {
        return;
      }
      listeners.add(typeof listener === "function" ? listener as () => void : () => listener.handleEvent({ type: "load" } as Event));
    }),
    removeEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
      if (type !== "load") {
        return;
      }
      if (typeof listener === "function") {
        listeners.delete(listener as () => void);
      }
    }),
    dispatchLoad: () => {
      for (const listener of listeners) {
        listener();
      }
    },
  } as unknown as IframeMock;
}

function dispatchWindowMessage(event: Partial<MessageEvent<unknown>>): void {
  for (const listener of windowListeners.get("message") ?? []) {
    if (typeof listener === "function") {
      listener(event as MessageEvent<unknown>);
    } else {
      listener.handleEvent(event as MessageEvent<unknown>);
    }
  }
}

const APP_SESSION = {
  sessionId: "session-1",
  clientId: "client-1",
  routeBase: "/apps/sessions/session-1/clients/client-1",
  rpcBase: "/apps/sessions/session-1/clients/client-1/socket",
};

async function connectBridge(
  gatewayClient: Parameters<typeof attachHostBridge>[1],
): Promise<{ controller: ReturnType<typeof attachHostBridge>; port: MessagePort }> {
  let hostMessage: unknown = null;
  let hostPorts: readonly MessagePort[] = [];
  const iframe = createIframeMock((message: unknown, _targetOrigin: string, ports?: Transferable[]) => {
    hostMessage = message;
    hostPorts = (ports ?? []) as MessagePort[];
  });

  const controller = attachHostBridge(iframe, gatewayClient);
  iframe.dispatchLoad();

  expect(hostMessage).toMatchObject({ type: "gsv-host-connect" });
  expect(hostPorts[0]).toBeInstanceOf(MessagePort);
  const port = hostPorts[0] as MessagePort;
  port.start();
  return { controller, port };
}

async function connectPackageBridge(
  gatewayClient: Parameters<typeof attachHostBridge>[1],
): Promise<{ controller: ReturnType<typeof attachHostBridge>; port: MessagePort }> {
  let hostMessage: unknown = null;
  let hostPorts: readonly MessagePort[] = [];
  const iframe = createIframeMock((message: unknown, _targetOrigin: string, ports?: Transferable[]) => {
    hostMessage = message;
    hostPorts = (ports ?? []) as MessagePort[];
  });
  const iframeWindow = iframe.contentWindow;

  const controller = attachHostBridge(iframe, gatewayClient, null, APP_SESSION);
  iframe.dispatchLoad();
  dispatchWindowMessage({
    origin: "null",
    source: iframeWindow,
    data: {
      type: "gsv-host-connect-request",
      requestId: "package-bridge",
      boot: {
        sessionId: APP_SESSION.sessionId,
        clientId: APP_SESSION.clientId,
      },
    },
  });

  expect(hostMessage).toMatchObject({
    type: "gsv-host-connect",
    requestId: "package-bridge",
  });
  expect(hostPorts[0]).toBeInstanceOf(MessagePort);
  const port = hostPorts[0] as MessagePort;
  port.start();
  return { controller, port };
}

function rpc(port: MessagePort, method: string, payload?: unknown): Promise<unknown> {
  const id = `test-${method}`;
  return new Promise((resolve) => {
    const previousHandler = port.onmessage;
    port.onmessage = (event: MessageEvent) => {
      const record = event.data as { id?: string } | null;
      if (record?.id === id) {
        port.onmessage = previousHandler;
        resolve(event.data);
      }
    };
    port.postMessage({
      type: "rpc",
      id,
      method,
      payload,
    });
  });
}

function waitForPortMessage(
  port: MessagePort,
  predicate: (value: unknown) => boolean,
): Promise<unknown> {
  return new Promise((resolve) => {
    const listener = (event: MessageEvent<unknown>) => {
      if (!predicate(event.data)) {
        return;
      }
      port.removeEventListener("message", listener);
      resolve(event.data);
    };
    port.addEventListener("message", listener);
  });
}

async function rpcThroughListener(
  port: MessagePort,
  method: string,
  payload?: unknown,
  transfer: Transferable[] = [],
): Promise<unknown> {
  const id = `listener-${method}`;
  const response = waitForPortMessage(port, (value) => (
    (value as { type?: string; id?: string }).type === "rpc-result"
    && (value as { id?: string }).id === id
  ));
  port.postMessage({ type: "rpc", id, method, payload }, transfer);
  return await response;
}

describe("attachHostBridge", () => {
  it("rejects removed syscall bridge methods without calling the gateway client", async () => {
    const gatewayClient = createHostStatusClient();
    const { controller, port } = await connectBridge(gatewayClient);

    for (const method of ["call", "spawnProcess", "sendMessage", "getHistory"]) {
      const result = await rpc(port, method, { call: "proc.spawn", args: {} });
      expect(result).toMatchObject({
        type: "rpc-result",
        id: `test-${method}`,
        ok: false,
      });
    }

    expect(gatewayClient.call).not.toHaveBeenCalled();
    expect(gatewayClient.proc.spawn).not.toHaveBeenCalled();
    expect(gatewayClient.proc.send).not.toHaveBeenCalled();
    expect(gatewayClient.proc.history).not.toHaveBeenCalled();

    controller.destroy();
    port.close();
  });

  it("still handles window chrome RPCs", async () => {
    const gatewayClient = createHostStatusClient();
    const chrome = {
      setTitle: vi.fn(),
      setBadge: vi.fn(),
      setDirty: vi.fn(),
      requestNewWindow: vi.fn(() => "window-2"),
    };
    let hostPorts: readonly MessagePort[] = [];
    const iframe = createIframeMock((_message: unknown, _targetOrigin: string, ports?: Transferable[]) => {
      hostPorts = (ports ?? []) as MessagePort[];
    });

    const controller = attachHostBridge(iframe, gatewayClient, chrome);
    iframe.dispatchLoad();
    const port = hostPorts[0] as MessagePort;
    port.start();

    const titleResult = await rpc(port, "setTitle", { title: "Chat" });
    const windowResult = await rpc(port, "requestNewWindow", { route: "/apps/files/" });

    expect(titleResult).toMatchObject({ ok: true });
    expect(windowResult).toMatchObject({ ok: true, data: { windowId: "window-2" } });
    expect(chrome.setTitle).toHaveBeenCalledWith("Chat");
    expect(chrome.requestNewWindow).toHaveBeenCalledWith("/apps/files/");

    controller.destroy();
    port.close();
  });

  it("accepts opaque-origin connect requests only from the exact iframe window", () => {
    const gatewayClient = createHostStatusClient();
    let hostMessage: unknown = null;
    const iframe = createIframeMock((message: unknown) => {
      hostMessage = message;
    });
    const iframeWindow = iframe.contentWindow;

    const controller = attachHostBridge(iframe, gatewayClient);
    dispatchWindowMessage({
      origin: "null",
      source: { postMessage: vi.fn() } as unknown as MessageEventSource,
      data: {
        type: "gsv-host-connect-request",
        requestId: "wrong-source",
      },
    });
    dispatchWindowMessage({
      origin: "null",
      source: iframeWindow,
      data: {
        type: "gsv-host-connect-request",
        requestId: "opaque-request",
      },
    });

    iframe.dispatchLoad();

    expect(hostMessage).toMatchObject({
      type: "gsv-host-connect",
      requestId: "opaque-request",
    });

    controller.destroy();
  });

  it("requires matching app session data before handing a port to package frames", () => {
    const gatewayClient = createHostStatusClient();
    const hostMessages: unknown[] = [];
    const iframe = createIframeMock((message: unknown) => {
      hostMessages.push(message);
    });
    const iframeWindow = iframe.contentWindow;

    const controller = attachHostBridge(iframe, gatewayClient, null, APP_SESSION);
    iframe.dispatchLoad();

    dispatchWindowMessage({
      origin: "null",
      source: iframeWindow,
      data: {
        type: "gsv-host-connect-request",
        requestId: "missing-boot",
      },
    });
    dispatchWindowMessage({
      origin: "null",
      source: iframeWindow,
      data: {
        type: "gsv-host-connect-request",
        requestId: "wrong-boot",
        boot: { sessionId: "session-1", clientId: "other-client" },
      },
    });
    dispatchWindowMessage({
      origin: "null",
      source: iframeWindow,
      data: {
        type: "gsv-host-connect-request",
        requestId: "matching-boot",
        boot: { sessionId: "session-1", clientId: "client-1" },
      },
    });

    expect(hostMessages).toHaveLength(1);
    expect(hostMessages[0]).toMatchObject({
      type: "gsv-host-connect",
      requestId: "matching-boot",
    });

    controller.destroy();
  });

  it("refuses bridge reconnects after the iframe navigates", () => {
    const gatewayClient = createHostStatusClient();
    const hostMessages: unknown[] = [];
    const iframe = createIframeMock((message: unknown) => {
      hostMessages.push(message);
    });
    const iframeWindow = iframe.contentWindow;

    const controller = attachHostBridge(iframe, gatewayClient, null, APP_SESSION);
    dispatchWindowMessage({
      origin: "null",
      source: iframeWindow,
      data: {
        type: "gsv-host-connect-request",
        requestId: "initial",
        boot: { sessionId: "session-1", clientId: "client-1" },
      },
    });
    iframe.dispatchLoad();
    iframe.dispatchLoad();
    dispatchWindowMessage({
      origin: "null",
      source: iframeWindow,
      data: {
        type: "gsv-host-connect-request",
        requestId: "after-navigation",
        boot: { sessionId: "session-1", clientId: "client-1" },
      },
    });

    expect(hostMessages).toHaveLength(1);
    expect(hostMessages[0]).toMatchObject({
      type: "gsv-host-connect",
      requestId: "initial",
    });

    controller.destroy();
  });

  it("proxies same-session package fetches through the host", async () => {
    const gatewayClient = createHostStatusClient();
    const fetchMock = vi.fn(async (request: Request) => {
      expect(request.url).toBe("http://localhost/apps/sessions/session-1/clients/client-1/api/notes");
      expect(request.method).toBe("POST");
      expect(request.credentials).toBe("same-origin");
      expect(request.redirect).toBe("error");
      expect(request.headers.get("content-type")).toBe("text/plain");
      expect(request.headers.get("x-package")).toBe("yes");
      expect(request.headers.get("cookie")).toBeNull();
      expect(request.headers.get("authorization")).toBeNull();
      expect(await request.text()).toBe("hello");
      return new Response("ok", {
        status: 202,
        statusText: "Accepted",
        headers: {
          "set-cookie": "gsv_session=bad",
          "x-test": "1",
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { controller, port } = await connectPackageBridge(gatewayClient);

    const result = await rpc(port, "appSession.fetch", {
      boot: APP_SESSION,
      request: {
        url: `${APP_SESSION.routeBase}/api/notes`,
        method: "POST",
        headers: [
          ["content-type", "text/plain"],
          ["x-package", "yes"],
          ["cookie", "bad=1"],
          ["authorization", "Bearer bad"],
        ],
        body: new TextEncoder().encode("hello").buffer,
      },
    }) as { ok: boolean; data?: { body?: ArrayBuffer; headers?: string[][]; status?: number; statusText?: string } };

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      status: 202,
      statusText: "Accepted",
      headers: expect.arrayContaining([["x-test", "1"]]),
    });
    expect(result.data?.headers).not.toEqual(expect.arrayContaining([
      ["set-cookie", "gsv_session=bad"],
    ]));
    expect(new TextDecoder().decode(result.data?.body)).toBe("ok");

    controller.destroy();
    port.close();
  });

  it("rejects package fetches outside the app session", async () => {
    const gatewayClient = createHostStatusClient();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { controller, port } = await connectPackageBridge(gatewayClient);

    const result = await rpc(port, "appSession.fetch", {
      boot: APP_SESSION,
      request: {
        url: "/ws",
        method: "GET",
        headers: [],
      },
    }) as { ok: boolean; error?: string };

    expect(result.ok).toBe(false);
    expect(result.error).toContain("outside the app session");
    expect(fetchMock).not.toHaveBeenCalled();

    controller.destroy();
    port.close();
  });

  it("relays binary package backend frames through the embedded host bridge", async () => {
    class FakeBackendWebSocket extends EventTarget {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      static instance: FakeBackendWebSocket;

      readyState = FakeBackendWebSocket.CONNECTING;
      binaryType = "blob";
      sent: Array<string | ArrayBuffer> = [];

      constructor() {
        super();
        FakeBackendWebSocket.instance = this;
        queueMicrotask(() => {
          this.readyState = FakeBackendWebSocket.OPEN;
          this.dispatchEvent(new Event("open"));
        });
      }

      send(data: string | ArrayBuffer): void {
        this.sent.push(data);
      }

      close(): void {
        this.readyState = FakeBackendWebSocket.CLOSED;
      }

      receive(data: string | ArrayBuffer): void {
        this.dispatchEvent(new MessageEvent("message", { data }));
      }
    }
    vi.stubGlobal("WebSocket", FakeBackendWebSocket);
    const { controller, port } = await connectPackageBridge(createHostStatusClient());

    const connected = await rpcThroughListener(port, "backend.connect", { boot: APP_SESSION }) as {
      ok: boolean;
      data?: { connectionId?: string };
    };
    expect(connected.ok).toBe(true);
    const connectionId = connected.data?.connectionId;
    expect(connectionId).toBeTruthy();
    const socket = FakeBackendWebSocket.instance;
    expect(socket.binaryType).toBe("arraybuffer");

    const inbound = new Uint8Array([1, 2, 3]).buffer;
    const inboundMessage = waitForPortMessage(port, (value) => (
      (value as { type?: string }).type === "backend-message"
    ));
    socket.receive(inbound);
    const relayed = await inboundMessage as { connectionId: string; data: ArrayBuffer };
    expect(inbound.byteLength).toBe(0);
    expect(relayed.connectionId).toBe(connectionId);
    expect([...new Uint8Array(relayed.data)]).toEqual([1, 2, 3]);

    const outbound = new Uint8Array([4, 5, 6]).buffer;
    const sent = await rpcThroughListener(
      port,
      "backend.send",
      { connectionId, data: outbound },
      [outbound],
    ) as { ok: boolean };
    expect(sent.ok).toBe(true);
    expect(outbound.byteLength).toBe(0);
    expect([...new Uint8Array(socket.sent[0] as ArrayBuffer)]).toEqual([4, 5, 6]);

    controller.destroy();
    port.close();
  });
});
