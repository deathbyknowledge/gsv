import {
  acquireDebugger,
  addDebuggerDetachListener,
  addDebuggerEventListener,
  isDebuggerAttached,
  releaseDebugger,
  sendDebuggerCommand,
} from "../shared/debugger";
import type { TargetFileSystem } from "./types";

type HeaderMap = Record<string, string>;

export type NetworkCaptureOptions = {
  tabId: number;
  bodies: boolean;
  persist: boolean;
  bodyLimit: number;
  fs: TargetFileSystem;
};

export type NetworkBodyRecord = {
  content: string;
  base64Encoded: boolean;
  byteLength: number;
  truncated: boolean;
  path?: string;
};

export type NetworkRequestRecord = {
  tabId: number;
  requestId: string;
  loaderId?: string;
  frameId?: string;
  type?: string;
  url: string;
  method: string;
  documentURL?: string;
  requestHeaders?: HeaderMap;
  requestPostData?: string;
  initiator?: unknown;
  wallTime?: number;
  timestamp?: number;
  status?: number;
  statusText?: string;
  mimeType?: string;
  responseHeaders?: HeaderMap;
  remoteIPAddress?: string;
  remotePort?: number;
  protocol?: string;
  fromDiskCache?: boolean;
  fromServiceWorker?: boolean;
  encodedDataLength?: number;
  errorText?: string;
  canceled?: boolean;
  finishedAt?: string;
  failedAt?: string;
  body?: NetworkBodyRecord;
  bodyError?: string;
};

export type NetworkEventRecord = {
  seq: number;
  tabId: number;
  at: string;
  type: string;
  requestId?: string;
  url?: string;
  method?: string;
  status?: number;
  mimeType?: string;
  encodedDataLength?: number;
  errorText?: string;
};

export type NetworkCaptureStatus = {
  tabId: number;
  active: boolean;
  startedAt: string;
  bodies: boolean;
  persist: boolean;
  bodyLimit: number;
  eventCount: number;
  requestCount: number;
  sessionPath?: string;
};

type CaptureState = {
  tabId: number;
  target: chrome.debugger.DebuggerSession;
  startedAt: string;
  bodies: boolean;
  persist: boolean;
  bodyLimit: number;
  fs: TargetFileSystem;
  sessionPath?: string;
  seq: number;
  events: NetworkEventRecord[];
  requests: Map<string, NetworkRequestRecord>;
};

type RequestWillBeSentParams = {
  requestId?: string;
  loaderId?: string;
  documentURL?: string;
  request?: {
    url?: string;
    method?: string;
    headers?: Record<string, unknown>;
    postData?: string;
  };
  timestamp?: number;
  wallTime?: number;
  initiator?: unknown;
  type?: string;
  frameId?: string;
};

type RequestExtraInfoParams = {
  requestId?: string;
  headers?: Record<string, unknown>;
};

type ResponseReceivedParams = {
  requestId?: string;
  type?: string;
  response?: {
    url?: string;
    status?: number;
    statusText?: string;
    headers?: Record<string, unknown>;
    mimeType?: string;
    remoteIPAddress?: string;
    remotePort?: number;
    protocol?: string;
    fromDiskCache?: boolean;
    fromServiceWorker?: boolean;
  };
};

type LoadingFinishedParams = {
  requestId?: string;
  encodedDataLength?: number;
};

type LoadingFailedParams = {
  requestId?: string;
  errorText?: string;
  canceled?: boolean;
};

type ResponseBodyResult = {
  body?: string;
  base64Encoded?: boolean;
};

const captures = new Map<number, CaptureState>();
const MAX_EVENTS_PER_TAB = 2_000;
let removeDebuggerEventListener: (() => void) | null = null;
let removeDebuggerDetachListener: (() => void) | null = null;
let removeTabRemovedListener: (() => void) | null = null;

