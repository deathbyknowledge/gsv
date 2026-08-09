const MAX_JSON_BODY_BYTES = 32 * 1024;

export async function readJsonObject(
  request: Request,
): Promise<Record<string, unknown>> {
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

export function hasExpectedOrigin(request: Request, expectedOrigin: string): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return origin === new URL(origin).origin && origin === expectedOrigin;
  } catch {
    return false;
  }
}

export function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: noStoreHeaders() });
}

export function noStoreHeaders(extra: HeadersInit = {}): Headers {
  const headers = new Headers(extra);
  headers.set("cache-control", "no-store");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-content-type-options", "nosniff");
  return headers;
}
