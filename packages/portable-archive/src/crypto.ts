import { concatBytes } from "./bytes";
import { fail } from "./error";

export type PortableCrypto = Readonly<{
  subtle: SubtleCrypto;
  getRandomValues(array: Uint8Array): Uint8Array;
}>;

export function resolveCrypto(provider?: PortableCrypto): PortableCrypto {
  const candidate = provider ?? (typeof crypto === "undefined" ? undefined : crypto);
  if (!candidate?.subtle || typeof candidate.getRandomValues !== "function") {
    fail("unsupported_feature", "Web Crypto is required for portable archives");
  }
  return candidate;
}

export async function sha256(
  bytes: Uint8Array,
  provider?: PortableCrypto,
): Promise<Uint8Array> {
  const crypto = resolveCrypto(provider);
  const digest = await crypto.subtle.digest("SHA-256", copyBuffer(bytes));
  return new Uint8Array(digest);
}

export async function sha256Parts(
  parts: readonly Uint8Array[],
  provider?: PortableCrypto,
): Promise<Uint8Array> {
  return sha256(concatBytes(parts), provider);
}

export function randomBytes(length: number, provider?: PortableCrypto): Uint8Array {
  if (!Number.isSafeInteger(length) || length < 0 || length > 65_536) {
    fail("invalid_argument", "random byte request is outside Web Crypto limits");
  }
  return resolveCrypto(provider).getRandomValues(new Uint8Array(length));
}

export function copyBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
