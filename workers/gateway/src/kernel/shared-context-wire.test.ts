import { describe, expect, it, vi } from "vitest";
import { jsonValueSchema, type ContextSyncRequest, type SharedContextConsent, type SignedContextAssertion } from "@humansandmachines/gsv/protocol";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import { testPeer } from "../test-support/peers";
import type { KernelContext } from "./context";
import { FederationIdentity, signContactEnvelope } from "./federation-crypto";
import { FederationStore } from "./federation-store";
import { SharedContextStore } from "./shared-context-store";
import { assertionHash, receiveContextSync, verifyContextConsent, verifyContextRecord } from "./shared-context-wire";
import { handleContactContextPublish, handleContactContextSubscribe, handleContactContextWithdraw } from "./shared-context";
import { CONTEXT_LEASE_MS } from "./shared-context-publications";

const OWNER = { uid: 1000, gid: 1000, gids: [1000], username: "person", home: "/home/person", cwd: "/home/person" };

describe("authenticated selected relationship context", () => {
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
        expiresAtMs: statement.assertion.expiresAtMs, publicKey: identity.publicKey };
      const consent = { ...unsigned, signature: await ctx.federationIdentity.sign(jsonValueSchema.parse(unsigned)) };
      const remote = { ...contact, remoteShipId: identity.shipId, remoteSubject: subject, remotePublicKey: identity.publicKey };
      await expect(verifyContextRecord(statement, remote)).rejects.toThrow("mutual consent");
      await expect(verifyContextRecord({ ...statement, consent }, remote)).resolves.toBeUndefined();
      await expect(verifyContextConsent({ ...statement, assertion: { ...statement.assertion, revision: 2 } }, consent)).rejects.toThrow("exact statement");
      await expect(verifyContextConsent({ ...statement, assertion: { ...statement.assertion, label: "Unapproved label" } }, consent)).rejects.toThrow("exact statement");
      await expect(verifyContextRecord({ ...statement, consent: { ...consent, decision: "withdraw", decisionRevision: 2 } }, remote)).rejects.toThrow("mutual consent");
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
