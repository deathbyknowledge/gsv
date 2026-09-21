import type { JsonValue } from "@humansandmachines/gsv/protocol";
import { bodyToBytes, jsonValueSchema } from "@humansandmachines/gsv/protocol";
import { FederationHttpError } from "./errors";
import type { KernelContext } from "../context";

export const MAX_PUBLIC_JSON_BYTES = 128 * 1024;

export async function fetchFederation(url: string, init: RequestInit, ctx: KernelContext, timeoutMs = 30_000): Promise<Response> {
  const localOrigin = ctx.installationIdentity?.canonicalOrigin;
  const allowLocal = ctx.env.GSV_FEDERATION_LOCAL_DEVELOPMENT === "1"
    && !!localOrigin && isLoopbackHost(new URL(localOrigin).hostname);
  assertFederationDestination(url, allowLocal);
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
  return fetch(url, { ...init, redirect: "manual", signal });
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
