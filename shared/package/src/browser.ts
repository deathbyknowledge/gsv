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
  newWebSocketRpcSession<T = unknown>(socket: string | WebSocket, localMain?: unknown): T;
  RpcTarget?: abstract new (...args: unknown[]) => object;
};

type RemoteBackend = {
  invoke(method: string, args?: unknown): Promise<unknown>;
  onRpcBroken?: (callback: (error: unknown) => void) => void;
} & Record<string | symbol, unknown>;

type BackendConnection = {
  backend: RemoteBackend;
  socket: WebSocket;
  broken: boolean;
};

type BackendProxyControl = {
  invoke(method: string, args?: unknown): Promise<unknown>;
  reconnect(): Promise<void>;
};

export type AppEventListener = (event: string, payload: unknown) => void;
export type AppRuntimeStatus = "booting" | "connecting" | "connected" | "loading" | "ready" | "reconnecting" | "error";

type PackageAppRuntimeChrome = {
  setStatus(state: AppRuntimeStatus, message?: string): void;
  setLoading(message?: string): void;
  setReady(): void;
  setError(message?: string): void;
};

declare global {
  interface Window {
    __GSV_APP_BOOT__?: PackageAppBoot;
    __GSV_BACKEND_READY__?: Promise<unknown>;
    __GSV_APP_RUNTIME__?: PackageAppRuntimeChrome;
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

let backendConnectionPromise: Promise<BackendConnection> | null = null;
let backendProxy: unknown = null;
let appClientTarget: unknown = null;
let appSessionRefreshPromise: Promise<PackageAppBoot> | null = null;
let appRuntimeReady = false;
let connectedReadyFallback: ReturnType<typeof setTimeout> | null = null;
const appEventListeners = new Set<AppEventListener>();
const APP_SESSION_REFRESH_LEEWAY_MS = 60_000;
const CONNECTED_READY_FALLBACK_MS = 650;

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultRuntimeMessage(status: AppRuntimeStatus): string {
  switch (status) {
    case "connecting":
      return "Connecting app...";
    case "connected":
      return "Opening app...";
    case "loading":
      return "Loading app...";
    case "ready":
      return "Ready";
    case "reconnecting":
      return "Reconnecting app...";
    case "error":
      return "App unavailable";
    case "booting":
    default:
      return "Booting app...";
  }
}

function clearConnectedReadyFallback(): void {
  if (connectedReadyFallback !== null) {
    clearTimeout(connectedReadyFallback);
    connectedReadyFallback = null;
  }
}

function setDocumentRuntimeStatus(status: AppRuntimeStatus, message?: string): void {
  const resolvedMessage = message ?? defaultRuntimeMessage(status);
  const root = globalThis.document?.documentElement;
  if (root) {
    root.dataset.gsvRuntimeState = status;
    root.dataset.gsvRuntimeMessage = resolvedMessage;
    if (status === "ready") {
      root.dataset.gsvAppReady = "true";
    } else if (status === "loading" || status === "error") {
      delete root.dataset.gsvAppReady;
    }
  }
  if (globalThis.document?.body) {
    globalThis.document.body.dataset.gsvRuntimeMessage = resolvedMessage;
  }
}

function runtimeChrome(): PackageAppRuntimeChrome | null {
  return globalThis.window?.__GSV_APP_RUNTIME__ ?? null;
}

function setRuntimeStatus(status: AppRuntimeStatus, message?: string): void {
  const resolvedMessage = message ?? defaultRuntimeMessage(status);
  runtimeChrome()?.setStatus(status, resolvedMessage);
  setDocumentRuntimeStatus(status, resolvedMessage);
}

export function setAppStatus(status: AppRuntimeStatus, message?: string): void {
  if (status === "ready") {
    setAppReady();
    return;
  }
  if (status === "loading") {
    setAppLoading(message);
    return;
  }
  if (status === "error") {
    setAppError(message ?? defaultRuntimeMessage("error"));
    return;
  }
  setRuntimeStatus(status, message);
}

function scheduleConnectedReadyFallback(): void {
  clearConnectedReadyFallback();
  connectedReadyFallback = setTimeout(() => {
    connectedReadyFallback = null;
    if (!appRuntimeReady) {
      setAppReady();
    }
  }, CONNECTED_READY_FALLBACK_MS);
}

export function setAppLoading(message?: string): void {
  appRuntimeReady = false;
  clearConnectedReadyFallback();
  const resolvedMessage = message ?? defaultRuntimeMessage("loading");
  runtimeChrome()?.setLoading(resolvedMessage);
  setDocumentRuntimeStatus("loading", resolvedMessage);
}

export function setAppReady(): void {
  appRuntimeReady = true;
  clearConnectedReadyFallback();
  runtimeChrome()?.setReady();
  setDocumentRuntimeStatus("ready", defaultRuntimeMessage("ready"));
}

export function setAppError(error: unknown): void {
  appRuntimeReady = false;
  clearConnectedReadyFallback();
  const message = formatErrorMessage(error);
  runtimeChrome()?.setError(message);
  setDocumentRuntimeStatus("error", message);
}

class BackendTransportClosedError extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "BackendTransportClosedError";
    this.cause = cause;
  }
}

function resetBackendConnection(): void {
  const previousConnection = backendConnectionPromise;
  backendConnectionPromise = null;
  if (globalThis.window) {
    globalThis.window.__GSV_BACKEND_READY__ = undefined;
  }
  void previousConnection
    ?.then((connection) => closeBackendSocket(connection.socket))
    .catch(() => {});
}

