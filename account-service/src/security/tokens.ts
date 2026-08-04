const TOKEN_RANDOM_BYTES = 32;
const MAX_TOKEN_LENGTH = 256;
const RECOVERY_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

export type OpaqueToken = {
  raw: string;
  prefix: string;
  hash: string;
};

export type RecoveryCode = {
  raw: string;
  lookupKey: string;
  hash: string;
};

export async function createOpaqueToken(label: string): Promise<OpaqueToken> {
  if (!/^[a-z]{3,12}$/.test(label)) {
    throw new Error("opaque token label is invalid");
  }
  const random = crypto.getRandomValues(new Uint8Array(TOKEN_RANDOM_BYTES));
  const raw = `${label}_${base64UrlEncode(random)}`;
  return {
    raw,
    prefix: raw.slice(0, 16),
    hash: await sha256Hex(raw),
  };
}

export function tokenPrefix(raw: unknown): string {
  if (typeof raw !== "string" || raw.length < 20 || raw.length > MAX_TOKEN_LENGTH) {
    throw new Error("token is invalid");
  }
  return raw.slice(0, 16);
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function constantTimeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

export function base64UrlEncode(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function base64UrlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("base64url value is invalid");
  }
  const padded = value.replace(/-/g, "+").replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export async function createRecoveryCode(): Promise<RecoveryCode> {
  const normalized = base32Encode(crypto.getRandomValues(new Uint8Array(15)));
  const raw = normalized.match(/.{1,4}/g)?.join("-") ?? normalized;
  const hash = await sha256Hex(normalized);
  return {
    raw,
    lookupKey: hash.slice(0, 24),
    hash,
  };
}

export function normalizeRecoveryCode(value: unknown): string {
  if (typeof value !== "string") throw new Error("recovery code is invalid");
  const normalized = value.trim().toUpperCase().replace(/-/g, "");
  if (normalized.length !== 24) throw new Error("recovery code is invalid");
  for (const character of normalized) {
    if (!RECOVERY_ALPHABET.includes(character)) {
      throw new Error("recovery code is invalid");
    }
  }
  return normalized;
}

function base32Encode(bytes: Uint8Array): string {
  let output = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += RECOVERY_ALPHABET[(buffer >>> bits) & 31];
      buffer &= (1 << bits) - 1;
    }
  }
  if (bits > 0) output += RECOVERY_ALPHABET[(buffer << (5 - bits)) & 31];
  return output;
}
