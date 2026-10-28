import type { BinaryBody, JsonValue } from "@humansandmachines/gsv/protocol";
import { bodyToBytes, jsonValueSchema } from "@humansandmachines/gsv/protocol";
import { FederationHttpError } from "./errors";
import type { KernelContext } from "../context";
import { isLoopbackHostname, isPublicHostname } from "../public-destination";

export const MAX_PUBLIC_JSON_BYTES = 128 * 1024;

export async function readFederationBody(body: BinaryBody, limit: number, signal?: AbortSignal, timeoutMs = 10_000): Promise<Uint8Array> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new Error("Federation body read timed out")), timeoutMs);
  try {
    return await bodyToBytes(body, limit, signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal);
  } finally { clearTimeout(timer); }
}

/** Refuses a destination a Ship may not reach: anything but a public HTTPS host, outside local development. */
export function assertFederationTarget(url: string, ctx: KernelContext): void {
  const localOrigin = ctx.installationIdentity?.canonicalOrigin;
  const allowLocal = ctx.env.GSV_FEDERATION_LOCAL_DEVELOPMENT === "1"
    && !!localOrigin && isLoopbackHostname(new URL(localOrigin).hostname);
  assertFederationDestination(url, allowLocal);
}

export async function fetchFederation(url: string, init: RequestInit, ctx: KernelContext, timeoutMs = 30_000): Promise<Response> {
  assertFederationTarget(url, ctx);
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new Error("Federation request timed out")), timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout.signal]) : timeout.signal;
  let response: Response;
  try { response = await fetch(url, { ...init, redirect: "manual", signal }); }
  catch (error) { clearTimeout(timer); throw error; }
  if (!response.body) { clearTimeout(timer); return response; }
  const reader = response.body.getReader();
  let finished = false;
  const finish = () => { if (finished) return; finished = true; clearTimeout(timer); reader.releaseLock(); };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const part = await reader.read();
        if (part.done) { finish(); controller.close(); }
        else controller.enqueue(part.value);
      } catch (error) { finish(); controller.error(error); }
    },
    async cancel(reason) { try { await reader.cancel(reason); } finally { finish(); } },
  }, { highWaterMark: 0 });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

export async function readFederationJson(response: Response, signal?: AbortSignal): Promise<JsonValue> {
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new FederationHttpError(response.status, `Remote Ship rejected the request (${response.status})`);
  }
  if (!response.body) throw new Error("Remote Ship returned an empty response");
  const lengthHeader = response.headers.get("content-length");
  const bytes = await bodyToBytes({
    stream: response.body, length: lengthHeader ? Number(lengthHeader) : undefined,
  }, MAX_PUBLIC_JSON_BYTES, signal);
  return jsonValueSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
}

export function assertFederationDestination(value: string, allowLocal = false): void {
  const url = new URL(value);
  if (url.username || url.password || url.hash) throw new Error("Federation URLs cannot contain credentials or fragments");
  const host = url.hostname.replace(/\.$/, "");
  if (allowLocal && isLoopbackHostname(host) && (url.protocol === "http:" || url.protocol === "https:")) return;
  if (url.protocol !== "https:") throw new Error("Federation destinations must use HTTPS");
  if (!isPublicHostname(host)) throw new Error("Federation destinations must be publicly reachable");
}
