import type { KernelContext } from "./context";
import { getVisibleTarget } from "./targets";
import {
  jsonValueSchema,
  type JsonValue,
  type NetFetchArgs,
  type NetFetchResult,
} from "@humansandmachines/gsv/protocol";
import type { FrameBody, ResponseOkFrame } from "../protocol/frames";
import { abortError, bindStreamToAbort } from "../shared/streams";
import { z } from "zod";

export type NetFetchDeviceTransport = {
  requestDevice: (
    deviceId: string,
    call: "net.fetch",
    args: NetFetchArgs,
    options?: { ttlMs?: number; body?: FrameBody; signal?: AbortSignal },
  ) => Promise<ResponseOkFrame<"net.fetch">>;
};

type RoutedFetchInit = RequestInit & { timeoutMs?: number };
export type RoutedFetch = (
  input: RequestInfo | URL,
  init?: RoutedFetchInit,
) => Promise<Response>;
type NetFetchRedirect = NonNullable<NetFetchArgs["redirect"]>;
type NormalizedNetFetchRequest = {
  url: string;
  method: string;
  headers: Headers;
  body?: BodyInit;
  redirect: NetFetchRedirect;
  timeoutMs: number;
};
type NetFetchFrameResult = { data: NetFetchResult; body?: FrameBody };
type NetFetchOutbound = { args: NetFetchArgs; body?: FrameBody };
type CancellationReason = string | Error | null | undefined;
type NetFetchDeviceRequestOptions = {
  ttlMs: number;
  signal: AbortSignal;
  body?: FrameBody;
};

const netFetchResultSchema = z.object({
  ok: z.boolean().optional().default(false),
  url: z.string().optional().default(""),
  status: z.number(),
  statusText: z.string().optional().default(""),
  headers: z.record(z.string(), z.string()).optional().default({}),
  redirected: z.boolean().optional().default(false),
});
const legacyNetFetchFieldsSchema = z.object({
  body: z.unknown().optional(),
  bodyBase64: z.unknown().optional(),
});

const NET_FETCH_CALL = "net.fetch";
const DEFAULT_NET_FETCH_TIMEOUT_MS = 60_000;
export const MAX_NET_FETCH_TIMEOUT_MS = 10 * 60_000;
export const MAX_NET_FETCH_REQUEST_BYTES = 32 * 1024 * 1024;
export const MAX_NET_FETCH_RESPONSE_BYTES = 32 * 1024 * 1024;

export async function handleNetFetch(
  args: NetFetchArgs,
  ctx: KernelContext,
  body?: FrameBody,
): Promise<{ data: NetFetchResult; body?: FrameBody }> {
  const request = await normalizeNetFetchRequest(args, body);
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new Error(`net.fetch timed out after ${request.timeoutMs}ms`));
  }, request.timeoutMs);
  const signal = ctx.requestSignal
    ? AbortSignal.any([controller.signal, ctx.requestSignal])
    : controller.signal;
  let bodyOwnsTimeout = false;

  try {
    const redirect = request.redirect === "error" ? "manual" : request.redirect;
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect,
      signal,
    });
    if (request.redirect === "error" && isRedirectStatus(response.status)) {
      throw new TypeError("net.fetch encountered a redirect with redirect mode error");
    }
    const result = netFetchResultFromResponse(response, () => clearTimeout(timeout));
    bodyOwnsTimeout = Boolean(result.body);
    return result;
  } finally {
    if (!bodyOwnsTimeout) {
      clearTimeout(timeout);
    }
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
    const requestedRedirect = normalizeRedirect(
      init?.redirect ?? (input instanceof Request ? input.redirect : undefined),
    );
    const callerSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const signal = ctx.requestSignal && callerSignal
      ? AbortSignal.any([ctx.requestSignal, callerSignal])
      : ctx.requestSignal ?? callerSignal;
    const requestInit: RequestInit = {
      ...init,
    };
    if (requestedRedirect === "error") requestInit.redirect = "manual";
    if (signal) requestInit.signal = signal;
    const request = new Request(input, requestInit);
    const outbound = requestToNetFetchArgs(request, requestedRedirect);
    const timeoutMs = normalizeNetFetchTimeoutMs(init?.timeoutMs);
    outbound.args.timeoutMs = timeoutMs;
    const response = await requestNetFetchWithSignal(
      () => {
        const options: NetFetchDeviceRequestOptions = {
          ttlMs: timeoutMs,
          signal: request.signal,
        };
        if (outbound.body) options.body = outbound.body;
        return transport.requestDevice(normalizedTarget, NET_FETCH_CALL, outbound.args, options);
      },
      request.signal,
      outbound.body,
    );
    return responseFromNetFetchResult(
      jsonValueSchema.parse(response.data),
      response.body,
      request.signal,
    );
  };
}

