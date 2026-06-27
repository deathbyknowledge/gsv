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
    location: { origin: "http://localhost" },
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
});
