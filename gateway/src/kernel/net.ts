import type { KernelContext } from "./context";
import { getVisibleTarget } from "./targets";
import type { NetFetchArgs, NetFetchResult } from "../syscalls/net";

export type NetFetchDeviceTransport = {
  requestDevice: (
    deviceId: string,
    call: string,
    args: unknown,
    ttlMs?: number,
  ) => Promise<unknown>;
};

export type RoutedFetch = typeof fetch;
type RoutedFetchInit = RequestInit & { timeoutMs?: number };

const NET_FETCH_CALL = "net.fetch";
const DEFAULT_NET_FETCH_TIMEOUT_MS = 60_000;

export async function handleNetFetch(
  args: NetFetchArgs,
  _ctx: KernelContext,
): Promise<NetFetchResult> {
  const request = await normalizeNetFetchRequest(args);
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new Error(`net.fetch timed out after ${request.timeoutMs}ms`));
  }, request.timeoutMs);

  try {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: controller.signal,
    });
    return netFetchResultFromResponse(response);
  } finally {
    clearTimeout(timeout);
  }
}

export function createRoutedFetch(
  ctx: KernelContext,
  transport: NetFetchDeviceTransport | undefined,
  target: string | undefined,
): RoutedFetch {
  const normalizedTarget = normalizeTarget(target);
  if (normalizedTarget === "gsv") {
    return fetch;
  }
  if (!transport) {
    throw new Error(`No net.fetch transport available for target: ${normalizedTarget}`);
  }

  const visibleTarget = getVisibleTarget(ctx, normalizedTarget, { includeOffline: true });
  if (!visibleTarget) {
    throw new Error(`Access denied to device: ${normalizedTarget}`);
  }

  return async (input, init) => {
    const request = new Request(input, init);
    const args = await requestToNetFetchArgs(request);
    const timeoutMs = normalizeNetFetchTimeoutMs((init as RoutedFetchInit | undefined)?.timeoutMs);
    args.timeoutMs = timeoutMs;
    const result = await withAbortSignal(
      transport.requestDevice(normalizedTarget, NET_FETCH_CALL, args, timeoutMs),
      request.signal,
    );
    return responseFromNetFetchResult(result);
  };
}

export function normalizeTarget(value: string | undefined): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized && normalized !== "worker" ? normalized : "gsv";
}

async function normalizeNetFetchRequest(args: NetFetchArgs): Promise<{
  url: string;
  method: string;
  headers: Headers;
  body?: Uint8Array | string;
  timeoutMs: number;
}> {
  const input = args && typeof args === "object" ? args : ({} as NetFetchArgs);
  const url = normalizeHttpUrl(input.url);
  const method = normalizeMethod(input.method);
  const headers = new Headers();
  for (const [key, value] of Object.entries(input.headers ?? {})) {
    if (typeof value === "string") {
      headers.append(key, value);
    }
  }

  const body = input.bodyBase64 !== undefined
    ? base64ToBytes(String(input.bodyBase64))
    : input.body;
  if ((method === "GET" || method === "HEAD") && body !== undefined && String(body).length > 0) {
    throw new Error(`${method} requests cannot include a body`);
  }

  return {
    url,
    method,
    headers,
    ...(body !== undefined ? { body } : {}),
    timeoutMs: normalizeNetFetchTimeoutMs(input.timeoutMs),
  };
}

export async function requestToNetFetchArgs(request: Request): Promise<NetFetchArgs> {
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });

  let bodyBase64: string | undefined;
  if (request.method !== "GET" && request.method !== "HEAD") {
    const bodyBytes = new Uint8Array(await request.arrayBuffer());
    if (bodyBytes.byteLength > 0) {
      bodyBase64 = bytesToBase64(bodyBytes);
    }
  }

  return {
    url: request.url,
    method: request.method,
    headers,
    ...(bodyBase64 ? { bodyBase64 } : {}),
  };
}

async function netFetchResultFromResponse(response: Response): Promise<NetFetchResult> {
  const bodyBytes = new Uint8Array(await response.arrayBuffer());
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  const bodyText = decodeUtf8(bodyBytes);
  return {
    ok: response.ok,
    url: response.url,
    status: response.status,
    statusText: response.statusText,
    headers,
    bodyBase64: bytesToBase64(bodyBytes),
    ...(bodyText !== null ? { bodyText } : {}),
    bodyBytes: bodyBytes.byteLength,
  };
}

async function withAbortSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    throw abortError(signal.reason);
  }
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal.reason));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function abortError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error("The operation was aborted");
}

export function responseFromNetFetchResult(raw: unknown): Response {
  if (!raw || typeof raw !== "object") {
    throw new Error("net.fetch returned an invalid response");
  }
  const result = raw as Partial<NetFetchResult>;
  const status = typeof result.status === "number" ? result.status : 0;
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    throw new Error("net.fetch returned an invalid HTTP status");
  }
  const bodyBytes = typeof result.bodyBase64 === "string"
    ? base64ToBytes(result.bodyBase64)
    : new Uint8Array();
  const body: BodyInit | null = isNullBodyStatus(status) ? null : bodyBytes;
  return new Response(body, {
    status,
    statusText: typeof result.statusText === "string" ? result.statusText : "",
    headers: result.headers && typeof result.headers === "object"
      ? result.headers as Record<string, string>
      : undefined,
  });
}

function normalizeHttpUrl(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("net.fetch requires url");
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("net.fetch url must be an absolute HTTP(S) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("net.fetch url must use HTTP or HTTPS");
  }
  return url.toString();
}

function normalizeMethod(value: unknown): string {
  const method = typeof value === "string" && value.trim().length > 0
    ? value.trim().toUpperCase()
    : "GET";
  if (!/^[A-Z]+$/.test(method)) {
    throw new Error("net.fetch method must contain only letters");
  }
  return method;
}

export function normalizeNetFetchTimeoutMs(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : DEFAULT_NET_FETCH_TIMEOUT_MS;
}

function isNullBodyStatus(status: number): boolean {
  return status === 204 || status === 205 || status === 304;
}

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
