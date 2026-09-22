import { z } from "zod/mini";
import {
  contextSyncResponseSchema, jsonValueSchema, sharedContextKindsSchema, sharedContextRecordSchema,
  type ActorRef, type ContextSyncRequest, type ContextSyncResponse, type FederationPublicKey,
  type SharedContextRecord, type SharedContextConsent, type SignedContextAssertion,
} from "@humansandmachines/gsv/protocol";
import type { KernelContext } from "./context";
import type { FederationContactRecord } from "./federation-store";
import { base64UrlDecode, base64UrlEncode, canonicalJson, sha256Base64Url, signContactEnvelope, verifyContactEnvelope, verifySignedValue } from "./federation-crypto";
import { requireOwnedActiveContactGeneration } from "./federation/authority";
import { fetchFederationJson } from "./federation/http";
import { consumePublicRateLimits } from "./federation/limits";
import { FederationHttpError, PublicFederationError } from "./federation/errors";
import { profileOwnerActive } from "./profiles";
import { CONSENT_LEASE_MS, CONTEXT_LEASE_MS, publication } from "./shared-context-publications";

export const CONTEXT_SYNC_PATH = "/_gsv/federation/v2/context";
export const CONTEXT_LIFETIME_MS = 30 * CONTEXT_LEASE_MS;
const cursorSchema = z.strictObject({
  ownerUid: z.int(), contactId: z.string(), generation: z.string(), kinds: sharedContextKindsSchema,
  mode: z.enum(["snapshot", "delta"]), after: z.int().check(z.nonnegative()),
  watermark: z.nullable(z.int().check(z.nonnegative())), expiresAt: z.int(),
});
type ContextCursor = z.infer<typeof cursorSchema>;
const encoder = new TextEncoder();
const CURSOR_KEY = "social_context_cursor_key_v1";
const CURSOR_DOMAIN = encoder.encode("gsv-federation/2/context-cursor");

export function sameActor(a: ActorRef, b: ActorRef): boolean { return a.shipId === b.shipId && a.subjectId === b.subjectId; }
export function remoteActor(contact: FederationContactRecord): ActorRef { return { shipId: contact.remoteShipId, subjectId: contact.remoteSubject.id }; }

export async function assertionHash(record: SignedContextAssertion): Promise<string> {
  return sha256Base64Url(canonicalJson(jsonValueSchema.parse(record.assertion)));
}

export async function verifyContextAssertion(record: SignedContextAssertion, key: FederationPublicKey, actor: ActorRef, now = Date.now()): Promise<void> {
  const a = record.assertion;
  if (!sameActor(a.issuer, actor) || a.issuer.shipId !== `ship:${await sha256Base64Url(canonicalJson(jsonValueSchema.parse(key)))}`) throw new Error("Shared statement issuer does not match its source");
  if (sameActor(a.issuer, a.subject)) throw new Error("Shared relationship context must concern another person");
  if (a.issuedAtMs > now + 5 * 60_000 || a.expiresAtMs <= now || a.expiresAtMs <= a.issuedAtMs || a.expiresAtMs - a.issuedAtMs > CONTEXT_LIFETIME_MS) throw new Error("Shared statement validity window is invalid");
  if (encoder.encode(JSON.stringify(record)).length > 8192 || !await verifySignedValue(key, jsonValueSchema.parse(a), record.signature)) throw new Error("Shared statement signature is invalid");
}

export async function verifyContextConsent(record: SignedContextAssertion, consent: SharedContextConsent, now = Date.now()): Promise<void> {
  const { signature, ...unsigned } = consent;
  const a = record.assertion;
  if (a.kind !== "connection" || !sameActor(consent.actor, a.subject) || consent.assertionId !== a.id || consent.assertionRevision !== a.revision
    || consent.assertionHash !== await assertionHash(record) || consent.expiresAtMs !== a.expiresAtMs
    || (consent.decision === "withdraw" ? consent.decisionRevision !== 2 : consent.decisionRevision !== 1)
    || consent.issuedAtMs > now + 5 * 60_000
    || (consent.decision === "approve" ? consent.leaseUntilMs <= consent.issuedAtMs || consent.leaseUntilMs > consent.issuedAtMs + CONSENT_LEASE_MS || consent.leaseUntilMs > a.expiresAtMs : consent.leaseUntilMs !== consent.issuedAtMs)
    || consent.actor.shipId !== `ship:${await sha256Base64Url(canonicalJson(jsonValueSchema.parse(consent.publicKey)))}`
    || !await verifySignedValue(consent.publicKey, jsonValueSchema.parse(unsigned), signature)) throw new Error("Connection consent does not authorize this exact statement");
}