export async function startNetworkCapture(options: NetworkCaptureOptions): Promise<NetworkCaptureStatus> {
  ensureNetworkListener();
  const existing = captures.get(options.tabId);
  if (existing) {
    if (isDebuggerAttached(existing.tabId)) {
      assertSameCaptureOptions(existing, options);
      return captureStatus(existing);
    }
    removeCapture(existing.tabId, {
      type: "captureDetached",
      errorText: "debugger session is no longer attached",
    });
    ensureNetworkListener();
  }

  const target = await acquireDebugger(options.tabId);
  const startedAt = new Date().toISOString();
  const state: CaptureState = {
    tabId: options.tabId,
    target,
    startedAt,
    bodies: options.bodies,
    persist: options.persist,
    bodyLimit: options.bodyLimit,
    fs: options.fs,
    sessionPath: options.persist ? `/home/browser/network/sessions/${startedAt.replace(/\D/g, "").slice(0, 14)}-tab-${options.tabId}` : undefined,
    seq: 0,
    events: [],
    requests: new Map(),
  };

  try {
    if (state.sessionPath) {
      await options.fs.mkdir(`${state.sessionPath}/requests`);
      await options.fs.write(`${state.sessionPath}/status.json`, jsonBytes(captureStatus(state)));
    }
    await sendDebuggerCommand(target, "Network.enable", {
      maxResourceBufferSize: options.bodyLimit,
      maxTotalBufferSize: Math.max(options.bodyLimit * 4, options.bodyLimit),
    });
    captures.set(options.tabId, state);
    recordEvent(state, { type: "captureStarted" });
    return captureStatus(state);
  } catch (error) {
    await releaseDebugger(options.tabId).catch(() => undefined);
    throw error;
  }
}

function assertSameCaptureOptions(existing: CaptureState, options: NetworkCaptureOptions): void {
  if (
    existing.bodies === options.bodies
    && existing.persist === options.persist
    && existing.bodyLimit === options.bodyLimit
  ) {
    return;
  }
  throw new Error(
    `Network capture already active for tab ${options.tabId}. Stop it before changing --bodies, --persist, or --body-limit.`,
  );
}

export async function stopNetworkCapture(tabId?: number): Promise<NetworkCaptureStatus[]> {
  const states = captureStates(tabId);
  const statuses: NetworkCaptureStatus[] = [];

  for (const state of states) {
    recordEvent(state, { type: "captureStopped" });
    captures.delete(state.tabId);
    statuses.push({ ...captureStatus(state), active: false });
    await releaseDebugger(state.tabId).catch(() => undefined);
  }

  maybeRemoveNetworkListener();
  return statuses;
}

export function networkStatus(tabId?: number): NetworkCaptureStatus[] {
  return captureStates(tabId).map(captureStatus);
}

export function networkEvents(options: { tabId?: number; limit: number; url?: string }): NetworkEventRecord[] {
  const urlFilter = options.url?.toLowerCase();
  return captureStates(options.tabId)
    .flatMap((state) => state.events)
    .filter((event) => !urlFilter || (event.url ?? "").toLowerCase().includes(urlFilter))
    .sort((left, right) => left.at.localeCompare(right.at) || left.seq - right.seq)
    .slice(-options.limit);
}

export async function networkRequest(requestId: string, includeBody: boolean): Promise<NetworkRequestRecord | null> {
  const found = findRequest(requestId);
  if (!found) {
    return null;
  }
  if (includeBody && !found.request.body && !found.request.bodyError) {
    await fetchAndStoreBody(found.state, found.requestId);
  }
  return cloneRequest(found.request);
}

export function clearNetworkCapture(tabId?: number): number {
  const states = captureStates(tabId);
  let cleared = 0;
  for (const state of states) {
    cleared += state.events.length + state.requests.size;
    state.events = [];
    state.requests.clear();
    state.seq = 0;
    recordEvent(state, { type: "captureCleared" });
  }
  return cleared;
}

export function networkRequests(tabId?: number): NetworkRequestRecord[] {
  return captureStates(tabId).flatMap((state) => Array.from(state.requests.values()).map(cloneRequest));
}

export function networkEventsJsonl(tabId?: number): string {
  return `${captureStates(tabId).flatMap((state) => state.events).map((event) => JSON.stringify(event)).join("\n")}\n`;
}

export function networkStatusSnapshot(): unknown {
  return {
    captures: networkStatus(),
    activeCount: captures.size,
  };
}

export function networkRequestsSnapshot(): unknown {
  return {
    requests: networkRequests(),
    count: networkRequests().length,
  };
}

