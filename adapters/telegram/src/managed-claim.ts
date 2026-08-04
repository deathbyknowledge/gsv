const CLAIM_VERSION = "gsvtg1";
const DURABLE_OBJECT_ID_PATTERN = /^[0-9a-f]{64}$/;
const CLAIM_ID_PATTERN = /^[A-Za-z0-9_-]{16,80}$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_TOKEN_BYTES = 512;
const MIN_SIGNING_KEY_BYTES = 32;

export type ParsedManagedTelegramClaimToken = {
  durableObjectId: string;
  claimId: string;
  expiresAt: number;
};

export async function createManagedTelegramClaimToken(
  claim: ParsedManagedTelegramClaimToken,
  signingKey: string,
): Promise<string> {
  const unsigned = serializeUnsignedClaim(claim);
  const signature = await sign(unsigned, signingKey);
  return `${unsigned}.${signature}`;
}

export function parseManagedTelegramClaimToken(
  token: string,
): ParsedManagedTelegramClaimToken | null {
  if (!token || token.length > MAX_TOKEN_BYTES || token !== token.trim()) {
    return null;
  }
  const [version, durableObjectId, claimId, expiresAtText, signature, ...rest] =
    token.split(".");
  if (
    rest.length > 0
    || version !== CLAIM_VERSION
    || !DURABLE_OBJECT_ID_PATTERN.test(durableObjectId ?? "")
    || !CLAIM_ID_PATTERN.test(claimId ?? "")
    || !/^[1-9][0-9]{0,15}$/.test(expiresAtText ?? "")
    || !SIGNATURE_PATTERN.test(signature ?? "")
  ) {
    return null;
  }
  const expiresAt = Number(expiresAtText);
  if (!Number.isSafeInteger(expiresAt)) {
    return null;
  }
  return { durableObjectId, claimId, expiresAt };
}

export async function verifyManagedTelegramClaimToken(
  token: string,
  signingKey: string,
): Promise<ParsedManagedTelegramClaimToken | null> {
  const parsed = parseManagedTelegramClaimToken(token);
  if (!parsed) return null;

  const actual = token.slice(token.lastIndexOf(".") + 1);
  const expected = await sign(serializeUnsignedClaim(parsed), signingKey);
  return constantTimeEqual(actual, expected) ? parsed : null;
}

export function managedTelegramClaimUrl(
  accountOrigin: string,
  token: string,
): string {
  const origin = parseAccountOrigin(accountOrigin);
  return `${origin}/telegram#claim=${encodeURIComponent(token)}`;
}

export function parseAccountOrigin(value: string): string {
  const normalized = value.trim();
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error("Managed Telegram account origin is invalid");
  }
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash
    || url.origin !== normalized.replace(/\/$/, "")
  ) {
    throw new Error("Managed Telegram account origin must be an HTTPS origin");
  }
  return url.origin;
}

function serializeUnsignedClaim(claim: ParsedManagedTelegramClaimToken): string {
  if (!DURABLE_OBJECT_ID_PATTERN.test(claim.durableObjectId)) {
    throw new Error("Managed Telegram peer ID is invalid");
  }
  if (!CLAIM_ID_PATTERN.test(claim.claimId)) {
    throw new Error("Managed Telegram claim ID is invalid");
  }
  if (!Number.isSafeInteger(claim.expiresAt) || claim.expiresAt <= 0) {
    throw new Error("Managed Telegram claim expiry is invalid");
  }
  return `${CLAIM_VERSION}.${claim.durableObjectId}.${claim.claimId}.${claim.expiresAt}`;
}

async function sign(unsigned: string, signingKey: string): Promise<string> {
  const keyBytes = new TextEncoder().encode(signingKey);
  if (keyBytes.byteLength < MIN_SIGNING_KEY_BYTES) {
    throw new Error("Managed Telegram claim signing key is not configured securely");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(unsigned),
  ));
  return base64Url(signature);
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function constantTimeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}
