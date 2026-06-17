import {
  OPEN_APP_EVENT,
  buildOpenAppRoute,
  type OpenAppRequest,
} from "./app-link";
import { getAppBoot, hasAppBoot } from "./browser";

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
};

type HostPortMessage =
  | { type: "rpc-result"; id: string; ok: true; data?: unknown }
  | { type: "rpc-result"; id: string; ok: false; error: string }
  | { type: "status"; status: { state?: string } };

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
      window.parent.postMessage({ type: OPEN_APP_EVENT, detail }, window.location.origin);
      window.parent.dispatchEvent(new CustomEvent(OPEN_APP_EVENT, { detail }));
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
      if (event.origin !== window.location.origin) {
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
        },
        window.location.origin,
      );
    } catch {
      // The timeout above reports hosts that cannot accept bridge requests.
    }
  });

  let sequence = 0;
  let latestStatus: HostStatus = { connected: false };
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const statusListeners = new Set<HostStatusHandler>();

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

    void message;
  };
  port.start();

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
  };
}

export async function connectHost(): Promise<HostClient> {
  hostClientPromise ??= createHostClient().catch((error) => {
    hostClientPromise = null;
    throw error;
  });
  return hostClientPromise;
}
