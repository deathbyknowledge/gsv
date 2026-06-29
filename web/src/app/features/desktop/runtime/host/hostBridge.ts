import type { GsvClientStatus } from "@humansandmachines/gsv/client";

type HostRpcMethod =
  | "setTitle"
  | "setBadge"
  | "setDirty"
  | "requestNewWindow"
  | "appSession.refresh"
  | "appSession.fetch"
  | "backend.connect"
  | "backend.send"
  | "backend.close";

type HostRpcMessage = {
  type: "rpc";
  id: string;
  method: HostRpcMethod;
  payload?: unknown;
};

type HostRpcResultMessage =
  | {
      type: "rpc-result";
      id: string;
      ok: true;
      data?: unknown;
    }
  | {
      type: "rpc-result";
      id: string;
      ok: false;
      error: string;
    };

type HostStatusMessage = {
  type: "status";
  status: GsvClientStatus;
};

type HostBackendMessage =
  | {
      type: "backend-message";
      connectionId: string;
      data: string;
    }
  | {
      type: "backend-close";
      connectionId: string;
      code: number;
      reason: string;
      wasClean: boolean;
    }
  | {
      type: "backend-error";
      connectionId: string;
      error: string;
    };

type HostConnectMessage = {
  type: "gsv-host-connect";
  requestId?: string;
};

type HostPortMessage = HostRpcMessage | HostRpcResultMessage | HostStatusMessage | HostBackendMessage;

export type HostBridgeController = {
  destroy: () => void;
};

type HostChromeController = {
  setTitle: (title: string | null) => void;
  setBadge: (badge: string | null) => void;
  setDirty: (dirty: boolean) => void;
  requestNewWindow: (route?: string) => string | null;
};

type HostStatusClient = {
  onStatus: (listener: (status: GsvClientStatus) => void) => () => void;
};

type HostAppSession = {
  sessionId: string;
  clientId: string;
  routeBase: string;
  rpcBase: string;
};

type HostBackendConnection = {
  socket: WebSocket;
};

type HostAppSessionFetchRequest = {
  url: string;
  method?: string;
  headers?: unknown;
  body?: unknown;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function postMessage(port: MessagePort, message: HostPortMessage): void {
  port.postMessage(message);
}

function appClientRouteBase(sessionId: string, clientId: string): string {
  return `/apps/sessions/${encodeURIComponent(sessionId)}/clients/${encodeURIComponent(clientId)}`;
}

function appClientRpcBase(sessionId: string, clientId: string): string {
  return `${appClientRouteBase(sessionId, clientId)}/socket`;
}

function appClientRefreshUrl(session: HostAppSession): string {
  return `${session.routeBase}/refresh`;
}

function windowLocationHref(): string {
  return window.location.href || window.location.origin;
}

function buildRpcWebSocketUrl(rpcBase: string): string {
  const url = new URL(rpcBase, windowLocationHref());
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function validateSessionPayload(appSession: HostAppSession | null, payload: unknown): HostAppSession {
  if (!appSession) {
    throw new Error("Package app session is unavailable");
  }
  const record = asRecord(payload);
  const boot = asRecord(record?.boot);
  const expectedRouteBase = appClientRouteBase(appSession.sessionId, appSession.clientId);
  const expectedRpcBase = appClientRpcBase(appSession.sessionId, appSession.clientId);
  if (
    boot?.sessionId !== appSession.sessionId ||
    boot?.clientId !== appSession.clientId ||
    boot?.routeBase !== expectedRouteBase ||
    boot?.rpcBase !== expectedRpcBase
  ) {
    throw new Error("Package app session mismatch");
  }
  return appSession;
}

function normalizeRouteBase(routeBase: string): string {
  return routeBase.length > 1 && routeBase.endsWith("/") ? routeBase.slice(0, -1) : routeBase;
}

function isAppSessionFetchUrl(url: URL, session: HostAppSession): boolean {
  const routeBase = normalizeRouteBase(session.routeBase);
  return url.origin === window.location.origin
    && (url.pathname === routeBase || url.pathname.startsWith(`${routeBase}/`));
}

function appSessionFetchHeaders(value: unknown): Headers {
  const headers = new Headers();
  if (value === undefined || value === null) {
    return headers;
  }
  if (!Array.isArray(value)) {
    throw new Error("Invalid package app fetch headers");
  }
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || typeof entry[1] !== "string") {
      throw new Error("Invalid package app fetch headers");
    }
    const name = entry[0].toLowerCase();
    if (name === "authorization" || name === "cookie" || name === "host" || name === "connection" || name === "content-length") {
      continue;
    }
    headers.append(entry[0], entry[1]);
  }
  return headers;
}

function appSessionFetchBody(method: string, value: unknown): BodyInit | undefined {
  if (method === "GET" || method === "HEAD" || value === undefined || value === null) {
    return undefined;
  }
  if (value instanceof ArrayBuffer) {
    return value;
  }
  if (ArrayBuffer.isView(value) && value.buffer instanceof ArrayBuffer) {
    const view = value as ArrayBufferView<ArrayBuffer>;
    return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
  }
  throw new Error("Invalid package app fetch body");
}

