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

type AppRequestFrame = {
  type: "req";
  id: string;
  call: string;
  args?: unknown;
};

type AppResponseFrame =
  | {
      type: "res";
      id: string;
      ok: true;
      data?: unknown;
    }
  | {
      type: "res";
      id: string;
      ok: false;
      error: {
        code: number;
        message: string;
        details?: unknown;
      };
    };

type AppSignalFrame = {
  type: "sig";
  signal: string;
  payload?: unknown;
};

type AppSocketFrame = AppResponseFrame | AppSignalFrame;

type AppConnectResult = {
  protocol: number;
  packageId: string;
  packageName: string;
  clientId: string;
  expiresAt: number;
};

type PendingBackendRequest = {
  resolve(value: unknown): void;
  reject(error: unknown): void;
};

type RemoteBackend = {
  invoke(method: string, args?: unknown): Promise<unknown>;
} & Record<string | symbol, unknown>;

type BackendConnection = {
  backend: RemoteBackend;
  socket: WebSocket;
  broken: boolean;
  pending: Map<string, PendingBackendRequest>;
  request<T = unknown>(call: string, args?: unknown): Promise<T>;
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

let backendConnectionPromise: Promise<BackendConnection> | null = null;
let backendProxy: unknown = null;
let appSessionRefreshPromise: Promise<PackageAppBoot> | null = null;
let appRuntimeReady = false;
let connectedReadyFallback: ReturnType<typeof setTimeout> | null = null;
let backendRequestSeq = 0;
const appEventListeners = new Set<AppEventListener>();
const APP_SESSION_REFRESH_LEEWAY_MS = 60_000;
const CONNECTED_READY_FALLBACK_MS = 650;
const APP_SOCKET_PROTOCOL_VERSION = 1;

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

class BackendRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "BackendRpcError";
  }
}

function resetBackendConnection(): void {
  const previousConnection = backendConnectionPromise;
  backendConnectionPromise = null;
  if (globalThis.window) {
    globalThis.window.__GSV_BACKEND_READY__ = undefined;
  }
  void previousConnection
    ?.then((connection) => {
      connection.broken = true;
      rejectPendingBackendRequests(connection, new BackendTransportClosedError("client reconnect"));
      closeBackendSocket(connection.socket);
    })
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

function createRequestId(): string {
  backendRequestSeq += 1;
  return `app:${Date.now().toString(36)}:${backendRequestSeq.toString(36)}`;
}

function rejectPendingBackendRequests(connection: BackendConnection, error: unknown): void {
  for (const pending of connection.pending.values()) {
    pending.reject(error);
  }
  connection.pending.clear();
}

function waitForSocketOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) {
    return Promise.resolve();
  }
  if (socket.readyState === WebSocket.CLOSING || socket.readyState === WebSocket.CLOSED) {
    return Promise.reject(new BackendTransportClosedError("package backend socket closed"));
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (event: Event) => {
      cleanup();
      reject(new BackendTransportClosedError(event));
    };
    const onClose = (event: CloseEvent) => {
      cleanup();
      reject(new BackendTransportClosedError(`package backend socket closed (${event.code})`));
    };
    socket.addEventListener("open", onOpen);
    socket.addEventListener("error", onError);
    socket.addEventListener("close", onClose);
  });
}

function sendBackendRequest<T = unknown>(
  connection: BackendConnection,
  call: string,
  args?: unknown,
): Promise<T> {
  if (connection.broken || connection.socket.readyState !== WebSocket.OPEN) {
    return Promise.reject(new BackendTransportClosedError("package backend socket is closed"));
  }

  const id = createRequestId();
  const frame: AppRequestFrame = {
    type: "req",
    id,
    call,
    ...(args === undefined ? {} : { args }),
  };

  return new Promise((resolve, reject) => {
    connection.pending.set(id, {
      resolve: (value) => resolve(value as T),
      reject,
    });
    try {
      connection.socket.send(JSON.stringify(frame));
    } catch (error) {
      connection.pending.delete(id);
      reject(new BackendTransportClosedError(error));
    }
  });
}