export function normalizeTarget(value: string | undefined): string {
  const normalized = value?.trim() ?? "";
  return normalized && normalized !== "worker" ? normalized : "gsv";
}

async function normalizeNetFetchRequest(
  args: NetFetchArgs,
  frameBody?: FrameBody,
): Promise<NormalizedNetFetchRequest> {
  const legacy = legacyNetFetchFieldsSchema.parse(args);
  const legacyField = legacy.body !== undefined
    ? "body"
    : legacy.bodyBase64 !== undefined
      ? "bodyBase64"
      : undefined;
  if (legacyField) {
    await frameBody?.stream.cancel().catch(() => {});
    throw new Error(`net.fetch args.${legacyField} was removed; use a request body`);
  }
  const url = normalizeHttpUrl(args.url);
  const method = normalizeMethod(args.method);
  const headers = new Headers();
  for (const [key, value] of Object.entries(args.headers ?? {})) {
    headers.append(key, value);
  }
  if ((method === "GET" || method === "HEAD") && frameBody) {
    if (frameBody) {
      await frameBody.stream.cancel().catch(() => {});
    }
    throw new Error(`${method} requests cannot include a body`);
  }
  if (frameBody?.length !== undefined && frameBody.length > MAX_NET_FETCH_REQUEST_BYTES) {
    const error = new Error(formatNetFetchBodySizeError(
      "request",
      frameBody.length,
      MAX_NET_FETCH_REQUEST_BYTES,
    ));
    await frameBody.stream.cancel(error).catch(() => {});
    throw error;
  }
  const body = frameBody
    ? limitNetFetchRequestBody(frameBody.stream, MAX_NET_FETCH_REQUEST_BYTES)
    : undefined;

  const request: NormalizedNetFetchRequest = {
    url,
    method,
    headers,
    redirect: normalizeRedirect(args.redirect),
    timeoutMs: normalizeNetFetchTimeoutMs(args.timeoutMs),
  };
  if (body) request.body = body;
  return request;
}

export function limitNetFetchRequestBody(
  stream: ReadableStream<Uint8Array>,
  maxBytes = MAX_NET_FETCH_REQUEST_BYTES,
): ReadableStream<Uint8Array> {
  return limitNetFetchBody(stream, "request", maxBytes);
}

export function requestToNetFetchArgs(
  request: Request,
  redirect: NetFetchArgs["redirect"] = normalizeRedirect(request.redirect),
): NetFetchOutbound {
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });

  const contentLength = parseContentLength(request.headers.get("content-length"));
  let body: FrameBody | undefined;
  if (request.method !== "GET" && request.method !== "HEAD" && request.body) {
    body = { stream: request.body };
    if (contentLength !== null) body.length = contentLength;
  }

  const result: NetFetchOutbound = {
    args: {
      url: request.url,
      method: request.method,
      headers,
      redirect,
    },
  };
  if (body) result.body = body;
  return result;
}

function netFetchResultFromResponse(
  response: Response,
  onBodyDone: () => void,
): NetFetchFrameResult {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  const body = response.body
    ? limitNetFetchResponseBody(response.body, response.headers, onBodyDone)
    : undefined;
  const result: NetFetchFrameResult = {
    data: {
      ok: response.ok,
      url: response.url,
      status: response.status,
      statusText: response.statusText,
      headers,
      redirected: response.redirected,
    },
  };
  if (body) result.body = { stream: body };
  return result;
}

export function limitNetFetchResponseBody(
  stream: ReadableStream<Uint8Array>,
  headers: Headers,
  onDone: () => void,
  maxBytes = MAX_NET_FETCH_RESPONSE_BYTES,
): ReadableStream<Uint8Array> {
  const contentLength = parseContentLength(headers.get("content-length"));
  if (contentLength !== null && contentLength > maxBytes) {
    const error = new Error(formatNetFetchBodySizeError("response", contentLength, maxBytes));
    void stream.cancel(error).catch(() => {});
    throw error;
  }

  return limitNetFetchBody(stream, "response", maxBytes, onDone);
}