function buildAppSessionFetchRequest(appSession: HostAppSession | null, payload: unknown): Request {
  const session = validateSessionPayload(appSession, payload);
  const record = asRecord(payload);
  const request = asRecord(record?.request) as HostAppSessionFetchRequest | null;
  if (!request || typeof request.url !== "string") {
    throw new Error("Invalid package app fetch request");
  }
  const url = new URL(request.url, windowLocationHref());
  if (!isAppSessionFetchUrl(url, session)) {
    throw new Error("Package app fetch URL is outside the app session");
  }
  const method = (typeof request.method === "string" && request.method.trim() ? request.method : "GET").toUpperCase();
  return new Request(url.toString(), {
    method,
    headers: appSessionFetchHeaders(request.headers),
    body: appSessionFetchBody(method, request.body),
    credentials: "same-origin",
    redirect: "error",
  });
}

async function serializeAppSessionFetchResponse(response: Response): Promise<unknown> {
  const headers: string[][] = [];
  response.headers.forEach((value, name) => {
    if (isAppSessionFetchResponseHeaderBlocked(name)) {
      return;
    }
    headers.push([name, value]);
  });
  return {
    status: response.status,
    statusText: response.statusText,
    headers,
    body: await response.arrayBuffer(),
  };
}

function isAppSessionFetchResponseHeaderBlocked(name: string): boolean {
  const lowerName = name.toLowerCase();
  return lowerName === "set-cookie" || lowerName === "set-cookie2";
}

async function fetchAppSession(appSession: HostAppSession | null, payload: unknown): Promise<unknown> {
  const request = buildAppSessionFetchRequest(appSession, payload);
  return await serializeAppSessionFetchResponse(await fetch(request));
}

function validateConnectRequest(appSession: HostAppSession | null, payload: unknown): boolean {
  if (!appSession) {
    return true;
  }
  const record = asRecord(payload);
  const boot = asRecord(record?.boot);
  return boot?.sessionId === appSession.sessionId && boot?.clientId === appSession.clientId;
}

async function refreshAppSession(appSession: HostAppSession | null, payload: unknown): Promise<unknown> {
  const session = validateSessionPayload(appSession, payload);
  const response = await fetch(appClientRefreshUrl(session), {
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
  return await response.json();
}

function waitForSocketOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) {
    return Promise.resolve();
  }
  if (socket.readyState === WebSocket.CLOSING || socket.readyState === WebSocket.CLOSED) {
    return Promise.reject(new Error("package backend socket closed"));
  }
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);
    };
    const onOpen = (): void => {
      cleanup();
      resolve();
    };
    const onError = (): void => {
      cleanup();
      reject(new Error("package backend socket error"));
    };
    const onClose = (event: CloseEvent): void => {
      cleanup();
      reject(new Error(`package backend socket closed (${event.code})`));
    };
    socket.addEventListener("open", onOpen);
    socket.addEventListener("error", onError);
    socket.addEventListener("close", onClose);
  });
}

async function handleRpc(
  chrome: HostChromeController | null,
  appSession: HostAppSession | null,
  backendConnections: Map<string, HostBackendConnection>,
  port: MessagePort,
  message: HostRpcMessage,
): Promise<unknown> {
  switch (message.method) {
    case "setTitle": {
      const payload = asRecord(message.payload);
      chrome?.setTitle(asString(payload?.title));
      return { ok: true };
    }
    case "setBadge": {
      const payload = asRecord(message.payload);
      chrome?.setBadge(asString(payload?.badge));
      return { ok: true };
    }
    case "setDirty": {
      const payload = asRecord(message.payload);
      chrome?.setDirty(asBoolean(payload?.dirty));
      return { ok: true };
    }
    case "requestNewWindow": {
      const payload = asRecord(message.payload);
      const route = asString(payload?.route) ?? undefined;
      return { windowId: chrome?.requestNewWindow(route) ?? null };
    }
    case "appSession.refresh": {
      return await refreshAppSession(appSession, message.payload);
    }
    case "appSession.fetch": {
      return await fetchAppSession(appSession, message.payload);
    }
    case "backend.connect": {
      const session = validateSessionPayload(appSession, message.payload);
      const connectionId = `backend:${session.sessionId}:${session.clientId}:${crypto.randomUUID()}`;
      const socket = new WebSocket(buildRpcWebSocketUrl(session.rpcBase));
      backendConnections.set(connectionId, { socket });
      socket.addEventListener("message", (event) => {
        if (typeof event.data === "string") {
          postMessage(port, { type: "backend-message", connectionId, data: event.data });
        }
      });
      socket.addEventListener("close", (event) => {
        backendConnections.delete(connectionId);
        postMessage(port, {
          type: "backend-close",
          connectionId,
          code: event.code,
          reason: event.reason,
          wasClean: event.wasClean,
        });
      });
      socket.addEventListener("error", () => {
        postMessage(port, {
          type: "backend-error",
          connectionId,
          error: "package backend socket error",
        });
      });
      try {
        await waitForSocketOpen(socket);
      } catch (error) {
        backendConnections.delete(connectionId);
        if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) {
          socket.close(1000, "open failed");
        }
        throw error;
      }
      return { connectionId };
    }
    case "backend.send": {
      const payload = asRecord(message.payload);
      const connectionId = asString(payload?.connectionId);
      const data = asString(payload?.data);
      if (!connectionId || data === null) {
        throw new Error("Invalid backend frame");
      }
      const connection = backendConnections.get(connectionId);
      if (!connection || connection.socket.readyState !== WebSocket.OPEN) {
        throw new Error("package backend socket is closed");
      }
      connection.socket.send(data);
      return { ok: true };
    }
    case "backend.close": {
      const payload = asRecord(message.payload);
      const connectionId = asString(payload?.connectionId);
      if (!connectionId) {
        return { ok: true };
      }
      const connection = backendConnections.get(connectionId);
      backendConnections.delete(connectionId);
      if (connection && (connection.socket.readyState === WebSocket.CONNECTING || connection.socket.readyState === WebSocket.OPEN)) {
        connection.socket.close(1000, "client reconnect");
      }
      return { ok: true };
    }
  }

  throw new Error(`Unsupported host RPC method: ${String(message.method)}`);
}

