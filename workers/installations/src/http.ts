const MAX_JSON_BODY_BYTES = 32 * 1024;

export async function readJsonObject(request: Request): Promise<JsonObject> {
  const type = request.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (type !== "application/json") throw new Error("JSON body is required");
  const bytes = await readRequestBody(request, MAX_JSON_BODY_BYTES);
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new Error("request JSON is invalid"); }
  if (!value || value.constructor !== Object || Array.isArray(value)) {
    throw new Error("JSON object is required");
  }
// SAFETY: This assertion follows boundary validation or a test fixture with the declared owner contract.
  return value as JsonObject;
}

export async function readRequestBody(request: Request, maxBytes: number): Promise<Uint8Array> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await request.body?.cancel();
    throw new Error("request body is too large");
  }
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          await reader.cancel();
          throw new Error("request body is too large");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export interface JsonObject { [key: string]: JsonValue; }
export type JsonValue = string | number | boolean | null | JsonObject | JsonValue[] | undefined;

export function requireString(value: JsonValue, field: string): string {
  if (String(value) !== value || !value) throw new Error(`${field} is required`);
  return value;
}

export function hasExpectedOrigin(request: Request, expectedOrigin: string): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try { return origin === new URL(origin).origin && origin === expectedOrigin; }
  catch { return false; }
}

export function json(value: JsonValue, status = 200): Response {
  return Response.json(value, { status, headers: noStoreHeaders() });
}

export function noStoreHeaders(extra: HeadersInit = {}): Headers {
  const headers = new Headers(extra);
  headers.set("cache-control", "no-store");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-content-type-options", "nosniff");
  return headers;
}

/** Native form posts need their browser Origin; referrers must stay on this origin. */
export function noStoreFormHeaders(extra: HeadersInit = {}): Headers {
  const headers = noStoreHeaders(extra);
  headers.set("referrer-policy", "same-origin");
  return headers;
}