function limitNetFetchBody(
  stream: ReadableStream<Uint8Array>,
  direction: "request" | "response",
  maxBytes: number,
  onDone: () => void = () => {},
): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  let total = 0;
  let finished = false;
  const finish = () => {
    if (!finished) {
      finished = true;
      reader.releaseLock();
      onDone();
    }
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          finish();
          controller.close();
          return;
        }
        if (!value || value.byteLength === 0) {
          return;
        }
        total += value.byteLength;
        if (total > maxBytes) {
          const error = new Error(formatNetFetchBodySizeError(direction, total, maxBytes));
          await reader.cancel(error).catch(() => {});
          finish();
          controller.error(error);
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        await reader.cancel(error).catch(() => {});
        finish();
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => {});
      finish();
    },
  });
}

export async function requestNetFetchWithSignal(
  start: () => Promise<ResponseOkFrame>,
  signal: AbortSignal,
  requestBody?: FrameBody,
  cancelRequest?: (reason: CancellationReason) => void | Promise<void>,
): Promise<ResponseOkFrame> {
  const cancel = (reason: CancellationReason) => {
    try {
      void requestBody?.stream.cancel(reason).catch(() => {});
    } catch {}
    try {
      void Promise.resolve(cancelRequest?.(reason)).catch(() => {});
    } catch {}
  };
  if (signal.aborted) {
    cancel(signal.reason);
    throw abortError(signal.reason);
  }

  const request = start();
  return await new Promise((resolve, reject) => {
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      cancel(signal.reason);
      reject(abortError(signal.reason));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    request.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        if (aborted) {
          void value.body?.stream.cancel(signal.reason).catch(() => {});
          return;
        }
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        if (!aborted) {
          reject(error);
        }
      },
    );
  });
}

export function responseFromNetFetchResult(
  raw: JsonValue | undefined,
  frameBody?: FrameBody,
  signal?: AbortSignal,
): Response {
  try {
    if (!raw) {
      throw new Error("net.fetch returned an invalid response");
    }
    const result = netFetchResultSchema.parse(raw);
    const status = result.status;
    if (!Number.isInteger(status) || status < 200 || status > 599) {
      throw new Error("net.fetch returned an invalid HTTP status");
    }
    const nullBody = isNullBodyStatus(status);
    if (nullBody && frameBody) {
      void frameBody.stream.cancel().catch(() => {});
    }
    const stream = !nullBody && frameBody
      ? signal
        ? bindStreamToAbort(frameBody.stream, signal)
        : frameBody.stream
      : null;
    const response = new Response(stream, {
      status,
      statusText: result.statusText,
      headers: result.headers,
    });
    if (result.url.length > 0) {
      try {
        Object.defineProperty(response, "url", { value: result.url });
        Object.defineProperty(response, "redirected", { value: result.redirected });
      } catch {}
    }
    return response;
  } catch (error) {
    void frameBody?.stream.cancel(error).catch(() => {});
    throw error;
  }
}

function normalizeHttpUrl(value: string): string {
  if (value.trim().length === 0) {
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

function normalizeMethod(value: string | undefined): string {
  const method = value?.trim()
    ? value.trim().toUpperCase()
    : "GET";
  if (!/^[A-Z]+$/.test(method)) {
    throw new Error("net.fetch method must contain only letters");
  }
  return method;
}

function normalizeRedirect(value: string | undefined): NetFetchRedirect {
  if (value === undefined) {
    return "follow";
  }
  if (value === "follow" || value === "error" || value === "manual") {
    return value;
  }
  throw new Error("net.fetch redirect must be follow, error, or manual");
}

export function normalizeNetFetchTimeoutMs(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? Math.min(Math.floor(value), MAX_NET_FETCH_TIMEOUT_MS)
    : DEFAULT_NET_FETCH_TIMEOUT_MS;
}

function isNullBodyStatus(status: number): boolean {
  return status === 204 || status === 205 || status === 304;
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function parseContentLength(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function formatNetFetchBodySizeError(
  direction: "request" | "response",
  actualBytes: number,
  maxBytes: number,
): string {
  return `net.fetch ${direction} body exceeds limit (${actualBytes} bytes, max ${maxBytes})`;
}
