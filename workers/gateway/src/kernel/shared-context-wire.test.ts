import { describe, expect, it, vi } from "vitest";
import { jsonValueSchema, type ContextSyncRequest, type SharedContextConsent, type SignedContextAssertion } from "@humansandmachines/gsv/protocol";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import { testPeer } from "../test-support/peers";
import type { KernelContext } from "./context";
import { FederationIdentity, signContactEnvelope } from "./federation-crypto";
import { FederationStore } from "./federation-store";
import { SharedContextStore } from "./shared-context-store";
import { assertionHash, receiveContextSync, verifyContextConsent, verifyContextRecord } from "./shared-context-wire";
import { commitInboundContext, handleContactContextConsent, handleContactContextPublish, handleContactContextSubscribe, handleContactContextWithdraw, processSharedContext } from "./shared-context";
import { CONSENT_LEASE_MS, CONTEXT_LEASE_MS } from "./shared-context-publications";
import { handleContactDeliveryRetry } from "./federation";

const OWNER = { uid: 1000, gid: 1000, gids: [1000], username: "person", home: "/home/person", cwd: "/home/person" };

describe("authenticated selected relationship context", () => {
  it("retries an exact current proposal and fences it when the human withdraws it", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { ctx, contact } = await fixture(storage);
      ctx.federation.setProtocol(contact.id, contact.generation, { version: 2, features: ["context"], checkedAtMs: Date.now() });
      const result = await handleContactContextPublish({ id: "connection:retry", expectedRevision: 0, idempotencyKey: "intent:retry", kind: "connection",
        subject: { shipId: contact.remoteShipId, subjectId: contact.remoteSubject.id }, label: "Reviewed connection", text: "We work together", expiresAtMs: Date.now() + CONTEXT_LEASE_MS }, ctx);
      const id = result.publication.deliveryId!;
      ctx.federation.markOutboxFailed(id, contact.generation, "pending", "Response lost", null, true, Date.now(), true);
      const failed = ctx.federation.outbox(id)!;
      expect(await handleContactDeliveryRetry({ deliveryId: id, expectedUpdatedAtMs: failed.updatedAtMs }, ctx)).toMatchObject({ deliveryId: id, state: "queued" });
      await handleContactContextWithdraw({ id: "connection:retry", expectedRevision: 1 }, ctx);
      ctx.federation.markOutboxFailed(id, contact.generation, "pending", "Response lost", null, true, Date.now(), true, 1);
      await expect(handleContactDeliveryRetry({ deliveryId: id, expectedUpdatedAtMs: ctx.federation.outbox(id)!.updatedAtMs }, ctx)).rejects.toThrow("superseded");
    });
  });
  it("binds opaque cursors to the viewer, current generation and selected kinds", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { ctx, contact, subject, identity } = await fixture(storage);
      const published = await handleContactContextPublish({ id: "statement:one", expectedRevision: 0, idempotencyKey: "publish:one", kind: "advisory",
        subject: { shipId: "ship:mentioned", subjectId: "subject:mentioned" }, label: "Chosen label", text: "My experience", expiresAtMs: Date.now() + CONTEXT_LEASE_MS }, ctx);
      const request: Omit<ContextSyncRequest, "signature"> = { domain: "gsv-federation/2/context-sync", sender: { shipId: contact.remoteShipId, subjectId: contact.remoteSubject.id },
        recipientSubjectId: subject.id, generation: contact.generation, timestampMs: Date.now(), nonce: "nonce:first", kinds: ["advisory"] };
      const first = await receiveContextSync(await signRequest(request, contact.sharedSecret), ctx);
      expect(first.changes.map((c) => c.record?.assertion.text)).toEqual(["My experience"]);
      expect(first.mode).toBe("snapshot");
      expect(first.more).toBe(false);
      expect(first.cursor).not.toContain("statement:one");
      expect(first.cursor).not.toContain("ownerUid");
      const noChanges = await receiveContextSync(await signRequest({ ...request, nonce: "nonce:delta", cursor: first.cursor }, contact.sharedSecret), ctx);
      expect(noChanges.changes).toEqual([]);
      await expect(receiveContextSync(await signRequest({ ...request, cursor: first.cursor, kinds: ["connection"] }, contact.sharedSecret), ctx)).rejects.toThrow("no longer applies");
      const another = ctx.federation.activateContact({ ownerUid: OWNER.uid, remoteShipId: contact.remoteShipId, remoteSubject: { id: "subject:other", displayName: "Other" },
        remoteOrigin: contact.remoteOrigin, remotePublicKey: contact.remotePublicKey, generation: "generation:other", threadId: "thread:other", sharedSecret: contact.sharedSecret });
      await expect(receiveContextSync(await signRequest({ ...request, cursor: first.cursor, sender: { shipId: another.remoteShipId, subjectId: another.remoteSubject.id }, generation: another.generation }, another.sharedSecret), ctx)).rejects.toThrow("no longer applies");
      await handleContactContextWithdraw({ id: "statement:one", expectedRevision: 1 }, ctx);
      const removed = await receiveContextSync(await signRequest({ ...request, nonce: "nonce:withdrawn", cursor: noChanges.cursor }, contact.sharedSecret), ctx);
      expect(removed.changes).toEqual([{ id: "statement:one" }]);
      const sourceAsRemote = { ...contact, remoteShipId: identity.shipId, remoteSubject: subject, remotePublicKey: identity.publicKey };
      await expect(verifyContextRecord(published.publication.record, sourceAsRemote)).resolves.toBeUndefined();
      ctx.federation.revoke(contact.id, OWNER.uid);
      await expect(receiveContextSync(await signRequest(request, contact.sharedSecret), ctx)).rejects.toThrow("unavailable");
    });
  });

  it("requires the other endpoint to sign the exact connection revision and audience", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { ctx, contact, identity, subject } = await fixture(storage);
      const statement: SignedContextAssertion = { assertion: { domain: "gsv-federation/2/context", id: "connection:one",
        issuer: { shipId: identity.shipId, subjectId: subject.id }, subject: { shipId: identity.shipId, subjectId: "subject:other" },
        revision: 1, kind: "connection", label: "Shared label", text: "We collaborate", evidence: [], audience: "subscribed-direct-contacts",
        issuedAtMs: Date.now(), expiresAtMs: Date.now() + CONTEXT_LEASE_MS }, signature: "" };
      statement.signature = await ctx.federationIdentity.sign(jsonValueSchema.parse(statement.assertion));
      const unsigned: Omit<SharedContextConsent, "signature"> = { domain: "gsv-federation/2/context-consent", actor: statement.assertion.subject,
        assertionId: statement.assertion.id, assertionRevision: 1, assertionHash: await assertionHash(statement), decision: "approve", decisionRevision: 1,
        leaseRevision: 1, issuedAtMs: Date.now(), leaseUntilMs: Date.now() + CONSENT_LEASE_MS,
        expiresAtMs: statement.assertion.expiresAtMs, publicKey: identity.publicKey };
      const consent = { ...unsigned, signature: await ctx.federationIdentity.sign(jsonValueSchema.parse(unsigned)) };
      const remote = { ...contact, remoteShipId: identity.shipId, remoteSubject: subject, remotePublicKey: identity.publicKey };
      await expect(verifyContextRecord(statement, remote)).rejects.toThrow("mutual consent");
      await expect(verifyContextRecord({ ...statement, consent }, remote)).resolves.toBeUndefined();
      await expect(verifyContextRecord({ ...statement, consent }, remote, consent.leaseUntilMs)).rejects.toThrow("current mutual consent");
      await expect(verifyContextConsent({ ...statement, assertion: { ...statement.assertion, revision: 2 } }, consent)).rejects.toThrow("exact statement");
      await expect(verifyContextConsent({ ...statement, assertion: { ...statement.assertion, label: "Unapproved label" } }, consent)).rejects.toThrow("exact statement");
      await expect(verifyContextRecord({ ...statement, consent: { ...consent, decision: "withdraw", decisionRevision: 2 } }, remote)).rejects.toThrow("mutual consent");
    });
  });

  it("renews an unchanged local approval and stops issuing proofs after withdrawal", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { ctx, identity, subject } = await fixture(storage);
      const contact = ctx.federation.activateContact({ ownerUid: OWNER.uid, remoteShipId: identity.shipId, remoteSubject: { id: "subject:publisher", displayName: "Publisher" },
        remoteOrigin: "https://publisher.example", remotePublicKey: identity.publicKey, sharedSecret: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", generation: "generation:publisher", threadId: "thread:publisher" });
      const assertion = { domain: "gsv-federation/2/context" as const, id: "connection:renew", issuer: { shipId: identity.shipId, subjectId: contact.remoteSubject.id },
        subject: { shipId: identity.shipId, subjectId: subject.id }, revision: 1, kind: "connection" as const, label: "Reviewed label", text: "Approved wording", evidence: [],
        audience: "subscribed-direct-contacts" as const, issuedAtMs: Date.now(), expiresAtMs: Date.now() + 7 * CONTEXT_LEASE_MS };
      const record = { assertion, signature: await ctx.federationIdentity.sign(jsonValueSchema.parse(assertion)) };
      await commitInboundContext({ kind: "context.consent.request", record }, contact, ctx);
      const args = { contactId: contact.id, expectedGeneration: contact.generation, assertionId: assertion.id, assertionRevision: 1, expectedDecisionRevision: 0, decision: "approve" as const };
      await expect(handleContactContextConsent(args, { ...ctx, processId: "proc:ship" })).rejects.toThrow("signed-in human");
      const first = await handleContactContextConsent(args, ctx);
      expect(first.consentRequest.consent?.leaseRevision).toBe(1);
      ctx.sharedContext.publications.deferRenewal(contact.id, assertion.id, Date.now() - 1);
      await processSharedContext(ctx);
      const renewed = ctx.sharedContext.publications.consentRequest(contact.id, assertion.id)!;
      expect(renewed.consent).toMatchObject({ decision: "approve", decisionRevision: 1, leaseRevision: 2, assertionHash: first.consentRequest.consent!.assertionHash });
      expect(renewed.deliveryId).not.toBe(first.consentRequest.deliveryId);
      await verifyContextConsent(record, renewed.consent!);
      const withdrawn = await handleContactContextConsent({ ...args, expectedDecisionRevision: 1, decision: "withdraw" }, ctx);
      expect(withdrawn.consentRequest.consent).toMatchObject({ decision: "withdraw", decisionRevision: 2, leaseRevision: 3 });
      expect(ctx.sharedContext.publications.nextRenewal()).toBeNull();
      ctx.sharedContext.publications.deferRenewal(contact.id, assertion.id, Date.now() - 1);
      await processSharedContext(ctx);
      expect(ctx.sharedContext.publications.consentRequest(contact.id, assertion.id)?.consent).toEqual(withdrawn.consentRequest.consent);
    });
  });

  it("publishes only on an explicit human action and preserves exact retry identity", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { ctx, contact } = await fixture(storage);
      const args = { id: "statement:one", expectedRevision: 0, idempotencyKey: "intent:one", kind: "recommendation" as const,
        subject: { shipId: "ship:mentioned", subjectId: "subject:mentioned" }, label: "Deliberate label", text: "My words", expiresAtMs: Date.now() + CONTEXT_LEASE_MS };
      await expect(handleContactContextPublish(args, { ...ctx, processId: "proc:ship" })).rejects.toThrow("signed-in human");
      await expect(handleContactContextSubscribe({ contactId: contact.id, expectedGeneration: contact.generation, expectedRevision: 0, kinds: ["advisory"] }, { ...ctx, processId: "proc:ship" })).rejects.toThrow("signed-in human");
      const first = await handleContactContextPublish(args, ctx);
      expect(await handleContactContextPublish(args, ctx)).toEqual(first);
      await expect(handleContactContextPublish({ ...args, text: "Changed" }, ctx)).rejects.toThrow("different content");
      expect(ctx.sharedContext.publications.list(OWNER.uid)).toHaveLength(1);
      expect(ctx.sharedContext.publications.list(2000)).toEqual([]);
    });
  });
});