export async function networkHar(tabId?: number): Promise<unknown> {
  const entries = networkRequests(tabId).map((request) => {
    const requestHeaders = headersToHar(request.requestHeaders);
    const responseHeaders = headersToHar(request.responseHeaders);
    return {
      startedDateTime: request.wallTime ? new Date(request.wallTime * 1000).toISOString() : request.finishedAt ?? request.failedAt ?? new Date().toISOString(),
      time: -1,
      request: {
        method: request.method,
        url: request.url,
        httpVersion: "HTTP/1.1",
        headers: requestHeaders,
        queryString: queryStringFor(request.url),
        cookies: [],
        headersSize: -1,
        bodySize: request.requestPostData ? byteLength(request.requestPostData) : 0,
        postData: request.requestPostData ? {
          mimeType: headerValue(request.requestHeaders, "content-type") ?? "",
          text: request.requestPostData,
        } : undefined,
      },
      response: {
        status: request.status ?? 0,
        statusText: request.statusText ?? "",
        httpVersion: request.protocol ?? "HTTP/1.1",
        headers: responseHeaders,
        cookies: [],
        content: {
          size: request.body?.byteLength ?? request.encodedDataLength ?? 0,
          mimeType: request.mimeType ?? headerValue(request.responseHeaders, "content-type") ?? "",
          text: request.body && !request.body.truncated ? request.body.content : undefined,
          encoding: request.body?.base64Encoded ? "base64" : undefined,
        },
        redirectURL: headerValue(request.responseHeaders, "location") ?? "",
        headersSize: -1,
        bodySize: request.encodedDataLength ?? request.body?.byteLength ?? -1,
      },
      cache: {},
      timings: {
        blocked: -1,
        dns: -1,
        connect: -1,
        send: -1,
        wait: -1,
        receive: -1,
        ssl: -1,
      },
      _gsv: {
        tabId: request.tabId,
        requestId: request.requestId,
        type: request.type,
        errorText: request.errorText,
        canceled: request.canceled,
        bodyPath: request.body?.path,
      },
    };
  });

  return {
    log: {
      version: "1.2",
      creator: {
        name: "gsv-browser-extension",
        version: "0.2.8",
      },
      entries,
    },
  };
}

function ensureNetworkListener(): void {
  if (!removeDebuggerEventListener) {
    removeDebuggerEventListener = addDebuggerEventListener((source, method, params) => {
      if (typeof source.tabId !== "number") {
        return;
      }
      const state = captures.get(source.tabId);
      if (!state) {
        return;
      }
      void handleNetworkEvent(state, method, params ?? {});
    });
  }

  if (!removeDebuggerDetachListener) {
    removeDebuggerDetachListener = addDebuggerDetachListener((source, reason) => {
      if (typeof source.tabId !== "number") {
        return;
      }
      removeCapture(source.tabId, {
        type: "captureDetached",
        errorText: reason,
      });
    });
  }

  if (!removeTabRemovedListener && typeof chrome !== "undefined" && chrome.tabs?.onRemoved) {
    const listener = (tabId: number): void => {
      if (removeCapture(tabId, { type: "captureTabRemoved" })) {
        void releaseDebugger(tabId).catch(() => undefined);
      }
    };
    chrome.tabs.onRemoved.addListener(listener);
    removeTabRemovedListener = () => chrome.tabs.onRemoved.removeListener(listener);
  }
}

function maybeRemoveNetworkListener(): void {
  if (captures.size > 0) {
    return;
  }
  removeDebuggerEventListener?.();
  removeDebuggerEventListener = null;
  removeDebuggerDetachListener?.();
  removeDebuggerDetachListener = null;
  removeTabRemovedListener?.();
  removeTabRemovedListener = null;
}

function removeCapture(tabId: number, event: Omit<NetworkEventRecord, "seq" | "tabId" | "at">): boolean {
  const state = captures.get(tabId);
  if (!state) {
    return false;
  }
  captures.delete(tabId);
  recordEvent(state, event);
  maybeRemoveNetworkListener();
  return true;
}

function captureStates(tabId?: number): CaptureState[] {
  const states = tabId === undefined
    ? Array.from(captures.values())
    : captures.has(tabId) ? [captures.get(tabId) as CaptureState] : [];
  for (const state of states) {
    if (!isDebuggerAttached(state.tabId)) {
      removeCapture(state.tabId, {
        type: "captureDetached",
        errorText: "debugger session is no longer attached",
      });
    }
  }
  return states.filter((state) => captures.get(state.tabId) === state);
}

async function handleNetworkEvent(state: CaptureState, method: string, raw: object): Promise<void> {
  switch (method) {
    case "Network.requestWillBeSent":
      handleRequestWillBeSent(state, raw as RequestWillBeSentParams);
      return;
    case "Network.requestWillBeSentExtraInfo":
      handleRequestExtraInfo(state, raw as RequestExtraInfoParams);
      return;
    case "Network.responseReceived":
      handleResponseReceived(state, raw as ResponseReceivedParams);
      return;
    case "Network.responseReceivedExtraInfo":
      handleResponseExtraInfo(state, raw as RequestExtraInfoParams);
      return;
    case "Network.loadingFinished":
      await handleLoadingFinished(state, raw as LoadingFinishedParams);
      return;
    case "Network.loadingFailed":
      handleLoadingFailed(state, raw as LoadingFailedParams);
      return;
    default:
      return;
  }
}

