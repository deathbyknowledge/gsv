import type { ConfigStore } from "./config";

const LOGIN_SOURCE_SECRET_KEY = "internal/auth/login_source_secret";
const LOGIN_SOURCE_SECRET_BYTES = 32;
const MAX_SOURCE_ADDRESS_LENGTH = 64;
const LOGIN_SOURCE_EPOCH_MS = 24 * 60 * 60 * 1000;
const TEXT_ENCODER = new TextEncoder();

export const UNAVAILABLE_LOGIN_SOURCE_SCOPE = "source:unavailable";

export type LoginSourceScope = `source:${string}`;

/**
 * Convert an edge-provided client address into a durable per-ship pseudonym.
 * HMAC input includes the UTC-day epoch so stored scopes rotate daily while
 * the random ship key remains stable. Raw addresses exist only for this call
 * and are never written to storage.
 */
export async function deriveLoginSourceScope(
  config: ConfigStore,
  sourceAddress: string | null | undefined,
  now = Date.now(),
): Promise<LoginSourceScope> {
  const normalized = normalizeSourceAddress(sourceAddress);
  if (normalized === null) {
    return UNAVAILABLE_LOGIN_SOURCE_SCOPE;
  }

  const secret = getOrCreateLoginSourceSecret(config);
  const epoch = String(Math.floor(now / LOGIN_SOURCE_EPOCH_MS));
  const encodedEpoch = TEXT_ENCODER.encode(epoch);
  const address = TEXT_ENCODER.encode(normalized);
  const input = new Uint8Array(encodedEpoch.length + 1 + address.length);
  input.set(encodedEpoch, 0);
  input[encodedEpoch.length] = 0;
  input.set(address, encodedEpoch.length + 1);

  const key = await crypto.subtle.importKey(
    "raw",
    secret,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, input);
  return `source:${epoch}:${bytesToHex(new Uint8Array(signature))}`;
}

export function normalizeLoginSourceScope(scope: unknown): LoginSourceScope {
  if (scope === UNAVAILABLE_LOGIN_SOURCE_SCOPE) {
    return UNAVAILABLE_LOGIN_SOURCE_SCOPE;
  }
  return typeof scope === "string" && /^source:\d{1,8}:[a-f0-9]{64}$/.test(scope)
    ? scope as LoginSourceScope
    : UNAVAILABLE_LOGIN_SOURCE_SCOPE;
}

function normalizeSourceAddress(sourceAddress: string | null | undefined): string | null {
  if (
    typeof sourceAddress !== "string"
    || sourceAddress.length === 0
    || sourceAddress.length > MAX_SOURCE_ADDRESS_LENGTH
    || sourceAddress.trim() !== sourceAddress
  ) {
    return null;
  }

  const ipv4 = normalizeIpv4(sourceAddress);
  if (ipv4 !== null) {
    return ipv4;
  }

  if (
    sourceAddress.length > 45
    || !sourceAddress.includes(":")
    || !/^[0-9a-f:.]+$/i.test(sourceAddress)
  ) {
    return null;
  }

  try {
    const hostname = new URL(`http://[${sourceAddress}]/`).hostname;
    if (!hostname.startsWith("[") || !hostname.endsWith("]")) {
      return null;
    }
    const normalized = hostname.slice(1, -1).toLowerCase();
    return normalized.includes(":") ? normalized : null;
  } catch {
    return null;
  }
}

function normalizeIpv4(value: string): string | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;

  const normalized: string[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    normalized.push(String(octet));
  }
  return normalized.join(".");
}

function getOrCreateLoginSourceSecret(config: ConfigStore): Uint8Array {
  const existing = config.getExplicit(LOGIN_SOURCE_SECRET_KEY);
  if (existing !== null) {
    if (!/^[a-f0-9]{64}$/.test(existing)) {
      throw new Error("Login source secret is invalid");
    }
    return hexToBytes(existing);
  }

  const secret = crypto.getRandomValues(new Uint8Array(LOGIN_SOURCE_SECRET_BYTES));
  config.set(LOGIN_SOURCE_SECRET_KEY, bytesToHex(secret));
  return secret;
}

function hexToBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < value.length; index += 2) {
    bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  }
  return bytes;
}

function bytesToHex(value: Uint8Array): string {
  return Array.from(value)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
