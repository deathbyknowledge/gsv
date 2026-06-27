import {
  OPEN_APP_EVENT,
  buildOpenAppRoute,
  type OpenAppRequest,
} from "./app-link";
import { getAppBoot, hasAppBoot, type PackageAppBoot } from "./browser";

export type HostStatus = {
  connected: boolean;
};

export type HostStatusHandler = (status: HostStatus) => void;

export type {
  ChatOpenPayload,
  FilesOpenPayload,
  OpenAppEventDetail,
  OpenAppRequest,
  ResolvedOpenAppDetail,
  ShellOpenPayload,
  ThreadContext,
  WikiOpenPayload,
} from "./app-link";

export {
  OPEN_APP_EVENT,
  buildOpenAppRoute,
  normalizeThreadContext,
  resolveOpenAppDetail,
  resolveOpenAppRequest,
} from "./app-link";

export type HostClient = {
  getStatus(): HostStatus;
  onStatus(listener: HostStatusHandler): () => void;
  setTitle(title: string | null): Promise<void>;
  setBadge(badge: string | null): Promise<void>;
  setDirty(dirty: boolean): Promise<void>;
  requestNewWindow(route?: string): Promise<string | null>;
  refreshAppSession(boot: PackageAppBoot): Promise<PackageAppBoot>;
  connectBackendSocket(boot: PackageAppBoot): Promise<HostBackendSocket>;
};

type HostPortMessage =
  | { type: "rpc-result"; id: string; ok: true; data?: unknown }
  | { type: "rpc-result"; id: string; ok: false; error: string }
  | { type: "status"; status: { state?: string } }
  | { type: "backend-message"; connectionId: string; data: string }
  | { type: "backend-close"; connectionId: string; code: number; reason: string; wasClean: boolean }
  | { type: "backend-error"; connectionId: string; error: string };

export type HostBackendCloseEvent = {
  code: number;
  reason: string;
  wasClean: boolean;
};

export type HostBackendSocket = {
  readonly connectionId: string;
  readonly readyState: "open" | "closed";
  send(data: string): Promise<void>;
  close(): void;
  addEventListener(type: "message", listener: (data: string) => void): void;
  addEventListener(type: "close", listener: (event: HostBackendCloseEvent) => void): void;
  addEventListener(type: "error", listener: (error: Error) => void): void;
  removeEventListener(type: "message", listener: (data: string) => void): void;
  removeEventListener(type: "close", listener: (event: HostBackendCloseEvent) => void): void;
  removeEventListener(type: "error", listener: (error: Error) => void): void;
};

type HostBackendSocketRecord = {
  state: "open" | "closed";
  messageListeners: Set<(data: string) => void>;
  closeListeners: Set<(event: HostBackendCloseEvent) => void>;
  errorListeners: Set<(error: Error) => void>;
};

const HOST_CONNECT_REQUEST = "gsv-host-connect-request";
const HOST_CONNECT_RESPONSE = "gsv-host-connect";

let hostClientPromise: Promise<HostClient> | null = null;

export function getAppClientId(): string {
  try {
    if (hasAppBoot()) {
      return getAppBoot().clientId.trim();
    }
  } catch {
    return "";
  }
  return "";
}

export function openApp(request: OpenAppRequest): void {
  const detail = { request };
  try {
    if (window.parent && window.parent !== window) {
      const route = buildOpenAppRoute(request, window.location.href);
      void connectHost()
        .then((host) => host.requestNewWindow(route))
        .catch(() => {
          try {
            window.parent.postMessage({ type: OPEN_APP_EVENT, detail }, "*");
            window.parent.dispatchEvent(new CustomEvent(OPEN_APP_EVENT, { detail }));
          } catch {
            window.location.href = route;
          }
        });
      return;
    }
  } catch {
    // Fall back to same-window navigation outside the shell host.
  }
  window.location.href = buildOpenAppRoute(request, window.location.href);
}

function toHostStatus(value: { state?: string } | undefined): HostStatus {
  return { connected: value?.state === "connected" };
}