function handleRequestWillBeSent(state: CaptureState, params: RequestWillBeSentParams): void {
  if (!params.requestId || !params.request?.url) {
    return;
  }
  const request = ensureRequest(state, params.requestId, params.request.url, params.request.method ?? "GET");
  request.loaderId = params.loaderId;
  request.frameId = params.frameId;
  request.type = params.type;
  request.documentURL = params.documentURL;
  request.requestHeaders = normalizeHeaders(params.request.headers);
  request.requestPostData = params.request.postData;
  request.initiator = params.initiator;
  request.wallTime = params.wallTime;
  request.timestamp = params.timestamp;
  recordEvent(state, {
    type: "request",
    requestId: params.requestId,
    url: request.url,
    method: request.method,
  });
  void persistRequestMeta(state, request);
}

function handleRequestExtraInfo(state: CaptureState, params: RequestExtraInfoParams): void {
  if (!params.requestId) {
    return;
  }
  const request = state.requests.get(params.requestId);
  if (!request) {
    return;
  }
  request.requestHeaders = {
    ...(request.requestHeaders ?? {}),
    ...normalizeHeaders(params.headers),
  };
  void persistRequestMeta(state, request);
}

function handleResponseReceived(state: CaptureState, params: ResponseReceivedParams): void {
  if (!params.requestId || !params.response?.url) {
    return;
  }
  const request = ensureRequest(state, params.requestId, params.response.url, "GET");
  request.type = params.type ?? request.type;
  request.status = params.response.status;
  request.statusText = params.response.statusText;
  request.mimeType = params.response.mimeType;
  request.responseHeaders = normalizeHeaders(params.response.headers);
  request.remoteIPAddress = params.response.remoteIPAddress;
  request.remotePort = params.response.remotePort;
  request.protocol = params.response.protocol;
  request.fromDiskCache = params.response.fromDiskCache;
  request.fromServiceWorker = params.response.fromServiceWorker;
  recordEvent(state, {
    type: "response",
    requestId: params.requestId,
    url: request.url,
    status: request.status,
    mimeType: request.mimeType,
  });
  void persistRequestMeta(state, request);
}

function handleResponseExtraInfo(state: CaptureState, params: RequestExtraInfoParams): void {
  if (!params.requestId) {
    return;
  }
  const request = state.requests.get(params.requestId);
  if (!request) {
    return;
  }
  request.responseHeaders = {
    ...(request.responseHeaders ?? {}),
    ...normalizeHeaders(params.headers),
  };
  void persistRequestMeta(state, request);
}

async function handleLoadingFinished(state: CaptureState, params: LoadingFinishedParams): Promise<void> {
  if (!params.requestId) {
    return;
  }
  const request = state.requests.get(params.requestId);
  if (!request) {
    return;
  }
  request.encodedDataLength = params.encodedDataLength;
  request.finishedAt = new Date().toISOString();
  recordEvent(state, {
    type: "finished",
    requestId: params.requestId,
    url: request.url,
    encodedDataLength: request.encodedDataLength,
  });
  if (state.bodies) {
    await fetchAndStoreBody(state, params.requestId);
  } else {
    await persistRequestMeta(state, request);
  }
}

function handleLoadingFailed(state: CaptureState, params: LoadingFailedParams): void {
  if (!params.requestId) {
    return;
  }
  const request = state.requests.get(params.requestId);
  if (!request) {
    return;
  }
  request.errorText = params.errorText;
  request.canceled = params.canceled;
  request.failedAt = new Date().toISOString();
  recordEvent(state, {
    type: "failed",
    requestId: params.requestId,
    url: request.url,
    errorText: request.errorText,
  });
  void persistRequestMeta(state, request);
}

async function fetchAndStoreBody(state: CaptureState, requestId: string): Promise<void> {
  const request = state.requests.get(requestId);
  if (!request) {
    return;
  }

  try {
    const result = await sendDebuggerCommand<ResponseBodyResult>(state.target, "Network.getResponseBody", {
      requestId,
    });
    const content = result.body ?? "";
    const base64Encoded = Boolean(result.base64Encoded);
    const byteCount = base64Encoded ? base64ByteLength(content) : byteLength(content);
    const truncated = byteCount > state.bodyLimit;
    const storedContent = truncated && !base64Encoded
      ? content.slice(0, state.bodyLimit)
      : truncated ? "" : content;
    request.body = {
      content: storedContent,
      base64Encoded,
      byteLength: byteCount,
      truncated,
    };

    if (state.sessionPath) {
      const extension = base64Encoded ? "base64" : bodyExtension(request);
      const path = `${state.sessionPath}/requests/${safeRequestId(requestId)}/response-body.${extension}`;
      await state.fs.mkdir(`${state.sessionPath}/requests/${safeRequestId(requestId)}`);
      await state.fs.write(path, textBytes(storedContent));
      request.body.path = path;
    }
    await persistRequestMeta(state, request);
    recordEvent(state, {
      type: "body",
      requestId,
      url: request.url,
      encodedDataLength: byteCount,
    });
  } catch (error) {
    request.bodyError = errorMessage(error);
    await persistRequestMeta(state, request);
  }
}