export async function verifyContextRecord(record: SharedContextRecord, contact: FederationContactRecord, now = Date.now()): Promise<void> {
  await verifyContextAssertion(record, contact.remotePublicKey, remoteActor(contact), now);
  if (record.assertion.kind === "connection") {
    if (!record.consent || record.consent.decision !== "approve" || record.consent.leaseUntilMs <= now) throw new Error("Connection disclosure has no current mutual consent");
    await verifyContextConsent(record, record.consent, now);
  } else if (record.consent) throw new Error("Unexpected connection consent on a statement");
  if (encoder.encode(JSON.stringify(record)).length > 8192) throw new Error("Shared statement is too large");
}

export async function receiveContextSync(request: ContextSyncRequest, ctx: KernelContext): Promise<ContextSyncResponse> {
  if (Math.abs(Date.now() - request.timestampMs) > 5 * 60_000 || request.kinds.length === 0) throw new PublicFederationError(400, "Invalid shared context request");
  const contact = ctx.federation.getForInbound(request.sender.shipId, request.sender.subjectId, request.recipientSubjectId);
  if (!contact || contact.generation !== request.generation || contact.state !== "active" || !profileOwnerActive(contact.ownerUid, ctx)) throw new PublicFederationError(404, "Shared context source unavailable");
  const { signature, ...unsignedRequest } = request;
  if (!await verifyContactEnvelope(contact.sharedSecret, jsonValueSchema.parse(unsignedRequest), signature)) throw new PublicFederationError(401, "Invalid shared context signature");
  consumePublicRateLimits(ctx, [
    { scope: `context:${contact.id}`, operation: "context.sync", maximum: 30, windowMs: 60_000 },
    { scope: "installation", operation: "context.sync", maximum: 120, windowMs: 60_000 },
  ], Date.now(), "Shared context sync limit reached");
  let cursor: ContextCursor;
  const kinds = request.kinds.slice().sort();
  const publications = ctx.sharedContext.publications;
  if (request.cursor) {
    try { cursor = await openCursor(request.cursor, ctx); }
    catch { throw new PublicFederationError(409, "Shared context cursor expired; start a new snapshot"); }
    if (cursor.ownerUid !== contact.ownerUid || cursor.contactId !== contact.id || cursor.generation !== contact.generation
      || JSON.stringify(cursor.kinds) !== JSON.stringify(kinds) || cursor.expiresAt <= Date.now()) throw new PublicFederationError(409, "Shared context cursor no longer applies");
  } else {
    cursor = { ownerUid: contact.ownerUid, contactId: contact.id, generation: contact.generation, kinds,
      mode: "snapshot", after: 0, watermark: null, expiresAt: Date.now() + CONTEXT_LEASE_MS };
  }
  requireOwnedActiveContactGeneration(contact, contact.ownerUid, ctx);
  const now = Date.now();
  const sequence = publications.sequence(contact.ownerUid);
  const watermark = cursor.watermark ?? sequence;
  const rows = publications.page(contact, kinds, cursor.after, watermark, now);
  const selected = rows.slice(0, 10);
  const more = rows.length > 10;
  const changes: ContextSyncResponse["changes"] = selected.map((row) => ({ id: row.id,
    ...(publication(row, now).state === "published" && kinds.includes(row.kind)
      ? { record: sharedContextRecordSchema.parse(JSON.parse(row.record_json)) } : undefined) }));
  const leaseUntilMs = now + CONTEXT_LEASE_MS;
  const next: ContextCursor = more ? { ...cursor, watermark, after: selected.at(-1)!.sequence }
    : { ...cursor, mode: "delta", watermark: null, after: watermark, expiresAt: now + CONTEXT_LEASE_MS };
  const encodedCursor = await sealCursor(next, ctx);
  const unsigned: Omit<ContextSyncResponse, "signature"> = { domain: "gsv-federation/2/context-page", nonce: request.nonce,
    generation: contact.generation, mode: cursor.mode, changes, cursor: encodedCursor, more, leaseUntilMs };
  const response = { ...unsigned, signature: await signContactEnvelope(contact.sharedSecret, jsonValueSchema.parse(unsigned)) };
  ctx.federation.transaction(() => {
    requireOwnedActiveContactGeneration(contact, contact.ownerUid, ctx);
    if (!profileOwnerActive(contact.ownerUid, ctx) || publications.sequence(contact.ownerUid) !== sequence) throw new PublicFederationError(409, "Shared context changed during sync");
    for (const row of selected) if (publication(row, now).state === "published" && kinds.includes(row.kind)) publications.rememberViewer(contact, row, leaseUntilMs);
    if (!more) publications.renewViewers(contact, kinds, leaseUntilMs);
  });
  return response;
}

