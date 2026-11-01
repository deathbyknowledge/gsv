import type { EventInput, EventSourceWebhook } from "@humansandmachines/gsv/protocol";
import * as z from "zod/mini";

export const MAX_WEBHOOK_BYTES = 256 * 1024;
const TIMESTAMP_SKEW_SECONDS = 5 * 60;

const encoder = new TextEncoder();

async function hmacSha256(key: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, message));
}

function joined(prefix: string, body: Uint8Array): Uint8Array {
  const head = encoder.encode(prefix);
  const message = new Uint8Array(head.length + body.length);
  message.set(head);
  message.set(body, head.length);
  return message;
}

function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return difference === 0;
}

const toHex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromBase64 = (value: string) => Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
const same = (left: string, right: string) => timingSafeEqual(encoder.encode(left), encoder.encode(right));

function freshTimestamp(value: string | null, nowMs: number): boolean {
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && Math.abs(nowMs / 1000 - seconds) <= TIMESTAMP_SKEW_SECONDS;
}

async function verifyStandard(secret: string, body: Uint8Array, headers: Headers, nowMs: number): Promise<boolean> {
  const id = headers.get("webhook-id");
  const timestamp = headers.get("webhook-timestamp");
  const signatures = headers.get("webhook-signature");
  if (!id || !signatures || !freshTimestamp(timestamp, nowMs)) return false;
  const key = fromBase64(secret.replace(/^whsec_/, ""));
  const expected = `v1,${toBase64(await hmacSha256(key, joined(`${id}.${timestamp}.`, body)))}`;
  return signatures.split(" ").some((signature) => same(signature, expected));
}

async function verifyGitHub(secret: string, body: Uint8Array, headers: Headers): Promise<boolean> {
  const signature = headers.get("x-hub-signature-256");
  if (!signature) return false;
  return same(signature, `sha256=${toHex(await hmacSha256(encoder.encode(secret), body))}`);
}

async function verifyStripe(secret: string, body: Uint8Array, headers: Headers, nowMs: number): Promise<boolean> {
  const parts = (headers.get("stripe-signature") ?? "").split(",").map((part) => part.split("=", 2));
  const timestamp = parts.find(([name]) => name === "t")?.[1] ?? null;
  if (!freshTimestamp(timestamp, nowMs)) return false;
  const expected = toHex(await hmacSha256(encoder.encode(secret), joined(`${timestamp}.`, body)));
  return parts.some(([name, value]) => name === "v1" && value !== undefined && same(value, expected));
}

/** Whether `body` was sent by whoever holds `secret`. A url source already proved it with its address. */
export async function verifyWebhook(
  webhook: Exclude<EventSourceWebhook, "none" | "url">,
  secret: string,
  body: Uint8Array,
  headers: Headers,
  nowMs: number,
): Promise<boolean> {
  try {
    if (webhook === "standard") return await verifyStandard(secret, body, headers, nowMs);
    if (webhook === "github") return await verifyGitHub(secret, body, headers);
    return await verifyStripe(secret, body, headers, nowMs);
  } catch (error) {
    // A malformed signature from a stranger is a failed check, not a Kernel fault.
    if (error instanceof DOMException) return false;
    throw error;
  }
}

const bodyFields = z.looseObject({
  id: z.optional(z.string()), action: z.optional(z.string()), type: z.optional(z.string()), title: z.optional(z.string()), subject: z.optional(z.string()),
  event: z.optional(z.string()), preview: z.optional(z.string()), summary: z.optional(z.string()), message: z.optional(z.string()), text: z.optional(z.string()),
});

function text(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

/** The fields a body offers. Each sender uses them differently, and one of the wrong shape simply offers none. */
function readFields(raw: string) {
  try {
    const parsed = z.record(z.string(), z.json()).safeParse(JSON.parse(raw));
    if (!parsed.success) return {};
    const strings = Object.fromEntries(Object.entries(parsed.data).filter((entry) => z.string().safeParse(entry[1]).success));
    return bodyFields.parse(strings);
  } catch (error) {
    // Unsigned senders often post plain text or a form; it stays the body.
    if (error instanceof SyntaxError) return {};
    throw error;
  }
}

/** What a delivery says about itself, read only from fields the sender can't use to change its route. */
export function webhookEvent(
  webhook: Exclude<EventSourceWebhook, "none">,
  label: string,
  body: Uint8Array,
  headers: Headers,
): EventInput {
  const raw = new TextDecoder().decode(body);
  const parsed = readFields(raw);
  const stable = webhook === "github" ? headers.get("x-github-delivery")
    : webhook === "stripe" ? text(parsed.id)
    : headers.get("webhook-id") ?? text(parsed.id);
  const title = webhook === "github" ? `${headers.get("x-github-event") ?? "event"}${text(parsed.action) ? ` ${text(parsed.action)}` : ""}`
    : webhook === "stripe" ? text(parsed.type)
    : text(parsed.title) ?? text(parsed.subject) ?? text(parsed.type) ?? text(parsed.event);
  const preview = text(parsed.preview) ?? text(parsed.summary) ?? text(parsed.message) ?? text(parsed.text);
  return {
    ...(stable ? { id: stable } : undefined),
    title: title ?? `New event from ${label}`,
    ...(preview ? { preview } : undefined),
    body: raw,
  };
}

export function newWebhookSecret(webhook: EventSourceWebhook): string | null {
  if (webhook === "none") return null;
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  // Standard Webhooks keys are base64. GitHub and Stripe take the string as it stands.
  return webhook === "standard" ? `whsec_${toBase64(bytes)}` : toHex(bytes);
}
