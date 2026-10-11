import { z } from "zod";
import type { JsonValue } from "../protocol/json";
import { jsonObjectSchema, jsonPrimitiveSchema } from "../protocol/json";

export const FORUM_ORIGIN = "https://commons.gsv.space";
export const FORUM_TERMS_VERSION = "2026-10-11";
export const FORUM_MAX_BODY_BYTES = 96 * 1024;
export const FORUM_MAX_RESPONSE_BYTES = 512 * 1024;
export const FORUM_TIMEOUT_MS = 30_000;

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
  action: z.enum(["status", "join", "update", "leave"]),
});
export const forumPreferencesSchema = z.strictObject({
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

export const forumActorSchema = z.strictObject({
  kind: z.literal("agent"), uid: z.number().int().nonnegative(),
  processId: z.string().min(1).max(200), name: z.string().min(1).max(80),
});

/** Kernel-derived authority, accepted only over a deployment-owned service binding. */
export const forumServiceRequestSchema = z.strictObject({
  id: z.uuid(), installationId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  ownerUid: z.number().int().nonnegative(), deadlineAt: z.number().int().positive(),
  operation: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("read"), args: forumReadSchema }),
    z.strictObject({ kind: z.literal("write"), revision: z.number().int().positive(), actor: forumActorSchema, args: forumWriteSchema, content: forumContentSchema }),
    z.strictObject({ kind: z.literal("membership"), action: z.enum(["join", "leave"]), revision: z.number().int().positive(), preferences: forumPreferencesSchema.optional() }),
  ]),
});
export type ForumActor = z.infer<typeof forumActorSchema>;
export type ForumServiceRequest = z.infer<typeof forumServiceRequestSchema>;
export type ForumServiceResult = { ok: true; value: JsonValue } | { ok: false; status: number; message: string; reference?: string };
export interface ForumService {
  request(input: ForumServiceRequest): Promise<ForumServiceResult>;
}

/** Canonical JSON also used by GSV's federation signatures. */
export function forumCanonicalJson(value: JsonValue): string {
  const primitive = jsonPrimitiveSchema.safeParse(value);
  if (primitive.success) return JSON.stringify(primitive.data);
  if (Array.isArray(value)) return `[${value.map(forumCanonicalJson).join(",")}]`;
  const object = jsonObjectSchema.parse(value);
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${forumCanonicalJson(object[key])}`).join(",")}}`;
}

export function forumBase64Url(value: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(value))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function forumDigest(value: string): Promise<string> {
  return forumBase64Url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}
