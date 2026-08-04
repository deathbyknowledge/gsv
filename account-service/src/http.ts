import { readAccountSessionCookie } from "./auth/session-cookie";
import { sha256Hex } from "./security/tokens";

const MAX_JSON_BODY_BYTES = 32 * 1024;

export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  const type = request.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (type !== "application/json") throw new Error("JSON body is required");
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BODY_BYTES) {
    throw new Error("request body is too large");
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_JSON_BODY_BYTES) {
    throw new Error("request body is too large");
  }
  const value = JSON.parse(text) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("JSON object is required");
  }
  return value as Record<string, unknown>;
}

export function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${field} is required`);
  return value;
}

export function requireSessionToken(request: Request): string {
  const token = readAccountSessionCookie(request.headers.get("cookie"));
  if (!token) throw new Error("authentication required");
  return token;
}

export function hasExpectedOrigin(request: Request, expectedOrigin: string): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    const parsed = new URL(origin);
    return origin === parsed.origin && parsed.origin === expectedOrigin;
  } catch {
    return false;
  }
}

export async function requestClient(request: Request): Promise<{
  ipAddress?: string;
  ipHash?: string;
}> {
  const ipAddress = request.headers.get("cf-connecting-ip")?.trim();
  return ipAddress ? {
    ipAddress,
    ipHash: await sha256Hex(`gsv-account-ip:${ipAddress}`),
  } : {};
}

export function json(
  value: unknown,
  status = 200,
  extraHeaders: HeadersInit = {},
): Response {
  return Response.json(value, {
    status,
    headers: noStoreHeaders(extraHeaders),
  });
}

export function noStoreHeaders(extra: HeadersInit = {}): Headers {
  const headers = new Headers(extra);
  headers.set("cache-control", "no-store");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-content-type-options", "nosniff");
  return headers;
}