function ensureRequest(state: CaptureState, requestId: string, url: string, method: string): NetworkRequestRecord {
  const existing = state.requests.get(requestId);
  if (existing) {
    existing.url = url;
    existing.method = method;
    return existing;
  }
  const request: NetworkRequestRecord = {
    tabId: state.tabId,
    requestId,
    url,
    method,
  };
  state.requests.set(requestId, request);
  return request;
}

function recordEvent(state: CaptureState, event: Omit<NetworkEventRecord, "seq" | "tabId" | "at">): void {
  const record: NetworkEventRecord = {
    seq: state.seq,
    tabId: state.tabId,
    at: new Date().toISOString(),
    ...event,
  };
  state.seq += 1;
  state.events.push(record);
  if (state.events.length > MAX_EVENTS_PER_TAB) {
    state.events.splice(0, state.events.length - MAX_EVENTS_PER_TAB);
  }
  if (state.sessionPath) {
    void state.fs.append(`${state.sessionPath}/events.jsonl`, textBytes(`${JSON.stringify(record)}\n`));
  }
}

async function persistRequestMeta(state: CaptureState, request: NetworkRequestRecord): Promise<void> {
  if (!state.sessionPath) {
    return;
  }
  const directory = `${state.sessionPath}/requests/${safeRequestId(request.requestId)}`;
  await state.fs.mkdir(directory);
  await state.fs.write(`${directory}/meta.json`, jsonBytes(cloneRequest(request)));
}

function captureStatus(state: CaptureState): NetworkCaptureStatus {
  return {
    tabId: state.tabId,
    active: true,
    startedAt: state.startedAt,
    bodies: state.bodies,
    persist: state.persist,
    bodyLimit: state.bodyLimit,
    eventCount: state.events.length,
    requestCount: state.requests.size,
    sessionPath: state.sessionPath,
  };
}

function findRequest(requestId: string): { state: CaptureState; requestId: string; request: NetworkRequestRecord } | null {
  for (const state of captureStates()) {
    const request = state.requests.get(requestId);
    if (request) {
      return { state, requestId, request };
    }
  }
  return null;
}

function cloneRequest(request: NetworkRequestRecord): NetworkRequestRecord {
  return JSON.parse(JSON.stringify(request)) as NetworkRequestRecord;
}

function normalizeHeaders(headers: Record<string, unknown> | undefined): HeaderMap | undefined {
  if (!headers) {
    return undefined;
  }
  const normalized: HeaderMap = {};
  for (const [key, value] of Object.entries(headers)) {
    normalized[key] = String(value);
  }
  return normalized;
}

function headersToHar(headers: HeaderMap | undefined): Array<{ name: string; value: string }> {
  return Object.entries(headers ?? {}).map(([name, value]) => ({ name, value }));
}

function headerValue(headers: HeaderMap | undefined, name: string): string | undefined {
  const normalized = name.toLowerCase();
  return Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === normalized)?.[1];
}

function queryStringFor(url: string): Array<{ name: string; value: string }> {
  try {
    const parsed = new URL(url);
    return Array.from(parsed.searchParams.entries()).map(([name, value]) => ({ name, value }));
  } catch {
    return [];
  }
}

function bodyExtension(request: NetworkRequestRecord): string {
  const mime = (request.mimeType ?? headerValue(request.responseHeaders, "content-type") ?? "").toLowerCase();
  if (mime.includes("json")) return "json";
  if (mime.includes("html")) return "html";
  if (mime.includes("css")) return "css";
  if (mime.includes("javascript")) return "js";
  if (mime.startsWith("text/")) return "txt";
  return "txt";
}

function safeRequestId(requestId: string): string {
  return requestId.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function textBytes(content: string): Uint8Array {
  return new TextEncoder().encode(content);
}

function jsonBytes(content: unknown): Uint8Array {
  return textBytes(`${JSON.stringify(content, null, 2)}\n`);
}

function byteLength(content: string): number {
  return textBytes(content).byteLength;
}

function base64ByteLength(content: string): number {
  const padding = content.endsWith("==") ? 2 : content.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor(content.length * 3 / 4) - padding);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
