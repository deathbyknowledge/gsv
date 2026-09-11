/**
 * A UUID for request ids and idempotency keys. `crypto.randomUUID` exists only
 * in secure contexts, and a dev server reached over a LAN address is not one,
 * so the fallback builds a version 4 UUID from `getRandomValues`, which every
 * context has.
 */
export function randomId(): string {
  const webCrypto = globalThis.crypto;
  const randomUuid = webCrypto?.randomUUID;
  if (randomUuid) return randomUuid.call(webCrypto);
  const bytes = new Uint8Array(16);
  if (webCrypto?.getRandomValues) {
    webCrypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
