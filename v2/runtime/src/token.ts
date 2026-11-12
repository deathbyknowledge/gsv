import { z } from "zod";

const SESSION_MS = 12 * 60 * 60 * 1000;
const encoder = new TextEncoder();

export const sessionSchema = z.object({
  v: z.literal(1),
  uid: z.string(),
  space: z.string(),
  host: z.string(),
  epoch: z.number().int().nonnegative(),
  exp: z.number().int(),
});
export type Session = z.infer<typeof sessionSchema>;

// Space keys derive from the one deployment secret; an edited space id derives the wrong key.
const keys = new Map<string, Promise<CryptoKey>>();
function spaceKey(secret: string, space: string): Promise<CryptoKey> {
  const cacheKey = `${secret.length}:${space}`;
  let key = keys.get(cacheKey);
  if (!key) {
    key = crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, ["deriveKey"]).then(base => crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: encoder.encode("gsv/space-key/v1"), info: encoder.encode(space) },
      base,
      { name: "HMAC", hash: "SHA-256", length: 256 },
      false,
      ["sign", "verify"],
    ));
    keys.set(cacheKey, key);
  }
  return key;
}

export function base64url(bytes: ArrayBuffer | Uint8Array): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

/** A session token: the claims in the clear, signed with the space's key. Valid on one hostname for 12 hours. */
export async function issueSession(secret: string, claims: Omit<Session, "v" | "exp">, now = Date.now()): Promise<{ token: string; expiresAt: number }> {
  const session: Session = { v: 1, ...claims, exp: now + SESSION_MS };
  const body = base64url(encoder.encode(JSON.stringify(session)));
  const signature = await crypto.subtle.sign("HMAC", await spaceKey(secret, session.space), encoder.encode(body));
  return { token: `${body}.${base64url(signature)}`, expiresAt: session.exp };
}

/** Checks the signature, expiry and hostname without any lookup; revocation is the owner DO's check. */
export async function verifySession(secret: string, token: string, host: string, now = Date.now()): Promise<Session | null> {
  const [body, signature, extra] = token.split(".");
  if (!body || !signature || extra !== undefined) return null;
  let session: Session;
  try {
    const parsed = sessionSchema.safeParse(JSON.parse(new TextDecoder().decode(fromBase64url(body))));
    if (!parsed.success) return null;
    session = parsed.data;
    if (!await crypto.subtle.verify("HMAC", await spaceKey(secret, session.space), fromBase64url(signature), encoder.encode(body))) return null;
  } catch {
    return null;
  }
  return session.exp > now && session.host === host ? session : null;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
