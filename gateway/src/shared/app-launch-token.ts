export const APP_LAUNCH_TOKEN_MAX_BYTES = 128;

const APP_LAUNCH_TOKEN_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export type AppLaunchTokenReadResult =
  | { ok: true; token: string }
  | { ok: false; tooLarge: boolean };

export async function cancelAppLaunchRequestBody(
  request: Request,
  reason: string,
): Promise<void> {
  if (!request.body || request.bodyUsed) return;
  try {
    await request.body.cancel(reason);
  } catch {
  }
}

export async function readAppLaunchToken(
  request: Request,
): Promise<AppLaunchTokenReadResult> {
  const contentType = request.headers.get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    await cancelAppLaunchRequestBody(request, "Invalid app launch content type");
    return { ok: false, tooLarge: false };
  }

  const declaredLength = request.headers.get("content-length");
  let expectedLength: number | null = null;
  if (declaredLength !== null) {
    if (!/^\d+$/.test(declaredLength)) {
      await cancelAppLaunchRequestBody(request, "Invalid app launch content length");
      return { ok: false, tooLarge: false };
    }
    expectedLength = Number(declaredLength);
    if (
      !Number.isSafeInteger(expectedLength)
      || expectedLength > APP_LAUNCH_TOKEN_MAX_BYTES
    ) {
      await cancelAppLaunchRequestBody(request, "App launch body is too large");
      return { ok: false, tooLarge: true };
    }
  }

  if (!request.body) {
    return { ok: false, tooLarge: false };
  }

  const bytes = new Uint8Array(APP_LAUNCH_TOKEN_MAX_BYTES);
  const reader = request.body.getReader();
  let byteLength = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (byteLength + chunk.value.byteLength > APP_LAUNCH_TOKEN_MAX_BYTES) {
        await cancelReader(reader, "App launch body is too large");
        return { ok: false, tooLarge: true };
      }
      bytes.set(chunk.value, byteLength);
      byteLength += chunk.value.byteLength;
    }
  } catch {
    await cancelReader(reader, "Invalid app launch body");
    return { ok: false, tooLarge: false };
  } finally {
    reader.releaseLock();
  }

  if (expectedLength !== null && expectedLength !== byteLength) {
    return { ok: false, tooLarge: false };
  }

  let parsed: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes.subarray(0, byteLength),
    );
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, tooLarge: false };
  }
  if (
    !parsed
    || typeof parsed !== "object"
    || Array.isArray(parsed)
    || Object.keys(parsed).length !== 1
    || !("token" in parsed)
    || typeof (parsed as { token?: unknown }).token !== "string"
  ) {
    return { ok: false, tooLarge: false };
  }
  const token = (parsed as { token: string }).token;
  return APP_LAUNCH_TOKEN_RE.test(token)
    ? { ok: true, token }
    : { ok: false, tooLarge: false };
}

async function cancelReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  reason: string,
): Promise<void> {
  try {
    await reader.cancel(reason);
  } catch {
  }
}