function handleBackendFrame(connection: BackendConnection, raw: unknown): void {
  if (typeof raw !== "string") {
    console.warn("[gsv-package] ignored non-text app frame");
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.warn("[gsv-package] ignored invalid app frame", error);
    return;
  }

  if (!isAppSocketFrame(parsed)) {
    console.warn("[gsv-package] ignored unknown app frame", parsed);
    return;
  }

  if (parsed.type === "sig") {
    emitAppEvent(parsed.signal, parsed.payload);
    return;
  }

  const pending = connection.pending.get(parsed.id);
  if (!pending) {
    return;
  }
  connection.pending.delete(parsed.id);
  if (parsed.ok) {
    pending.resolve(parsed.data);
    return;
  }
  pending.reject(new BackendRpcError(
    parsed.error.code,
    parsed.error.message,
    parsed.error.details,
  ));
}

function isAppSocketFrame(value: unknown): value is AppSocketFrame {
  return isAppResponseFrame(value) || isAppSignalFrame(value);
}

function isAppResponseFrame(value: unknown): value is AppResponseFrame {
  const record = asRecord(value);
  if (record?.type !== "res" || typeof record.id !== "string" || typeof record.ok !== "boolean") {
    return false;
  }
  if (record.ok) {
    return true;
  }
  const error = asRecord(record.error);
  return Boolean(
    error &&
    typeof error.code === "number" &&
    typeof error.message === "string",
  );
}

function isAppSignalFrame(value: unknown): value is AppSignalFrame {
  const record = asRecord(value);
  return record?.type === "sig" && typeof record.signal === "string";
}

function isAppConnectResult(value: unknown): value is AppConnectResult {
  const record = asRecord(value);
  return Boolean(
    record &&
    typeof record.protocol === "number" &&
    typeof record.packageId === "string" &&
    typeof record.packageName === "string" &&
    typeof record.clientId === "string" &&
    typeof record.expiresAt === "number",
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
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
  const socket = new WebSocket(buildRpcWebSocketUrl(boot.rpcBase));
  const connection: BackendConnection = {
    backend: {
      invoke(method: string, args?: unknown) {
        return connection.request("backend.invoke", { method, args });
      },
    },
    socket,
    broken: socket.readyState === WebSocket.CLOSING || socket.readyState === WebSocket.CLOSED,
    pending: new Map(),
    request<T = unknown>(call: string, args?: unknown): Promise<T> {
      return sendBackendRequest<T>(connection, call, args);
    },
  };
  let ready: Promise<BackendConnection>;
  const markTransportBroken = (cause: unknown) => {
    connection.broken = true;
    rejectPendingBackendRequests(connection, new BackendTransportClosedError(cause));
    if (backendConnectionPromise === ready) {
      resetBackendConnection();
    }
  };
  socket.addEventListener("message", (event) => {
    handleBackendFrame(connection, event.data);
  });
  socket.addEventListener("close", (event) => {
    markTransportBroken(`package backend socket closed (${event.code})`);
  });
  socket.addEventListener("error", markTransportBroken);

  ready = (async () => {
    await waitForSocketOpen(socket);
    const connected = await connection.request("app.connect", {
      secret: boot.sessionSecret,
      clientId: boot.clientId,
    });
    if (!isAppConnectResult(connected)) {
      throw new Error("package backend returned an invalid connect response");
    }
    if (connected.protocol !== APP_SOCKET_PROTOCOL_VERSION) {
      throw new Error(`unsupported package backend protocol ${connected.protocol}`);
    }
    if (
      connected.packageId !== boot.packageId ||
      connected.packageName !== boot.packageName ||
      connected.clientId !== boot.clientId
    ) {
      throw new Error("package backend connected to the wrong app session");
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
    const nextError = connection.broken ? new BackendTransportClosedError(error) : error;
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
