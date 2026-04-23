export type PackageAppBoot = {
  packageId: string;
  packageName: string;
  routeBase: string;
  rpcBase: string;
  sessionId: string;
  sessionSecret: string;
  clientId: string;
  expiresAt: number;
  hasBackend: boolean;
};

type CapnwebGlobal = {
  newWebSocketRpcSession<T = unknown>(url: string, localMain?: unknown): T;
  RpcTarget?: abstract new (...args: unknown[]) => object;
};

type RemoteBackend = {
  invoke(method: string, args?: unknown): Promise<unknown>;
} & Record<string | symbol, unknown>;

type BackendProxyControl = {
  invoke(method: string, args?: unknown): Promise<unknown>;
  reconnect(): Promise<void>;
};

export type AppEventListener = (event: string, payload: unknown) => void;

declare global {
  interface Window {
    __GSV_APP_BOOT__?: PackageAppBoot;
    __GSV_BACKEND_READY__?: Promise<unknown>;
    backend?: unknown;
    capnweb?: CapnwebGlobal;
  }
}

export function getAppBoot(): PackageAppBoot {
  const boot = globalThis.window?.__GSV_APP_BOOT__;
  if (!boot) {
    throw new Error("GSV app bootstrap is unavailable");
  }
  return boot;
}

export function hasAppBoot(): boolean {
  return Boolean(globalThis.window?.__GSV_APP_BOOT__);
}

function getCapnweb(): CapnwebGlobal {
  const capnweb = globalThis.window?.capnweb;
  if (!capnweb || typeof capnweb.newWebSocketRpcSession !== "function") {
    throw new Error("capnweb runtime is unavailable");
  }
  return capnweb;
}

let backendConnectionPromise: Promise<RemoteBackend> | null = null;
let backendProxy: unknown = null;
let appClientTarget: unknown = null;
const appEventListeners = new Set<AppEventListener>();

function isReconnectableBackendError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return normalized.includes("websocket disconnected")
    || normalized.includes("websocket closed")
    || normalized.includes("connection closed")
    || normalized.includes("transport closed")
    || normalized.includes("socket closed")
    || normalized.includes("broken pipe")
    || normalized.includes("rpc stream closed");
}

function resetBackendConnection(): void {
  backendConnectionPromise = null;
  if (globalThis.window) {
    globalThis.window.__GSV_BACKEND_READY__ = undefined;
  }
}

function emitAppEvent(event: string, payload: unknown): void {
  for (const listener of appEventListeners) {
    try {
      listener(event, payload);
    } catch (error) {
      console.warn("[gsv-package] app event listener failed", error);
    }
  }
}

function getOrCreateAppClientTarget(): unknown {
  if (appClientTarget) {
    return appClientTarget;
  }
  const RpcTargetCtor = getCapnweb().RpcTarget;
  if (typeof RpcTargetCtor !== "function") {
    throw new Error("capnweb RpcTarget is unavailable");
  }
  appClientTarget = new class extends RpcTargetCtor {
    async onAppEvent(event: unknown, payload: unknown) {
      const normalizedEvent = typeof event === "string" ? event : String(event ?? "");
      emitAppEvent(normalizedEvent, payload);
    }
  }();
  return appClientTarget;
}

async function connectBackendTransport(): Promise<RemoteBackend> {
  if (backendConnectionPromise) {
    return backendConnectionPromise;
  }
  const boot = getAppBoot();
  if (!boot.hasBackend) {
    throw new Error("package app has no backend rpc");
  }
  const capnweb = getCapnweb();
  const ready = (async () => {
    const session = capnweb.newWebSocketRpcSession<{
      authenticate(secret: string, clientTarget?: unknown): unknown;
    }>(buildRpcWebSocketUrl(boot.rpcBase));
    const backend = await session.authenticate(boot.sessionSecret, getOrCreateAppClientTarget());
    if (!backend || (typeof backend !== "object" && typeof backend !== "function")) {
      throw new Error("package backend rpc returned an invalid target");
    }
    const target = backend as RemoteBackend;
    if (typeof target.invoke !== "function") {
      throw new Error("package backend rpc target is missing invoke()");
    }
    return target;
  })().catch((error) => {
    if (backendConnectionPromise === ready) {
      resetBackendConnection();
    }
    throw error;
  });
  backendConnectionPromise = ready;
  if (globalThis.window) {
    globalThis.window.__GSV_BACKEND_READY__ = ready.then(() => backendProxy ?? null);
  }
  return ready;
}

async function invokeBackend(method: string, args?: unknown): Promise<unknown> {
  try {
    const backend = await connectBackendTransport();
    return await backend.invoke(method, args);
  } catch (error) {
    if (!isReconnectableBackendError(error)) {
      throw error;
    }
  }

  resetBackendConnection();
  const backend = await connectBackendTransport();
  return backend.invoke(method, args);
}

function createBackendProxy<T = unknown>(): T {
  if (backendProxy) {
    return backendProxy as T;
  }
  backendProxy = new Proxy({} as BackendProxyControl, {
    get(_target, prop) {
      if (prop === "then") {
        return undefined;
      }
      if (prop === "invoke") {
        return invokeBackend;
      }
      if (prop === "reconnect") {
        return async () => {
          resetBackendConnection();
          await connectBackendTransport();
        };
      }
      if (typeof prop !== "string") {
        return undefined;
      }
      return (args?: unknown) => invokeBackend(prop, args);
    },
  }) as T;
  if (globalThis.window) {
    globalThis.window.backend = backendProxy;
  }
  return backendProxy as T;
}

function buildRpcWebSocketUrl(rpcBase: string): string {
  const url = new URL(rpcBase, globalThis.window?.location?.href ?? "http://localhost");
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export async function connectBackend<T = unknown>(): Promise<T> {
  const proxy = createBackendProxy<T>();
  await connectBackendTransport();
  return proxy;
}

export async function getBackend<T = unknown>(): Promise<T> {
  return connectBackend<T>();
}

export function onAppEvent(listener: AppEventListener): () => void {
  appEventListeners.add(listener);
  return () => {
    appEventListeners.delete(listener);
  };
}
