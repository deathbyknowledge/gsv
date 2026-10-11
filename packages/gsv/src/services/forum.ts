import { z } from "zod";
import type { JsonValue } from "../protocol/json";

export const FORUM_ORIGIN = "https://commons.gsv.space";
export const FORUM_TERMS_VERSION = "2026-10-11";
export const FORUM_MAX_BODY_BYTES = 96 * 1024;
export const FORUM_MAX_RESPONSE_BYTES = 512 * 1024;
export const FORUM_REQUEST_LIFETIME_MS = 5 * 60_000;

const id = z.string().min(1).max(100);
export const forumBoardIdSchema = z.string().regex(/^[a-z][a-z0-9-]{1,47}$/);
export const forumReadSchema = z.strictObject({
  action: z.enum(["boards", "threads", "thread", "search", "profile", "inbox"]),
  board: forumBoardIdSchema.optional(), thread: id.optional(), query: z.string().max(200).optional(),
  cursor: z.number().int().min(0).max(1_000_000).optional(),
});
export const forumWriteSchema = z.strictObject({
  id: z.uuid(), action: z.enum(["post", "reply", "edit", "delete", "watch", "report"]),
  board: forumBoardIdSchema, thread: id.optional(), post: id.optional(), revision: z.number().int().positive().optional(),
});
export const forumMembershipSchema = z.strictObject({
  action: z.enum(["status", "join", "update", "leave", "session"]),
  origin: z.string().url().max(2048).optional(),
});
export const forumPreferencesSchema = z.strictObject({
  displayName: z.string().trim().min(1).max(80),
  about: z.string().trim().max(600).default(""),
  allowAgents: z.boolean().default(false),
  agentUids: z.array(z.number().int().nonnegative()).max(32).default([]),
  postsPerDay: z.number().int().min(1).max(100).default(5),
  datasetConsent: z.boolean().default(false),
  termsVersion: z.literal(FORUM_TERMS_VERSION),
});
export const forumContentSchema = z.strictObject({
  title: z.string().trim().min(1).max(180).optional(),
  text: z.string().trim().min(1).max(24_000).optional(),
  tags: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,29}$/)).max(5).optional(),
  watching: z.boolean().optional(),
});

export type ForumReadArgs = z.infer<typeof forumReadSchema>;
export type ForumWriteArgs = z.infer<typeof forumWriteSchema>;
export type ForumMembershipArgs = z.infer<typeof forumMembershipSchema>;
export type ForumPreferences = z.infer<typeof forumPreferencesSchema>;
export type ForumContent = z.infer<typeof forumContentSchema>;
export type ForumResult = JsonValue;

export const forumPublicKeySchema = z.strictObject({
  kty: z.literal("EC"), crv: z.literal("P-256"), x: z.string().regex(/^[\w-]{43}$/), y: z.string().regex(/^[\w-]{43}$/),
});
export const forumRequestSchema = z.strictObject({
  domain: z.literal("gsv-forum/1"), audience: z.string().url().max(2048),
  membershipRevision: z.number().int().positive().optional(),
  id: z.uuid(), issuedAt: z.number().int().positive(), shipId: z.string().regex(/^ship:[\w-]{43}$/),
  origin: z.string().url().max(2048), publicKey: forumPublicKeySchema,
  actor: z.strictObject({ kind: z.enum(["person", "agent"]), name: z.string().min(1).max(80) }),
  operation: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("read"), args: forumReadSchema }),
    z.strictObject({ kind: z.literal("write"), args: forumWriteSchema, content: forumContentSchema }),
    z.strictObject({ kind: z.literal("membership"), args: forumMembershipSchema, preferences: forumPreferencesSchema.optional() }),
  ]),
});
export const forumEnvelopeSchema = z.strictObject({ request: forumRequestSchema, signature: z.string().regex(/^[\w-]{86}$/) });
export type ForumRequest = z.infer<typeof forumRequestSchema>;
export type ForumEnvelope = z.infer<typeof forumEnvelopeSchema>;

/** Canonical JSON also used by GSV's federation signatures. */
export function forumCanonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(forumCanonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${forumCanonicalJson(item)}`).join(",")}}`;
  }
  const result = JSON.stringify(value);
  if (result === undefined) throw new Error("Value is not JSON");
  return result;
}

export function forumBase64Url(value: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(value))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function forumDigest(value: string): Promise<string> {
  return forumBase64Url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

export async function verifyForumEnvelope(envelope: ForumEnvelope, audience: string, now = Date.now()): Promise<boolean> {
  const { request, signature } = envelope;
  if (request.audience !== audience || request.issuedAt > now + 30_000 || request.issuedAt < now - FORUM_REQUEST_LIFETIME_MS) return false;
  if (request.shipId !== `ship:${await forumDigest(forumCanonicalJson(request.publicKey))}`) return false;
  try {
    const key = await crypto.subtle.importKey("jwk", request.publicKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const bytes = Uint8Array.from(atob(signature.replace(/-/g, "+").replace(/_/g, "/") + "=="), (char) => char.charCodeAt(0));
    return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, bytes, new TextEncoder().encode(forumCanonicalJson(request)));
  } catch { return false; }
}

/** Membership proofs fetch only ordinary public DNS origins, never IP literals. */
export function forumPublicOrigin(value: string): string {
  const url = new URL(value);
  if (url.origin !== value || url.protocol !== "https:" || url.port || url.username || url.password
    || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/.test(url.hostname)
    || /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid|example)$/.test(url.hostname)
    || url.hostname.endsWith(".home.arpa")) throw new Error("Use a public HTTPS origin");
  return url.origin;
}
