import type { JsonValue } from "@humansandmachines/gsv/protocol";
import { bodyToBytes, jsonValueSchema } from "@humansandmachines/gsv/protocol";
import { FederationHttpError } from "./errors";

export const MAX_PUBLIC_JSON_BYTES = 128 * 1024;

export async function fetchFederationJson(url: string, init: RequestInit): Promise<JsonValue> {
  const timeoutSignal = AbortSignal.timeout(30_000);
  const signal = init.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
  const response = await fetch(url, { ...init, redirect: "manual", signal });
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