async function signRequest(request: Omit<ContextSyncRequest, "signature">, secret: string): Promise<ContextSyncRequest> {
  return { ...request, signature: await signContactEnvelope(secret, jsonValueSchema.parse(request)) };
}

async function fixture(storage: DurableObjectStorage) {
  const federation = new FederationStore(storage);
  const federationIdentity = new FederationIdentity(storage);
  const identity = await federationIdentity.ensure("https://source.example");
  const subject = federation.ensureSubject(OWNER.uid, "Private name");
  const contact = federation.activateContact({ ownerUid: OWNER.uid, remoteShipId: "ship:viewer", remoteSubject: { id: "subject:viewer", displayName: "Viewer" },
    remoteOrigin: "https://viewer.example", remotePublicKey: identity.publicKey, sharedSecret: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", generation: "generation:one", threadId: "thread:one" });
  const context = { federation, federationIdentity, sharedContext: new SharedContextStore(storage), connection: {}, callerOwnerUid: OWNER.uid,
    peer: testPeer({ kind: "human", account: OWNER, calls: ["contact.*"] }), installationIdentity: { canonicalOrigin: "https://source.example" },
    auth: { getPasswdByUid: () => OWNER, getShadowByUsername: () => ({ hash: "unlocked" }), isPersonalAgentUid: () => false, isAccountDisabled: () => false },
    broadcastToUserUid: vi.fn(), scheduleSharedContext: vi.fn(async () => {}), scheduleFederationDelivery: vi.fn(async () => {}) };
  // SAFETY: real owning stores and cryptographic keys; only authenticated identity and background scheduling are supplied by the fixture.
  return { ctx: context as KernelContext, contact, subject, identity };
}