function closeBackendSocket(socket: WebSocket): void {
  if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) {
    socket.close(1000, "client reconnect");
  }
}

function shouldRetryBackendCall(connection: BackendConnection | null, error: unknown): boolean {
  return error instanceof BackendTransportClosedError
    || Boolean(connection?.broken)
    || Boolean(connection && connection.socket.readyState !== WebSocket.OPEN);
}

function isPackageAppBoot(value: unknown): value is PackageAppBoot {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<PackageAppBoot>;
  return typeof candidate.packageId === "string"
    && typeof candidate.packageName === "string"
    && typeof candidate.routeBase === "string"
    && typeof candidate.rpcBase === "string"
    && typeof candidate.sessionId === "string"
    && typeof candidate.sessionSecret === "string"
    && typeof candidate.clientId === "string"
    && typeof candidate.expiresAt === "number"
    && typeof candidate.hasBackend === "boolean";
}

function shouldRefreshAppSession(boot: PackageAppBoot): boolean {
  return boot.expiresAt <= Date.now() + APP_SESSION_REFRESH_LEEWAY_MS;
}

async function refreshAppSession(boot: PackageAppBoot): Promise<PackageAppBoot> {
  if (appSessionRefreshPromise) {
    return appSessionRefreshPromise;
  }

  const refresh = (async () => {
    const response = await fetch(buildRpcSessionRefreshUrl(boot), {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "content-type": "application/json",
        "accept": "application/json",
      },
      body: JSON.stringify({ clientId: boot.clientId }),
    });

    if (!response.ok) {
      const message = await response.text().catch(() => "");
      throw new Error(message || `package app session refresh failed (${response.status})`);
    }

    const nextBoot = await response.json();
    if (!isPackageAppBoot(nextBoot)) {
      throw new Error("package app session refresh returned an invalid bootstrap payload");
    }
    if (!nextBoot.hasBackend) {
      throw new Error("package app has no backend rpc");
    }

    if (globalThis.window) {
      globalThis.window.__GSV_APP_BOOT__ = nextBoot;
    }
    return nextBoot;
  })().finally(() => {
    if (appSessionRefreshPromise === refresh) {
      appSessionRefreshPromise = null;
    }
  });

  appSessionRefreshPromise = refresh;
  return refresh;
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

async function connectBackendTransport(): Promise<BackendConnection> {
  if (backendConnectionPromise) {
    return backendConnectionPromise;
  }
  setRuntimeStatus(appRuntimeReady ? "reconnecting" : "connecting");
  let boot = getAppBoot();
  if (!boot.hasBackend) {
    const error = new Error("package app has no backend rpc");
    setAppError(error);
    throw error;
  }
  if (shouldRefreshAppSession(boot)) {
    boot = await refreshAppSession(boot);
  }
  const capnweb = getCapnweb();
  const socket = new WebSocket(buildRpcWebSocketUrl(boot.rpcBase));
  let connection: BackendConnection | null = null;
  let ready: Promise<BackendConnection>;
  let transportBroken = socket.readyState === WebSocket.CLOSING || socket.readyState === WebSocket.CLOSED;
  const markTransportBroken = () => {
    transportBroken = true;
    if (connection) {
      connection.broken = true;
    }
    if (backendConnectionPromise === ready) {
      resetBackendConnection();
    }
  };
  socket.addEventListener("close", markTransportBroken);
  socket.addEventListener("error", markTransportBroken);

  ready = (async () => {
    const session = capnweb.newWebSocketRpcSession<{
      authenticate(secret: string, clientTarget?: unknown): unknown;
    }>(socket);
    const backend = await session.authenticate(boot.sessionSecret, getOrCreateAppClientTarget());
    if (!backend || (typeof backend !== "object" && typeof backend !== "function")) {
      throw new Error("package backend rpc returned an invalid target");
    }
    const target = backend as RemoteBackend;
    if (typeof target.invoke !== "function") {
      throw new Error("package backend rpc target is missing invoke()");
    }
    connection = {
      backend: target,
      socket,
      broken: transportBroken || socket.readyState !== WebSocket.OPEN,
    };
    if (typeof target.onRpcBroken === "function") {
      target.onRpcBroken(markTransportBroken);
    }
    setRuntimeStatus("connected");
    if (!appRuntimeReady) {
      scheduleConnectedReadyFallback();
    }
    return connection;
  })().catch((error) => {
    if (backendConnectionPromise === ready) {
      resetBackendConnection();
    }
    const nextError = transportBroken ? new BackendTransportClosedError(error) : error;
    setAppError(nextError);
    throw nextError;
  });
  backendConnectionPromise = ready;
  if (globalThis.window) {
    globalThis.window.__GSV_BACKEND_READY__ = ready.then(() => backendProxy ?? null);
  }
  return ready;
}

async function invokeBackend(method: string, args?: unknown): Promise<unknown> {
  let connection: BackendConnection | null = null;
  try {
    connection = await connectBackendTransport();
    return await connection.backend.invoke(method, args);
  } catch (error) {
    if (!shouldRetryBackendCall(connection, error)) {
      throw error;
    }
  }

  resetBackendConnection();
  setRuntimeStatus(appRuntimeReady ? "reconnecting" : "connecting");
  const nextConnection = await connectBackendTransport();
  return nextConnection.backend.invoke(method, args);
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

function buildRpcSessionRefreshUrl(boot: PackageAppBoot): string {
  return new URL(
    `/app-rpc/${encodeURIComponent(boot.packageName)}/sessions/${encodeURIComponent(boot.sessionId)}/refresh`,
    globalThis.window?.location?.href ?? "http://localhost",
  ).toString();
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