export async function syncContextSource(ctx: KernelContext): Promise<void> {
  const sources = ctx.sharedContext.sources;
  const due = sources.due();
  if (!due) return;
  let row = due;
  try {
    const started = sources.begin(row);
    if (!started) return;
    row = started;
    if (!profileOwnerActive(row.owner_uid, ctx)) throw new Error("Shared context owner is inactive");
    if (row.run_started !== null && row.run_started < Date.now() - CONTEXT_LEASE_MS) throw new FederationHttpError(409, "Shared context snapshot expired");
    const contact = ctx.federation.get(row.contact_id);
    if (!contact || contact.state !== "active" || contact.generation !== row.generation) return;
    const origin = ctx.installationIdentity?.canonicalOrigin;
    const subject = ctx.federation.subject(row.owner_uid);
    if (!origin || !subject) throw new Error("Local shared context identity is unavailable");
    const identity = await ctx.federationIdentity.ensure(origin);
    const unsigned: Omit<ContextSyncRequest, "signature"> = {
      domain: "gsv-federation/2/context-sync", sender: { shipId: identity.shipId, subjectId: subject.id },
      recipientSubjectId: contact.remoteSubject.id, generation: contact.generation, timestampMs: Date.now(), nonce: crypto.randomUUID(),
      kinds: sharedContextKindsSchema.parse(JSON.parse(row.kinds_json)), ...(row.next_cursor ? { cursor: row.next_cursor } : undefined),
    };
    const body = { ...unsigned, signature: await signContactEnvelope(contact.sharedSecret, jsonValueSchema.parse(unsigned)) };
    const page = contextSyncResponseSchema.parse(await fetchFederationJson(`${contact.remoteOrigin}${CONTEXT_SYNC_PATH}`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, ctx));
    const { signature, ...unsignedPage } = page;
    if (page.nonce !== unsigned.nonce || page.generation !== contact.generation || page.leaseUntilMs <= Date.now()
      || page.leaseUntilMs > unsigned.timestampMs + CONTEXT_LEASE_MS + 5 * 60_000
      || !await verifyContactEnvelope(contact.sharedSecret, jsonValueSchema.parse(unsignedPage), signature)) throw new Error("Shared context page does not match its request");
    for (const change of page.changes) if (change.record) await verifyContextRecord(change.record, contact);
    requireOwnedActiveContactGeneration(contact, row.owner_uid, ctx);
    if (!profileOwnerActive(row.owner_uid, ctx)) throw new Error("Shared context owner is inactive");
    // A source's clock never extends our local maximum display lease.
    page.leaseUntilMs = Math.min(page.leaseUntilMs, unsigned.timestampMs + CONTEXT_LEASE_MS);
    if (sources.apply(row, page)) ctx.broadcastToUserUid(row.owner_uid, "contact.context.changed");
  } catch (error) {
    sources.fail(row, error instanceof FederationHttpError && error.status === 409);
    ctx.broadcastToUserUid(row.owner_uid, "contact.context.changed");
  }
}

async function cursorKey(ctx: KernelContext): Promise<CryptoKey> {
  const storage = ctx.sharedContext.storage;
  let bytes = storage.kv.get<Uint8Array>(CURSOR_KEY);
  if (!bytes) { bytes = crypto.getRandomValues(new Uint8Array(32)); storage.kv.put(CURSOR_KEY, bytes); }
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function sealCursor(value: ContextCursor, ctx: KernelContext): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const body = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: CURSOR_DOMAIN }, await cursorKey(ctx), encoder.encode(JSON.stringify(value))));
  const packed = new Uint8Array(iv.length + body.length); packed.set(iv); packed.set(body, iv.length);
  return base64UrlEncode(packed);
}

async function openCursor(value: string, ctx: KernelContext): Promise<ContextCursor> {
  const bytes = base64UrlDecode(value);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12), additionalData: CURSOR_DOMAIN }, await cursorKey(ctx), bytes.slice(12));
  return cursorSchema.parse(JSON.parse(new TextDecoder().decode(plain)));
}
