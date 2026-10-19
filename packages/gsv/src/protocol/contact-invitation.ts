import { z } from "zod/mini";
import { federationSubjectSchema } from "./syscalls/contact";

const PREFIX = "gsv-contact-v1:";
const invitationSchema = z.strictObject({
  version: z.literal(1),
  origin: z.string().check(z.minLength(1), z.maxLength(2_048)),
  shipId: z.string().check(z.minLength(1), z.maxLength(128)),
  subject: federationSubjectSchema,
  token: z.string().check(z.minLength(1), z.maxLength(128)),
  expiresAtMs: z.int().check(z.minimum(0)),
});
export type ContactInvitation = z.infer<typeof invitationSchema>;
export type ParsedContactInvitation = { code: string; invitation: ContactInvitation };

export function encodeContactInvitation(value: ContactInvitation): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return PREFIX + btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A link and its original code identify the same invitation. Parsing does not verify the peer. */
export function parseContactInvitation(input: string): ParsedContactInvitation {
  try {
    const value = input.trim();
    if (value.length > 12_000) throw new Error();
    let code = value;
    if (!code.startsWith(PREFIX)) {
      const url = new URL(value);
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error();
      code = new URLSearchParams(url.hash.slice(1)).get("contact") ?? "";
    }
    if (!code.startsWith(PREFIX)) throw new Error();
    const encoded = code.slice(PREFIX.length);
    if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error();
    const bytes = Uint8Array.from(atob(encoded.replace(/-/g, "+").replace(/_/g, "/")), (char) => char.charCodeAt(0));
    const invitation = invitationSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    return { code, invitation };
  } catch {
    throw new Error("This invitation is not valid. Paste the complete link or code.");
  }
}

/** Keep the invitation out of HTTP requests, access logs and referrer headers. */
export function contactInvitationUrl(code: string, destination: string): string {
  const url = new URL(destination);
  url.hash = new URLSearchParams({ contact: code }).toString();
  return url.href;
}

export function contactInvitationDestination(origin: string, code: string): string {
  const url = new URL(origin);
  const local = url.protocol === "http:" && (url.hostname === "localhost" || url.hostname.endsWith(".localhost")
    || ["127.0.0.1", "[::1]"].includes(url.hostname));
  if (url.origin !== origin || (url.protocol !== "https:" && !local)) throw new Error("Enter your GSV space address.");
  return contactInvitationUrl(code, `${origin}/people`);
}
