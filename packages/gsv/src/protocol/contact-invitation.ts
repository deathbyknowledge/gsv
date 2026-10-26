import { z } from "zod/mini";
import { jsonValueSchema, type JsonValue } from "./json";
import { didSchema } from "./social";

const PREFIX = "gsv-contact-v2:";
const OLD_PREFIX = "gsv-contact-v1:";
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const invitationSchema = z.strictObject({
  version: z.literal(2),
  /** The inviting Ship; the invitation is accepted by calling it. */
  did: didSchema,
  /** Shown before accepting; the accepting Ship checks it against the DID. */
  handle: z.string().check(z.minLength(1), z.maxLength(253)),
  /** The inviter's name, shown before accepting. */
  name: z.string().check(z.minLength(1), z.maxLength(256)),
  token: z.string().check(z.minLength(1), z.maxLength(128)),
  expiresAtMs: z.int().check(z.minimum(0)),
});
export type ContactInvitation = z.infer<typeof invitationSchema>;
const oldInvitationSchema = z.object({ version: z.literal(1) });
export type ParsedContactInvitation = { code: string; invitation: ContactInvitation };
/** A code with its payload decoded but not yet read as an invitation. */
type DecodedInvitation = { code: string; value: JsonValue };

/** Codes issued before Ships had DIDs name an origin and a shipId that no Ship answers to any more. */
export class OutdatedContactInvitationError extends Error {
  constructor() {
    super("This invitation is from before an update. Ask for a new one.");
    this.name = "OutdatedContactInvitationError";
  }
}

export function encodeContactInvitation(value: ContactInvitation): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return PREFIX + btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A link and its original code identify the same invitation. Parsing does not verify the peer. */
export function parseContactInvitation(input: string): ParsedContactInvitation {
  let decoded: DecodedInvitation;
  try {
    decoded = decodeInvitation(input);
  } catch {
    throw new Error("This invitation is not valid. Paste the complete link or code.");
  }
  const parsed = invitationSchema.safeParse(decoded.value);
  if (parsed.success) return { code: decoded.code, invitation: parsed.data };
  if (decoded.code.startsWith(OLD_PREFIX) || isOldInvitation(decoded.value)) throw new OutdatedContactInvitationError();
  throw new Error("This invitation is not valid. Paste the complete link or code.");
}

/** Keep the invitation out of HTTP requests, access logs and referrer headers. */
export function contactInvitationUrl(code: string, destination: string): string {
  const url = new URL(destination);
  // The fragment identifies the invitation; share only its URL-safe payload.
  const payload = code.startsWith(PREFIX) ? code.slice(PREFIX.length) : code;
  url.hash = new URLSearchParams({ contact: payload }).toString();
  return url.href;
}

export function contactInvitationDestination(origin: string, code: string): string {
  const url = new URL(origin);
  const local = url.protocol === "http:" && (url.hostname === "localhost" || url.hostname.endsWith(".localhost")
    || ["127.0.0.1", "[::1]"].includes(url.hostname));
  if (url.origin !== origin || (url.protocol !== "https:" && !local)) throw new Error("Enter your GSV space address.");
  // Browser navigation bypasses messenger link detection; retain older recipient compatibility.
  url.pathname = "/people";
  url.hash = new URLSearchParams({ contact: parseContactInvitation(code).code }).toString();
  return url.href;
}

function decodeInvitation(input: string): DecodedInvitation {
  const value = input.trim();
  if (value.length > 12_000) throw new Error();
  let code = value;
  if (!code.startsWith(PREFIX) && !code.startsWith(OLD_PREFIX) && !BASE64URL.test(code)) {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error();
    code = new URLSearchParams(url.hash.slice(1)).get("contact") ?? "";
  }
  const prefix = code.startsWith(OLD_PREFIX) ? OLD_PREFIX : PREFIX;
  const encoded = code.startsWith(prefix) ? code.slice(prefix.length) : code;
  if (!BASE64URL.test(encoded)) throw new Error();
  const bytes = Uint8Array.from(atob(encoded.replace(/-/g, "+").replace(/_/g, "/")), (char) => char.charCodeAt(0));
  return { code: prefix + encoded, value: jsonValueSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))) };
}

function isOldInvitation(value: JsonValue): boolean {
  return oldInvitationSchema.safeParse(value).success;
}
