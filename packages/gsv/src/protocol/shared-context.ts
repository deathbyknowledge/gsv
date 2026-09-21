import { z } from "zod/mini";
import { actorRefSchema, originMessageRefSchema, socialIdSchema, type ActorRef, type OriginMessageRef } from "./social-identity";
import { federationPublicKeySchema, type FederationPublicKey } from "./syscalls/contact";

export type SharedContextKind = "connection" | "recommendation" | "advisory";
export type SharedContextQuote = { text: string; reference?: OriginMessageRef };
export type SharedContextAssertion = {
  domain: "gsv-federation/2/context";
  id: string; issuer: ActorRef; subject: ActorRef; revision: number; kind: SharedContextKind;
  label: string; text: string; category?: string; evidence: SharedContextQuote[];
  audience: "subscribed-direct-contacts"; issuedAtMs: number; expiresAtMs: number;
};
export type SignedContextAssertion = { assertion: SharedContextAssertion; signature: string };
export type SharedContextConsent = {
  domain: "gsv-federation/2/context-consent";
  actor: ActorRef; assertionId: string; assertionRevision: number; assertionHash: string;
  decision: "approve" | "decline" | "withdraw"; decisionRevision: number;
  expiresAtMs: number; publicKey: FederationPublicKey; signature: string;
};
export type SharedContextRecord = SignedContextAssertion & { consent?: SharedContextConsent };
export type FederationContextConsentRequest = { kind: "context.consent.request"; record: SignedContextAssertion };
export type FederationContextConsentDecision = { kind: "context.consent.decision"; consent: SharedContextConsent };
export type FederationContextWithdrawal = { kind: "context.withdraw"; assertionId: string; throughRevision: number; consentProposal?: boolean };
export type FederationContextDelivery = FederationContextConsentRequest | FederationContextConsentDecision | FederationContextWithdrawal;

export type SharedContextEntry = { sourceContactId: string; record: SharedContextRecord; leaseUntilMs: number; receivedAtMs: number };
export type SharedContextSource = {
  contactId: string; generation: string; revision: number; kinds: SharedContextKind[];
  state: "queued" | "syncing" | "current" | "unavailable"; updatedAtMs?: number; nextSyncAtMs: number;
};
export type SharedContextPublication = {
  record: SharedContextRecord; state: "awaiting-consent" | "published" | "withdrawn" | "expired"; deliveryId?: string;
};
export type SharedContextConsentRequest = { contactId: string; generation: string; record: SignedContextAssertion; consent?: SharedContextConsent; deliveryId?: string };
export type ContactContextListArgs = { subject?: ActorRef; sourceContactId?: string; cursor?: string; limit?: number };
export type ContactContextListResult = { entries: SharedContextEntry[]; next?: string };
export type ContactContextSourcesArgs = Record<string, never>;
export type ContactContextSourcesResult = { sources: SharedContextSource[] };
export type ContactContextSubscribeArgs = { contactId: string; expectedGeneration: string; expectedRevision: number; kinds: SharedContextKind[] };
export type ContactContextSubscribeResult = { source: SharedContextSource | null };
export type ContactContextSyncArgs = { contactId: string; expectedRevision: number };
export type ContactContextSyncResult = { scheduled: true };
export type ContactContextPublicationsArgs = { section: "publications" | "consents"; cursor?: string; limit?: number };
export type ContactContextPublicationsResult = { publications: SharedContextPublication[]; consentRequests: SharedContextConsentRequest[]; next?: string };
export type ContactContextPublishArgs = {
  id: string; expectedRevision: number; idempotencyKey: string;
  subject: ActorRef; kind: SharedContextKind; label: string; text: string; category?: string; expiresAtMs: number;
  evidence?: { conversationId: string; messageId: string; sequence: number; text: string }[];
  retainEvidence?: boolean;
};
export type ContactContextPublishResult = { publication: SharedContextPublication };
export type ContactContextWithdrawArgs = { id: string; expectedRevision: number };
export type ContactContextWithdrawResult = { publication: SharedContextPublication };
export type ContactContextConsentArgs = {
  contactId: string; expectedGeneration: string; assertionId: string; assertionRevision: number;
  expectedDecisionRevision: number; decision: "approve" | "decline" | "withdraw";
};
export type ContactContextConsentResult = { consentRequest: SharedContextConsentRequest };