function createHostConnectRequestId(): string {
  return `host-connect-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function createHostClient(): Promise<HostClient> {
  const port = await new Promise<MessagePort>((resolve, reject) => {
    let timeoutId = 0;
    const requestId = createHostConnectRequestId();

    const onMessage = (event: MessageEvent): void => {
      if (event.source !== window.parent) {
        return;
      }
      const record = event.data as { requestId?: unknown; type?: unknown } | null;
      if (!record || record.type !== HOST_CONNECT_RESPONSE || !event.ports[0]) {
        return;
      }
      if (record.requestId !== requestId) {
        return;
      }
      window.clearTimeout(timeoutId);
      window.removeEventListener("message", onMessage);
      resolve(event.ports[0]);
    };

    timeoutId = window.setTimeout(() => {
      window.removeEventListener("message", onMessage);
      reject(new Error("Timed out waiting for GSV host bridge"));
    }, 5000);

    window.addEventListener("message", onMessage);
    try {
      window.parent?.postMessage(
        {
          type: HOST_CONNECT_REQUEST,
          requestId,
          ...(hasAppBoot() ? { boot: getAppBoot() } : {}),
        },
        "*",
      );
    } catch {
      // The timeout above reports hosts that cannot accept bridge requests.
    }
  });

  let sequence = 0;
  let latestStatus: HostStatus = { connected: false };
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const statusListeners = new Set<HostStatusHandler>();
  const backendSockets = new Map<string, HostBackendSocketRecord>();

  const rpc = <T>(method: string, payload?: unknown): Promise<T> => {
    const id = `host-rpc-${++sequence}`;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      port.postMessage({ type: "rpc", id, method, payload });
    });
  };

  port.onmessage = (event: MessageEvent<HostPortMessage>) => {
    const message = event.data;
    if (!message || typeof message !== "object") {
      return;
    }

    if (message.type === "rpc-result") {
      const request = pending.get(message.id);
      if (!request) {
        return;
      }
      pending.delete(message.id);
      if (message.ok) {
        request.resolve(message.data);
      } else {
        request.reject(new Error(message.error));
      }
      return;
    }

    if (message.type === "status") {
      latestStatus = toHostStatus(message.status);
      for (const listener of statusListeners) {
        listener(latestStatus);
      }
      return;
    }

    if (message.type === "backend-message") {
      const socket = backendSockets.get(message.connectionId);
      if (!socket || socket.state === "closed") {
        return;
      }
      for (const listener of socket.messageListeners) {
        listener(message.data);
      }
      return;
    }

    if (message.type === "backend-close") {
      const socket = backendSockets.get(message.connectionId);
      if (!socket) {
        return;
      }
      socket.state = "closed";
      backendSockets.delete(message.connectionId);
      const closeEvent = {
        code: message.code,
        reason: message.reason,
        wasClean: message.wasClean,
      };
      for (const listener of socket.closeListeners) {
        listener(closeEvent);
      }
      return;
    }

    if (message.type === "backend-error") {
      const socket = backendSockets.get(message.connectionId);
      if (!socket || socket.state === "closed") {
        return;
      }
      const error = new Error(message.error);
      for (const listener of socket.errorListeners) {
        listener(error);
      }
      return;
    }

    void message;
  };
  port.start();

  const createHostBackendSocket = (connectionId: string): HostBackendSocket => {
    const record: HostBackendSocketRecord = {
      state: "open",
      messageListeners: new Set(),
      closeListeners: new Set(),
      errorListeners: new Set(),
    };
    backendSockets.set(connectionId, record);
    return {
      connectionId,
      get readyState() {
        return record.state;
      },
      send: async (data) => {
        if (record.state === "closed") {
          throw new Error("package backend socket is closed");
        }
        await rpc("backend.send", { connectionId, data });
      },
      close: () => {
        if (record.state === "closed") {
          return;
        }
        record.state = "closed";
        backendSockets.delete(connectionId);
        void rpc("backend.close", { connectionId }).catch(() => {});
      },
      addEventListener: (type, listener) => {
        if (type === "message") {
          record.messageListeners.add(listener as (data: string) => void);
          return;
        }
        if (type === "close") {
          record.closeListeners.add(listener as (event: HostBackendCloseEvent) => void);
          return;
        }
        record.errorListeners.add(listener as (error: Error) => void);
      },
      removeEventListener: (type, listener) => {
        if (type === "message") {
          record.messageListeners.delete(listener as (data: string) => void);
          return;
        }
        if (type === "close") {
          record.closeListeners.delete(listener as (event: HostBackendCloseEvent) => void);
          return;
        }
        record.errorListeners.delete(listener as (error: Error) => void);
      },
    };
  };

  return {
    getStatus: () => latestStatus,
    onStatus: (listener) => {
      statusListeners.add(listener);
      listener(latestStatus);
      return () => {
        statusListeners.delete(listener);
      };
    },
    setTitle: async (title) => {
      await rpc("setTitle", { title });
    },
    setBadge: async (badge) => {
      await rpc("setBadge", { badge });
    },
    setDirty: async (dirty) => {
      await rpc("setDirty", { dirty });
    },
    requestNewWindow: async (route) => {
      const result = await rpc<{ windowId?: unknown }>("requestNewWindow", { route });
      return typeof result.windowId === "string" ? result.windowId : null;
    },
    refreshAppSession: async (boot) => {
      return await rpc<PackageAppBoot>("appSession.refresh", { boot });
    },
    connectBackendSocket: async (boot) => {
      const result = await rpc<{ connectionId?: unknown }>("backend.connect", { boot });
      if (typeof result.connectionId !== "string") {
        throw new Error("package backend bridge returned an invalid connection");
      }
      return createHostBackendSocket(result.connectionId);
    },
  };
}

export async function connectHost(): Promise<HostClient> {
  hostClientPromise ??= createHostClient().catch((error) => {
    hostClientPromise = null;
    throw error;
  });
  return hostClientPromise;
}
