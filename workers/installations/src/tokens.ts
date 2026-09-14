const TOKEN_RANDOM_BYTES = 32;
const MAX_TOKEN_LENGTH = 256;

export type OpaqueToken = {
  raw: string;
  prefix: string;
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

export function tokenPrefix(raw: string | number | boolean | Record<string, string | number | boolean | null | undefined> | null | undefined): string {
  if (String(raw) !== raw || raw.length < 20 || raw.length > MAX_TOKEN_LENGTH) {
    throw new Error("token is invalid");
  }
  return raw.slice(0, 16);
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function constantTimeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function base64UrlEncode(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}