export const sharedContextKindSchema = z.enum(["connection", "recommendation", "advisory"]);
export const sharedContextKindsSchema = z.array(sharedContextKindSchema).check(z.maxLength(3), z.refine((kinds) => new Set(kinds).size === kinds.length));
const signatureSchema = z.string().check(z.minLength(1), z.maxLength(512));
const positive = z.int().check(z.minimum(1));
export const sharedContextAssertionSchema = z.strictObject({
  domain: z.literal("gsv-federation/2/context"), id: socialIdSchema, issuer: actorRefSchema, subject: actorRefSchema,
  revision: positive, kind: sharedContextKindSchema,
  label: z.string().check(z.minLength(1), z.maxLength(80)), text: z.string().check(z.maxLength(1024)),
  category: z.optional(z.string().check(z.minLength(1), z.maxLength(64))),
  evidence: z.array(z.strictObject({ text: z.string().check(z.minLength(1), z.maxLength(512)), reference: z.optional(originMessageRefSchema) })).check(z.maxLength(3)),
  audience: z.literal("subscribed-direct-contacts"), issuedAtMs: positive, expiresAtMs: positive,
}) satisfies z.ZodMiniType<SharedContextAssertion>;
export const signedContextAssertionSchema = z.strictObject({ assertion: sharedContextAssertionSchema, signature: signatureSchema }) satisfies z.ZodMiniType<SignedContextAssertion>;
export const sharedContextConsentSchema = z.strictObject({
  domain: z.literal("gsv-federation/2/context-consent"), actor: actorRefSchema, assertionId: socialIdSchema,
  assertionRevision: positive, assertionHash: z.string().check(z.minLength(1), z.maxLength(128)),
  decision: z.enum(["approve", "decline", "withdraw"]), decisionRevision: z.int().check(z.minimum(1), z.maximum(2)),
  expiresAtMs: positive, publicKey: federationPublicKeySchema, signature: signatureSchema,
}) satisfies z.ZodMiniType<SharedContextConsent>;
export const sharedContextRecordSchema = z.strictObject({ assertion: sharedContextAssertionSchema, signature: signatureSchema, consent: z.optional(sharedContextConsentSchema) }) satisfies z.ZodMiniType<SharedContextRecord>;
export const federationContextConsentRequestSchema = z.strictObject({ kind: z.literal("context.consent.request"), record: signedContextAssertionSchema });
export const federationContextConsentDecisionSchema = z.strictObject({ kind: z.literal("context.consent.decision"), consent: sharedContextConsentSchema });
export const federationContextWithdrawalSchema = z.strictObject({ kind: z.literal("context.withdraw"), assertionId: socialIdSchema, throughRevision: positive, consentProposal: z.optional(z.boolean()) });

export type ContextSyncRequest = {
  domain: "gsv-federation/2/context-sync"; sender: ActorRef; recipientSubjectId: string; generation: string;
  timestampMs: number; nonce: string; kinds: SharedContextKind[]; cursor?: string; signature: string;
};
export type ContextSyncResponse = {
  domain: "gsv-federation/2/context-page"; nonce: string; generation: string; mode: "snapshot" | "delta";
  changes: { id: string; record?: SharedContextRecord }[]; cursor: string; more: boolean; leaseUntilMs: number; signature: string;
};
export const contextSyncRequestSchema = z.strictObject({
  domain: z.literal("gsv-federation/2/context-sync"), sender: actorRefSchema, recipientSubjectId: socialIdSchema,
  generation: socialIdSchema, timestampMs: positive, nonce: socialIdSchema, kinds: sharedContextKindsSchema,
  cursor: z.optional(z.string().check(z.maxLength(4096))), signature: signatureSchema,
}) satisfies z.ZodMiniType<ContextSyncRequest>;
export const contextSyncResponseSchema = z.strictObject({
  domain: z.literal("gsv-federation/2/context-page"), nonce: socialIdSchema, generation: socialIdSchema,
  mode: z.enum(["snapshot", "delta"]),
  changes: z.array(z.strictObject({ id: socialIdSchema, record: z.optional(sharedContextRecordSchema) })).check(z.maxLength(10)),
  cursor: z.string().check(z.maxLength(4096)), more: z.boolean(), leaseUntilMs: positive, signature: signatureSchema,
}) satisfies z.ZodMiniType<ContextSyncResponse>;
