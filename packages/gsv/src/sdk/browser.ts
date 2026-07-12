import type { HostBackendCloseEvent, HostBackendSocket, HostClient } from "./host";
import type {
  GsvClientCall,
  GsvClientNamespaces,
  GsvRequestOptions,
  GsvResponse,
} from "../client";
import {
  BODY_SYSCALL_NAMES,
  BinaryBodyChannel,
  type ArgsOf,
  type BinaryBody,
  type BinaryFrameDescriptor,
  type OutgoingBinaryBody,
  type ResultOf,
  type SyscallName,
} from "../protocol";

export type PackageAppBoot = {
  packageId: string;
  packageName: string;
  routeBase: string;
  rpcBase: string;
  sessionId: string;
  clientId: string;
  expiresAt: number;
  hasBackend: boolean;
};

type AppRequestFrame = {
  type: "req";
  id: string;
  call: string;
  args?: unknown;
  body?: BinaryFrameDescriptor;
};

type AppResponseFrame =
  | {
      type: "res";
      id: string;
      ok: true;
      data?: unknown;
      body?: BinaryFrameDescriptor;
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

type PendingBackendRequest = {
  resolve(value: GsvResponse<unknown>): void;
  reject(error: unknown): void;
  bodyAbort?: AbortController;
};

type RemoteBackend = {
  invoke(method: string, args?: unknown): Promise<unknown>;
} & Record<string | symbol, unknown>;

type BackendConnection = {
  backend: RemoteBackend;
  transport: BackendTransport;
  requireBackend: boolean;
  broken: boolean;
  reconnectOnClose: boolean;
  pending: Map<string, PendingBackendRequest>;
  bodyChannel: BinaryBodyChannel;
  request<T = unknown>(call: string, args?: unknown, options?: GsvRequestOptions): Promise<GsvResponse<T>>;
};

type BackendTransportCloseEvent = {
  code: number;
  reason?: string;
};

type BackendTransport = {
  readonly readyState: "connecting" | "open" | "closing" | "closed";
  send(data: string | ArrayBuffer): Promise<void>;
  close(): void;
  addEventListener(type: "message", listener: (data: unknown) => void): void;
  addEventListener(type: "close", listener: (event: BackendTransportCloseEvent) => void): void;
  addEventListener(type: "error", listener: (error: unknown) => void): void;
};

type BackendProxyControl = {
  invoke(method: string, args?: unknown): Promise<unknown>;
  reconnect(): Promise<void>;
};

type BackendTransportOptions = {
  requireBackend?: boolean;
};

type ResolvedBackendTransportOptions = {
  requireBackend: boolean;
};

export type PackageGsvClient = GsvClientNamespaces & {
  call: GsvClientCall;
  request: PackageGsvRequest;
  backend<T = unknown>(): Promise<T>;
  getBackend<T = unknown>(): Promise<T>;
  boot(): PackageAppBoot;
};

export type PackageGsvRequest = {
  <S extends SyscallName>(
    call: S,
    args: ArgsOf<S>,
    options?: GsvRequestOptions,
  ): Promise<GsvResponse<ResultOf<S>>>;
  <T = unknown>(
    call: string,
    args?: unknown,
    options?: GsvRequestOptions,
  ): Promise<GsvResponse<T>>;
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
    __GSV_APP_SESSION_FETCH_BRIDGE__?: true;
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
let gsvClient: PackageGsvClient | null = null;
let appSessionRefreshPromise: Promise<PackageAppBoot> | null = null;
let appRuntimeReady = false;
let connectedReadyFallback: ReturnType<typeof setTimeout> | null = null;
let appSessionRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let backendRequestSeq = 0;
const appEventListeners = new Set<AppEventListener>();
const APP_SESSION_REFRESH_LEEWAY_MS = 60_000;
const APP_SESSION_REFRESH_RETRY_MS = 30_000;
const BACKEND_RECONNECT_DELAYS_MS = [0, 500, 1_000, 2_000, 5_000, 10_000, 30_000] as const;
let backendReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let backendReconnectAttempts = 0;
const CONNECTED_READY_FALLBACK_MS = 650;
const BODY_SYSCALLS = new Set<string>(BODY_SYSCALL_NAMES);

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

function clearAppSessionRefreshTimer(): void {
  if (appSessionRefreshTimer !== null) {
    clearTimeout(appSessionRefreshTimer);
    appSessionRefreshTimer = null;
  }
}

function clearBackendReconnectTimer(): void {
  if (backendReconnectTimer !== null) {
    clearTimeout(backendReconnectTimer);
    backendReconnectTimer = null;
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

function webSocketReadyState(socket: WebSocket): BackendTransport["readyState"] {
  if (socket.readyState === WebSocket.CONNECTING) {
    return "connecting";
  }
  if (socket.readyState === WebSocket.OPEN) {
    return "open";
  }
  if (socket.readyState === WebSocket.CLOSING) {
    return "closing";
  }
  return "closed";
}

function createWebSocketBackendTransport(socket: WebSocket): BackendTransport {
  return {
    get readyState() {
      return webSocketReadyState(socket);
    },
    send: async (data) => {
      socket.send(data);
    },
    close: () => {
      if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) {
        socket.close(1000, "client reconnect");
      }
    },
    addEventListener: (type, listener) => {
      if (type === "message") {
        const onMessage = listener as (data: unknown) => void;
        socket.addEventListener("message", (event) => onMessage(event.data));
        return;
      }
      if (type === "close") {
        const onClose = listener as (event: BackendTransportCloseEvent) => void;
        socket.addEventListener("close", (event) => onClose({
          code: event.code,
          reason: event.reason,
        }));
        return;
      }
      const onError = listener as (error: unknown) => void;
      socket.addEventListener("error", (event) => onError(event));
    },
  };
}

function createHostBackendTransport(socket: HostBackendSocket): BackendTransport {
  return {
    get readyState() {
      return socket.readyState;
    },
    send: async (data) => {
      await socket.send(data);
    },
    close: () => {
      socket.close();
    },
    addEventListener: (type, listener) => {
      if (type === "message") {
        const onMessage = listener as (data: unknown) => void;
        socket.addEventListener("message", (data) => onMessage(data));
        return;
      }
      if (type === "close") {
        const onClose = listener as (event: BackendTransportCloseEvent) => void;
        socket.addEventListener("close", (event: HostBackendCloseEvent) => onClose({
          code: event.code,
          reason: event.reason,
        }));
        return;
      }
      socket.addEventListener("error", listener as (error: Error) => void);
    },
  };
}

function waitForWebSocketOpen(socket: WebSocket): Promise<void> {
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

function isEmbeddedInHost(): boolean {
  return Boolean(globalThis.window?.parent && globalThis.window.parent !== globalThis.window);
}

async function getHostClient(): Promise<HostClient> {
  const host = await import("./host");
  return await host.connectHost();
}

let nativeAppSessionFetch: typeof fetch | null = null;

function currentLocationHref(): string {
  return globalThis.window?.location?.href ?? "http://localhost";
}

function isRequestInput(value: RequestInfo | URL): value is Request {
  return typeof Request !== "undefined" && value instanceof Request;
}

function fetchInputUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

function normalizeRouteBase(routeBase: string): string {
  return routeBase.length > 1 && routeBase.endsWith("/") ? routeBase.slice(0, -1) : routeBase;
}

function isAppSessionFetchUrl(url: URL, boot: PackageAppBoot): boolean {
  const routeBaseUrl = new URL(boot.routeBase, currentLocationHref());
  const routeBase = normalizeRouteBase(routeBaseUrl.pathname);
  return url.origin === routeBaseUrl.origin
    && (url.pathname === routeBase || url.pathname.startsWith(`${routeBase}/`));
}

function appSessionFetchBoot(input: RequestInfo | URL): PackageAppBoot | null {
  if (!isEmbeddedInHost() || !hasAppBoot()) {
    return null;
  }
  const boot = getAppBoot();
  let url: URL;
  try {
    url = new URL(fetchInputUrl(input), currentLocationHref());
  } catch {
    return null;
  }
  return isAppSessionFetchUrl(url, boot) ? boot : null;
}

function buildHostFetchRequest(input: RequestInfo | URL, init?: RequestInit): Request {
  if (isRequestInput(input) && init === undefined) {
    return input.clone();
  }
  if (typeof input === "string") {
    return new Request(new URL(input, currentLocationHref()).toString(), init);
  }
  return new Request(input, init);
}

async function fetchAppSessionThroughHost(
  nativeFetch: typeof fetch,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const boot = appSessionFetchBoot(input);
  if (!boot) {
    return await nativeFetch(input, init);
  }
  const request = buildHostFetchRequest(input, init);
  return await (await getHostClient()).fetchAppSession(boot, request);
}

export function installAppSessionFetchBridge(): void {
  if (!globalThis.window || globalThis.window.__GSV_APP_SESSION_FETCH_BRIDGE__ || typeof globalThis.fetch !== "function") {
    return;
  }
  const nativeFetch = globalThis.fetch.bind(globalThis) as typeof fetch;
  nativeAppSessionFetch = nativeFetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    return fetchAppSessionThroughHost(nativeFetch, input, init);
  }) as typeof fetch;
  globalThis.window.__GSV_APP_SESSION_FETCH_BRIDGE__ = true;
}

async function connectHostBackendTransport(boot: PackageAppBoot): Promise<BackendTransport> {
  const host = await getHostClient();
  const socket = await host.connectBackendSocket(boot);
  return createHostBackendTransport(socket);
}

async function connectDirectBackendTransport(boot: PackageAppBoot): Promise<BackendTransport> {
  const socket = new WebSocket(buildRpcWebSocketUrl(boot.rpcBase));
  socket.binaryType = "arraybuffer";
  try {
    await waitForWebSocketOpen(socket);
  } catch (error) {
    if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) {
      socket.close(1000, "open failed");
    }
    throw error;
  }
  return createWebSocketBackendTransport(socket);
}

async function connectBackendFrameTransport(boot: PackageAppBoot): Promise<BackendTransport> {
  if (isEmbeddedInHost()) {
    try {
      return await connectHostBackendTransport(boot);
    } catch (error) {
      console.warn("[gsv-package] host backend bridge failed; trying direct socket", error);
    }
  }
  return await connectDirectBackendTransport(boot);
}

function resetBackendConnection(): void {
  const previousConnection = backendConnectionPromise;
  backendConnectionPromise = null;
  clearAppSessionRefreshTimer();
  clearBackendReconnectTimer();
  if (globalThis.window) {
    globalThis.window.__GSV_BACKEND_READY__ = undefined;
  }
  void previousConnection
    ?.then((connection) => {
      connection.reconnectOnClose = false;
      connection.broken = true;
      rejectPendingBackendRequests(connection, new BackendTransportClosedError("client reconnect"));
      connection.bodyChannel.close(new BackendTransportClosedError("client reconnect"));
      closeBackendTransport(connection.transport);
    })
    .catch(() => {});
}

function closeBackendTransport(transport: BackendTransport): void {
  if (transport.readyState === "connecting" || transport.readyState === "open") {
    transport.close();
  }
}

function shouldRetryBackendCall(connection: BackendConnection | null, error: unknown): boolean {
  return error instanceof BackendTransportClosedError
    || Boolean(connection?.broken)
    || Boolean(connection && connection.transport.readyState !== "open");
}

function shouldMaintainBackendConnection(): boolean {
  return Boolean(backendProxy) || Boolean(gsvClient) || appEventListeners.size > 0;
}

function scheduleBackendReconnect(options: ResolvedBackendTransportOptions): void {
  if (backendReconnectTimer !== null || !shouldMaintainBackendConnection()) {
    return;
  }
  const delay = BACKEND_RECONNECT_DELAYS_MS[
    Math.min(backendReconnectAttempts, BACKEND_RECONNECT_DELAYS_MS.length - 1)
  ];
  backendReconnectAttempts += 1;
  setRuntimeStatus(appRuntimeReady ? "reconnecting" : "connecting");
  backendReconnectTimer = setTimeout(() => {
    backendReconnectTimer = null;
    void connectBackendTransport(options)
      .then(() => {
        backendReconnectAttempts = 0;
      })
      .catch((error) => {
        console.warn("[gsv-package] backend reconnect failed", error);
        scheduleBackendReconnect(options);
      });
  }, delay);
}

function createRequestId(): string {
  backendRequestSeq += 1;
  return `app:${Date.now().toString(36)}:${backendRequestSeq.toString(36)}`;
}

function rejectPendingBackendRequests(connection: BackendConnection, error: unknown): void {
  for (const pending of connection.pending.values()) {
    pending.bodyAbort?.abort(error);
    pending.reject(error);
  }
  connection.pending.clear();
}

function sendBackendRequest<T = unknown>(
  connection: BackendConnection,
  call: string,
  args?: unknown,
  options: GsvRequestOptions = {},
): Promise<GsvResponse<T>> {
  if (connection.broken || connection.transport.readyState !== "open") {
    return Promise.reject(new BackendTransportClosedError("package backend socket is closed"));
  }

  const id = createRequestId();
  const body = options.body;
  let outgoing: OutgoingBinaryBody | undefined;
  try {
    outgoing = body ? connection.bodyChannel.prepare(body) : undefined;
  } catch (error) {
    return Promise.reject(error);
  }
  const frame: AppRequestFrame = {
    type: "req",
    id,
    call,
    ...(args === undefined ? {} : { args }),
    ...(outgoing ? { body: outgoing.descriptor } : {}),
  };
  const bodyAbort = body ? new AbortController() : undefined;

  return new Promise((resolve, reject) => {
    connection.pending.set(id, {
      resolve: (value) => resolve(value as GsvResponse<T>),
      reject,
      bodyAbort,
    });
    void (async () => {
      await connection.transport.send(JSON.stringify(frame));
      if (outgoing) {
        await outgoing.send(bodyAbort?.signal);
      }
    })().catch((error) => {
      const pending = connection.pending.get(id);
      if (!pending) {
        return;
      }
      connection.pending.delete(id);
      pending.bodyAbort?.abort(error);
      void outgoing?.cancel(error);
      pending.reject(new BackendTransportClosedError(error));
    });
  });
}

async function handleBackendFrame(connection: BackendConnection, raw: unknown): Promise<void> {
  if (typeof raw !== "string") {
    const data = raw instanceof ArrayBuffer
      ? raw
      : ArrayBuffer.isView(raw)
        ? raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer
        : typeof Blob !== "undefined" && raw instanceof Blob
          ? await raw.arrayBuffer()
          : null;
    if (!data || !connection.bodyChannel.handleFrame(data)) {
      console.warn("[gsv-package] ignored invalid binary app frame");
      return;
    }
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
    if (parsed.ok && parsed.body) {
      try {
        await connection.bodyChannel.receive(parsed.body).stream.cancel("Package response is no longer pending");
      } catch {}
    }
    return;
  }
  connection.pending.delete(parsed.id);
  pending.bodyAbort?.abort(new Error("Package request completed"));
  if (parsed.ok) {
    try {
      pending.resolve({
        data: parsed.data ?? {},
        ...(parsed.body ? { body: connection.bodyChannel.receive(parsed.body) } : {}),
      });
    } catch (error) {
      pending.reject(error);
    }
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
    && typeof candidate.clientId === "string"
    && typeof candidate.expiresAt === "number"
    && typeof candidate.hasBackend === "boolean";
}

function shouldRefreshAppSession(boot: PackageAppBoot): boolean {
  return boot.expiresAt <= Date.now() + APP_SESSION_REFRESH_LEEWAY_MS;
}

function resolveBackendTransportOptions(options: BackendTransportOptions = {}): ResolvedBackendTransportOptions {
  return {
    requireBackend: options.requireBackend !== false,
  };
}

async function refreshAppSession(boot: PackageAppBoot): Promise<PackageAppBoot> {
  if (appSessionRefreshPromise) {
    return appSessionRefreshPromise;
  }

  const refresh = (async () => {
    let nextBoot: unknown;
    if (isEmbeddedInHost()) {
      try {
        nextBoot = await (await getHostClient()).refreshAppSession(boot);
      } catch (error) {
        console.warn("[gsv-package] host app session refresh failed; trying direct refresh", error);
      }
    }
    if (nextBoot === undefined) {
      const directFetch = nativeAppSessionFetch ?? globalThis.fetch.bind(globalThis);
      const response = await directFetch(buildRpcSessionRefreshUrl(boot), {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "accept": "application/json",
        },
      });

      if (!response.ok) {
        const message = await response.text().catch(() => "");
        throw new Error(message || `package app session refresh failed (${response.status})`);
      }

      nextBoot = await response.json();
    }
    if (!isPackageAppBoot(nextBoot)) {
      throw new Error("package app session refresh returned an invalid bootstrap payload");
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

function scheduleAppSessionRefresh(
  connection: BackendConnection,
  boot: PackageAppBoot,
  isCurrentConnection: () => boolean,
): void {
  clearAppSessionRefreshTimer();
  if (connection.broken || !isCurrentConnection()) {
    return;
  }
  const delayMs = Math.max(0, boot.expiresAt - Date.now() - APP_SESSION_REFRESH_LEEWAY_MS);
  appSessionRefreshTimer = setTimeout(() => {
    appSessionRefreshTimer = null;
    if (connection.broken || !isCurrentConnection()) {
      return;
    }
    void refreshAppSession(getAppBoot())
      .then(() => {
        if (connection.broken || !isCurrentConnection()) {
          return;
        }
        resetBackendConnection();
        scheduleBackendReconnect({
          requireBackend: connection.requireBackend,
        });
      })
      .catch((error) => {
        console.warn("[gsv-package] app session refresh failed", error);
        if (!connection.broken && isCurrentConnection()) {
          appSessionRefreshTimer = setTimeout(() => {
            appSessionRefreshTimer = null;
            scheduleAppSessionRefresh(connection, getAppBoot(), isCurrentConnection);
          }, APP_SESSION_REFRESH_RETRY_MS);
        }
      });
  }, delayMs);
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

async function connectBackendTransport(options: BackendTransportOptions = {}): Promise<BackendConnection> {
  const resolvedOptions = resolveBackendTransportOptions(options);
  if (resolvedOptions.requireBackend && !getAppBoot().hasBackend) {
    throw new Error("package app has no backend rpc");
  }
  if (backendConnectionPromise) {
    const currentConnectionPromise = backendConnectionPromise;
    const currentConnection = await currentConnectionPromise;
    if (!shouldRefreshAppSession(getAppBoot())) {
      return currentConnection;
    }
    await refreshAppSession(getAppBoot());
    if (backendConnectionPromise === currentConnectionPromise) {
      resetBackendConnection();
    }
    return connectBackendTransport(resolvedOptions);
  }
  setRuntimeStatus(appRuntimeReady ? "reconnecting" : "connecting");
  let ready: Promise<BackendConnection>;
  ready = (async () => {
    let boot = getAppBoot();
    if (shouldRefreshAppSession(boot)) {
      boot = await refreshAppSession(boot);
    }
    const transport = await connectBackendFrameTransport(boot);
    const bodyChannel = new BinaryBodyChannel({
      sendFrame: (frame) => transport.send(frame),
    });
    let connection: BackendConnection;
    const isCurrentConnection = () => backendConnectionPromise === ready;
    const markTransportBroken = (cause: unknown) => {
      const shouldReconnect = connection.reconnectOnClose && shouldMaintainBackendConnection();
      connection.broken = true;
      if (isCurrentConnection()) {
        clearAppSessionRefreshTimer();
      }
      rejectPendingBackendRequests(connection, new BackendTransportClosedError(cause));
      connection.bodyChannel.close(new BackendTransportClosedError(cause));
      if (backendConnectionPromise === ready) {
        resetBackendConnection();
        if (shouldReconnect) {
          scheduleBackendReconnect({
            requireBackend: connection.requireBackend,
          });
        }
      }
    };
    connection = {
      backend: {
        async invoke(method: string, args?: unknown) {
          const response = await connection.request("backend.invoke", { method, args });
          if (response.body) {
            await response.body.stream.cancel("backend.invoke does not support response bodies").catch(() => {});
            throw new Error("backend.invoke returned an unsupported response body");
          }
          return response.data;
        },
      },
      transport,
      requireBackend: resolvedOptions.requireBackend,
      broken: transport.readyState === "closing" || transport.readyState === "closed",
      reconnectOnClose: true,
      pending: new Map(),
      bodyChannel,
      request<T = unknown>(
        call: string,
        args?: unknown,
        requestOptions?: GsvRequestOptions,
      ): Promise<GsvResponse<T>> {
        return sendBackendRequest<T>(connection, call, args, requestOptions);
      },
    };
    transport.addEventListener("message", (data) => {
      void handleBackendFrame(connection, data).catch((error) => {
        markTransportBroken(error);
      });
    });
    transport.addEventListener("close", (event) => {
      markTransportBroken(`package backend socket closed (${event.code})`);
    });
    transport.addEventListener("error", markTransportBroken);
    setRuntimeStatus("connected");
    backendReconnectAttempts = 0;
    clearBackendReconnectTimer();
    scheduleAppSessionRefresh(connection, boot, isCurrentConnection);
    if (!appRuntimeReady) {
      scheduleConnectedReadyFallback();
    }
    return connection;
  })().catch((error) => {
    if (backendConnectionPromise === ready) {
      resetBackendConnection();
    }
    setAppError(error);
    throw error;
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
    connection = await connectBackendTransport({ requireBackend: true });
    return await connection.backend.invoke(method, args);
  } catch (error) {
    if (!shouldRetryBackendCall(connection, error)) {
      throw error;
    }
  }

  resetBackendConnection();
  setRuntimeStatus(appRuntimeReady ? "reconnecting" : "connecting");
  const nextConnection = await connectBackendTransport({ requireBackend: true });
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
          await connectBackendTransport({ requireBackend: true });
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

async function requestKernel<T = unknown>(
  call: string,
  args?: unknown,
  options: GsvRequestOptions = {},
): Promise<GsvResponse<T>> {
  let connection: BackendConnection | null = null;
  try {
    connection = await connectBackendTransport({ requireBackend: false });
    return await connection.request<T>("kernel.request", { call, args }, options);
  } catch (error) {
    if (options.body || !shouldRetryBackendCall(connection, error)) {
      throw error;
    }
  }

  resetBackendConnection();
  setRuntimeStatus(appRuntimeReady ? "reconnecting" : "connecting");
  const nextConnection = await connectBackendTransport({ requireBackend: false });
  return await nextConnection.request<T>("kernel.request", { call, args });
}

const packageRequest = requestKernel as PackageGsvRequest;
const packageCall = (async (call: string, args?: unknown) => {
  const response = await requestKernel(call, args);
  if (response.body) {
    await response.body.stream.cancel(`${call} returned a body; use request()`).catch(() => {});
    throw new Error(`${call} returned a body; use gsv.request()`);
  }
  return response.data;
}) as GsvClientCall;

function createNamespaceProxy(path: string[]): unknown {
  return new Proxy(() => undefined, {
    get(_target, prop) {
      if (prop === "then") {
        return undefined;
      }
      if (typeof prop !== "string") {
        return undefined;
      }
      const nextPath = [...path, prop];
      if (BODY_SYSCALLS.has(nextPath.join("."))) {
        return undefined;
      }
      return createNamespaceProxy(nextPath);
    },
    apply(_target, _thisArg, args) {
      return packageCall(path.join("."), args[0]);
    },
  });
}

export function getGsvClient(): PackageGsvClient {
  if (gsvClient) {
    return gsvClient;
  }
  const root = new Proxy({} as PackageGsvClient, {
    get(_target, prop) {
      if (prop === "then") {
        return undefined;
      }
      if (prop === "call") {
        return packageCall;
      }
      if (prop === "request") {
        return packageRequest;
      }
      if (prop === "backend" || prop === "getBackend") {
        return getBackend;
      }
      if (prop === "boot") {
        return getAppBoot;
      }
      if (typeof prop !== "string") {
        return undefined;
      }
      return createNamespaceProxy([prop]);
    },
  });
  gsvClient = root;
  return root;
}

export async function createGsvClient(): Promise<PackageGsvClient> {
  const client = getGsvClient();
  await connectBackendTransport({ requireBackend: false });
  return client;
}

function buildRpcWebSocketUrl(rpcBase: string): string {
  const url = new URL(rpcBase, globalThis.window?.location?.href ?? "http://localhost");
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function buildRpcSessionRefreshUrl(boot: PackageAppBoot): string {
  const routeBase = boot.routeBase.endsWith("/") ? boot.routeBase.slice(0, -1) : boot.routeBase;
  return new URL(
    `${routeBase}/refresh`,
    globalThis.window?.location?.href ?? "http://localhost",
  ).toString();
}

export async function connectBackend<T = unknown>(): Promise<T> {
  if (!getAppBoot().hasBackend) {
    throw new Error("package app has no backend rpc");
  }
  const proxy = createBackendProxy<T>();
  await connectBackendTransport({ requireBackend: true });
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

installAppSessionFetchBridge();
