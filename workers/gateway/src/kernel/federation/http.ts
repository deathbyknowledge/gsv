import type { BinaryBody, JsonValue } from "@humansandmachines/gsv/protocol";
import { bodyToBytes, jsonValueSchema } from "@humansandmachines/gsv/protocol";
import { FederationHttpError } from "./errors";
import type { KernelContext } from "../context";

export const MAX_PUBLIC_JSON_BYTES = 128 * 1024;

export async function readFederationBody(body: BinaryBody, limit: number, signal?: AbortSignal, timeoutMs = 10_000): Promise<Uint8Array> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new Error("Federation body read timed out")), timeoutMs);
  try {
    return await bodyToBytes(body, limit, signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal);
  } finally { clearTimeout(timer); }
}

export async function fetchFederation(url: string, init: RequestInit, ctx: KernelContext, timeoutMs = 30_000): Promise<Response> {
  const localOrigin = ctx.installationIdentity?.canonicalOrigin;
  const allowLocal = ctx.env.GSV_FEDERATION_LOCAL_DEVELOPMENT === "1"
    && !!localOrigin && isLoopbackHost(new URL(localOrigin).hostname);
  assertFederationDestination(url, allowLocal);
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

export async function fetchFederationJson(url: string, init: RequestInit, ctx: KernelContext): Promise<JsonValue> {
  const response = await fetchFederation(url, init, ctx);
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new FederationHttpError(response.status, `Remote Ship rejected the request (${response.status})`);
  }
  if (!response.body) throw new Error("Remote Ship returned an empty response");
  const lengthHeader = response.headers.get("content-length");
  const bytes = await bodyToBytes({
    stream: response.body, length: lengthHeader ? Number(lengthHeader) : undefined,
  }, MAX_PUBLIC_JSON_BYTES, init.signal ?? undefined);
  return jsonValueSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
}

export function assertFederationDestination(value: string, allowLocal = false): void {
  const url = new URL(value);
  if (url.username || url.password || url.hash) throw new Error("Federation URLs cannot contain credentials or fragments");
  const host = url.hostname.replace(/\.$/, "");
  if (allowLocal && isLoopbackHost(host) && (url.protocol === "http:" || url.protocol === "https:")) return;
  if (url.protocol !== "https:") throw new Error("Federation destinations must use HTTPS");
  if (isLoopbackHost(host) || /(?:^|\.)(?:local|internal|lan|home|home\.arpa)$/.test(host) || (!host.includes(".") && !host.startsWith("["))) {
    throw new Error("Federation destinations must be publicly reachable");
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a, b, c] = host.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99)))
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113)) {
      throw new Error("Federation destinations must be publicly reachable");
    }
  }
  if (host.startsWith("[")) {
    const [first, second] = host.slice(1, -1).split(":").map((part) => Number.parseInt(part || "0", 16));
    if ((first & 0xe000) !== 0x2000 || first === 0x2002 || (first === 0x2001 && (second < 0x200 || second === 0xdb8)) || (first === 0x3fff && second <= 0xfff)) {
      throw new Error("Federation destinations must be publicly reachable");
    }
  }
}

function isLoopbackHost(value: string): boolean {
  const host = value.replace(/\.$/, "");
  return host === "localhost" || host.endsWith(".localhost") || host === "[::1]" || /^127(?:\.\d+){3}$/.test(host);
}
