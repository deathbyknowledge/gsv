import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachHostBridge } from "./host-bridge";
import type { GatewayClientLike } from "./app/services/gateway/gatewayClient";

type IframeMock = HTMLIFrameElement & {
  dispatchLoad(): void;
};

beforeEach(() => {
  const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  vi.stubGlobal("window", {
    location: { origin: "http://localhost" },
    addEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
      const typeListeners = listeners.get(type) ?? new Set<EventListenerOrEventListenerObject>();
      typeListeners.add(listener);
      listeners.set(type, typeListeners);
    }),
    removeEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
      listeners.get(type)?.delete(listener);
    }),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function createGatewayClient(): GatewayClientLike {
  return {
    getStatus: () => ({
      state: "connected",
      url: "ws://gateway.test",
      username: "alice",
      connectionId: "conn",
      message: null,
    }),
    isConnected: () => true,
    onSignal: () => () => {},
    onStatus: (listener) => {
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
    account: {
      create: vi.fn(),
      list: vi.fn(),
    },
    fs: {
      copy: vi.fn(),
    },
    pkg: {
      create: vi.fn(),
    },
    proc: {
      spawn: vi.fn(),
      send: vi.fn(),
      history: vi.fn(),
      media: {
        read: vi.fn(),
      },
      conversation: {
        timeline: vi.fn(),
        generations: vi.fn(),
        generation: {
          manifest: vi.fn(),
        },
      },
    },
    probeSetupMode: vi.fn(),
    setupSystem: vi.fn(),
    bootstrapSystem: vi.fn(),
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

async function connectBridge(
  gatewayClient: GatewayClientLike,
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
    const gatewayClient = createGatewayClient();
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
    const gatewayClient = createGatewayClient();
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
});