export function attachHostBridge(
  iframe: HTMLIFrameElement,
  gatewayClient: HostStatusClient,
  chrome: HostChromeController | null = null,
  appSession: HostAppSession | null = null,
): HostBridgeController {
  let port: MessagePort | null = null;
  let unsubscribeStatus: (() => void) | null = null;
  const backendConnections = new Map<string, HostBackendConnection>();
  let iframeLoaded = false;
  let pendingConnectRequested = false;
  let pendingConnectRequestId: string | undefined;
  let destroyed = false;
  let frameInvalidated = false;

  const cleanup = (): void => {
    unsubscribeStatus?.();
    unsubscribeStatus = null;
    port?.close();
    port = null;
    for (const connection of backendConnections.values()) {
      if (connection.socket.readyState === WebSocket.CONNECTING || connection.socket.readyState === WebSocket.OPEN) {
        connection.socket.close(1000, "host bridge closed");
      }
    }
    backendConnections.clear();
  };

  const connect = (requestId?: string): void => {
    if (destroyed || frameInvalidated || !iframe.contentWindow) {
      return;
    }

    cleanup();

    const channel = new MessageChannel();
    port = channel.port1;
    port.onmessage = (event: MessageEvent<unknown>) => {
      const message = event.data;
      const record = asRecord(message);
      if (!record || record.type !== "rpc") {
        return;
      }

      void handleRpc(chrome, appSession, backendConnections, channel.port1, message as HostRpcMessage)
        .then((data) => {
          postMessage(channel.port1, {
            type: "rpc-result",
            id: String(record.id ?? ""),
            ok: true,
            data,
          });
        })
        .catch((error) => {
          postMessage(channel.port1, {
            type: "rpc-result",
            id: String(record.id ?? ""),
            ok: false,
            error: toErrorMessage(error),
          });
        });
    };
    port.start();

    iframe.contentWindow.postMessage(
      {
        type: "gsv-host-connect",
        requestId,
      } satisfies HostConnectMessage,
      "*",
      [channel.port2],
    );

    unsubscribeStatus = gatewayClient.onStatus((status) => {
      postMessage(channel.port1, {
        type: "status",
        status,
      });
    });
  };

  const onLoad = (): void => {
    if (destroyed) {
      return;
    }
    if (iframeLoaded) {
      frameInvalidated = true;
      pendingConnectRequested = false;
      pendingConnectRequestId = undefined;
      cleanup();
      return;
    }
    iframeLoaded = true;
    if (!appSession || pendingConnectRequested) {
      connect(pendingConnectRequestId);
    }
    pendingConnectRequested = false;
    pendingConnectRequestId = undefined;
  };

  const onConnectRequest = (event: MessageEvent<unknown>): void => {
    if (destroyed || frameInvalidated || event.source !== iframe.contentWindow) {
      return;
    }
    const record = asRecord(event.data);
    if (!record || record.type !== "gsv-host-connect-request") {
      return;
    }
    if (!validateConnectRequest(appSession, record)) {
      return;
    }
    const requestId = asString(record.requestId) ?? undefined;
    if (!iframeLoaded) {
      pendingConnectRequested = true;
      pendingConnectRequestId = requestId;
      return;
    }
    connect(requestId);
  };

  iframe.addEventListener("load", onLoad);
  window.addEventListener("message", onConnectRequest);

  return {
    destroy: () => {
      destroyed = true;
      iframe.removeEventListener("load", onLoad);
      window.removeEventListener("message", onConnectRequest);
      cleanup();
    },
  };
}
