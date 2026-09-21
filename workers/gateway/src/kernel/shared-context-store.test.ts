import { describe, expect, it } from "vitest";
import type { ContextSyncResponse, SharedContextKind, SharedContextRecord } from "@humansandmachines/gsv/protocol";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import { FederationStore } from "./federation-store";
import { SharedContextStore } from "./shared-context-store";
import { CONTEXT_LEASE_MS } from "./shared-context-publications";

describe("selected shared context storage", () => {
  it("pages the owner's publications independently from consent requests", async () => {
    await runWithRealKernelSql((_sql, storage) => {
      const { context, federation } = fixture(storage);
      for (const id of ["one", "two", "three"]) federation.transaction(() => context.publications.write({ ownerUid: 1000, expectedRevision: 0, expectedSequence: 0, record: record(id), intentId: `intent:${id}`, intentHash: id }));
      const first = context.publications.ownedPage(1000, { section: "publications", limit: 2 });
      expect(first.publications).toHaveLength(2);
      expect(first.next).toBeDefined();
      const second = context.publications.ownedPage(1000, { section: "publications", limit: 2, cursor: first.next });
      expect(second.publications).toHaveLength(1);
      expect(new Set([...first.publications, ...second.publications].map((item) => item.record.assertion.id)).size).toBe(3);
      expect(context.publications.ownedPage(2000, { section: "publications" }).publications).toEqual([]);
      expect(context.publications.ownedPage(1000, { section: "consents" }).consentRequests).toEqual([]);
    });
  });
  it("stages snapshots and keeps the last complete projection through a failed continuation", async () => {
    await runWithRealKernelSql((_sql, storage) => {
      const { context, contact } = fixture(storage);
      const sources = context.sources;
      sources.subscribe(contact, 0, ["advisory"]);
      const first = sources.begin(sources.row(contact.id)!)!;
      sources.apply(first, page([record("one")], false));
      expect(sources.entries(1000, {}).entries.map((e) => e.record.assertion.id)).toEqual(["one"]);
      sources.schedule(contact.id, 1);
      const next = sources.begin(sources.row(contact.id)!)!;
      sources.apply(next, { ...page([record("two")], true), mode: "delta" });
      expect(sources.entries(1000, {}).entries.map((e) => e.record.assertion.id)).toEqual(["one"]);
      sources.fail(sources.row(contact.id)!, true);
      expect(new SharedContextStore(storage).sources.entries(1000, {}).entries.map((e) => e.record.assertion.id)).toEqual(["one"]);
      expect(sources.entries(2000, {}).entries).toEqual([]);
      expect(sources.entries(1000, {}, Date.now() + CONTEXT_LEASE_MS + 1).entries).toEqual([]);
    });
  });

  it("fences late sync responses after withdrawal, unsubscribe, resubscribe and contact replacement", async () => {
    await runWithRealKernelSql((_sql, storage) => {
      const { context, contact, federation } = fixture(storage);
      const sources = context.sources;
      sources.subscribe(contact, 0, ["advisory"]);
      const old = sources.begin(sources.row(contact.id)!)!;
      sources.receiveWithdrawal(contact, "one", 1);
      expect(sources.apply(old, page([record("one")], false))).toBe(false);
      const next = sources.begin(sources.row(contact.id)!)!;
      sources.subscribe(contact, 1, []);
      sources.subscribe(contact, 0, ["advisory"]);
      expect(sources.apply(next, page([record("one")], false))).toBe(false);
      const final = sources.begin(sources.row(contact.id)!)!;
      sources.apply(final, page([record("one")], false));
      federation.activateContact({ ownerUid: contact.ownerUid, remoteShipId: contact.remoteShipId, remoteSubject: contact.remoteSubject,
        remoteOrigin: contact.remoteOrigin, remotePublicKey: contact.remotePublicKey, sharedSecret: "next-secret", generation: "generation:two", threadId: "thread:two" });
      expect(sources.entries(1000, {}).entries).toEqual([]);
      expect(sources.list(1000)).toEqual([]);
    });
  });

  it("pages only a selected actor or source and refuses a cursor moved to another view", async () => {
    await runWithRealKernelSql((_sql, storage) => {
      const { context, contact } = fixture(storage);
      context.sources.subscribe(contact, 0, ["advisory"]);
      context.sources.apply(context.sources.begin(context.sources.row(contact.id)!)!, page([record("one"), record("two")], false));
      const subject = record("one").assertion.subject;
      const first = context.sources.entries(1000, { subject, limit: 1 });
      expect(first.entries).toHaveLength(1);
      expect(context.sources.entries(1000, { subject, cursor: first.next, limit: 1 }).entries[0].record.assertion.id).toBe("two");
      expect(() => context.sources.entries(1000, { cursor: first.next })).toThrow("another view");
    });
  });

  it("keeps an incomplete oversized snapshot out of the visible cache", async () => {
    await runWithRealKernelSql((_sql, storage) => {
      const { context, contact } = fixture(storage);
      context.sources.subscribe(contact, 0, ["advisory"]);
      let current = context.sources.begin(context.sources.row(contact.id)!)!;
      for (let offset = 0; offset < 120; offset += 10) {
        context.sources.apply(current, { ...page(Array.from({ length: 10 }, (_, i) => record(`id:${offset + i}`)), true), cursor: `cursor:${offset}` });
        current = context.sources.row(contact.id)!;
      }
      expect(() => context.sources.apply(current, page(Array.from({ length: 10 }, (_, i) => record(`id:${120 + i}`)), false))).toThrow("capacity");
      expect(context.sources.entries(1000, {}).entries).toEqual([]);
    });
  });

  it("never extends the other endpoint's consent proof when the source renews its page lease", async () => {
    await runWithRealKernelSql((_sql, storage) => {
      const { context, contact } = fixture(storage);
      const statement = record("connection:one", "connection");
      const now = Date.now();
      const proofUntil = now + 60 * 60_000;
      statement.consent = { domain: "gsv-federation/2/context-consent", actor: statement.assertion.subject,
        assertionId: statement.assertion.id, assertionRevision: 1, assertionHash: "hash", decision: "approve", decisionRevision: 1,
        leaseRevision: 1, issuedAtMs: now, leaseUntilMs: proofUntil, expiresAtMs: statement.assertion.expiresAtMs,
        publicKey: { kty: "EC", crv: "P-256", x: "x", y: "y" }, signature: "signature" };
      context.sources.subscribe(contact, 0, ["connection"]);
      context.sources.apply(context.sources.begin(context.sources.row(contact.id)!)!, page([statement], false));
      expect(context.sources.entries(1000, {}).entries[0].leaseUntilMs).toBe(proofUntil);
      const delta = context.sources.begin(context.sources.row(contact.id)!)!;
      context.sources.apply(delta, { ...page([], false), mode: "delta", leaseUntilMs: now + 2 * CONTEXT_LEASE_MS });
      expect(context.sources.entries(1000, {}, proofUntil).entries).toEqual([]);
    });
  });

  it("retains withdrawal receipts across lease renewal and refuses a publication prepared before withdrawal", async () => {
    await runWithRealKernelSql((_sql, storage) => {
      const { context, contact, federation } = fixture(storage);
      const recordOne = record("one");
      federation.transaction(() => context.publications.write({ ownerUid: 1000, expectedRevision: 0, expectedSequence: 0, record: recordOne, intentId: "intent:one", intentHash: "one" }));
      const original = context.publications.row(1000, "one")!;
      context.publications.rememberViewer(contact, original, Date.now() + 1000);
      context.publications.renewViewers(contact, ["advisory"], Date.now() + CONTEXT_LEASE_MS);
      federation.transaction(() => context.publications.withdraw(1000, "one", 1));
      expect(context.publications.withdrawals()[0]).toMatchObject({ assertion_id: "one", contact_id: contact.id, withdraw_through: 1 });
      expect(() => federation.transaction(() => context.publications.write({ ownerUid: 1000, expectedRevision: 1, expectedSequence: original.sequence,
        record: { ...recordOne, assertion: { ...recordOne.assertion, revision: 2 } }, intentId: "intent:two", intentHash: "two" }))).toThrow("changed");
      expect(context.publications.list(1000)[0].state).toBe("withdrawn");
    });
  });

  it("keeps a cancelled proposal cancelled when its delayed request finally arrives", async () => {
    await runWithRealKernelSql((_sql, storage) => {
      const { context, contact } = fixture(storage);
      context.publications.cancelConsentRequest(contact, "one", 1);
      context.publications.receiveConsentRequest(contact, record("one", "connection"));
      expect(context.publications.consentRequests(1000)).toEqual([]);
      const replacement = record("one", "connection");
      replacement.assertion.revision = 2;
      context.publications.receiveConsentRequest(contact, replacement);
      expect(context.publications.consentRequests(1000)[0].record.assertion.revision).toBe(2);
      context.publications.cancelConsentRequest(contact, "one", 1);
      expect(context.publications.consentRequests(1000)).toHaveLength(1);
    });
  });
});

function fixture(storage: DurableObjectStorage) {
  const federation = new FederationStore(storage);
  const contact = federation.activateContact({ ownerUid: 1000, remoteShipId: "ship:source", remoteSubject: { id: "subject:source", displayName: "Source" },
    remoteOrigin: "https://source.example", remotePublicKey: { kty: "EC", crv: "P-256", x: "x", y: "y" }, sharedSecret: "secret", generation: "generation:one", threadId: "thread:one" });
  return { federation, contact, context: new SharedContextStore(storage) };
}

function record(id: string, kind: SharedContextKind = "advisory"): SharedContextRecord {
  return { assertion: { domain: "gsv-federation/2/context", id, issuer: { shipId: "ship:source", subjectId: "subject:source" },
    subject: { shipId: "ship:person", subjectId: "subject:person" }, revision: 1, kind, label: "Reviewed label", text: "An attributed statement",
    evidence: [], audience: "subscribed-direct-contacts", issuedAtMs: Date.now(), expiresAtMs: Date.now() + 2 * CONTEXT_LEASE_MS }, signature: "signature" };
}

function page(records: SharedContextRecord[], more: boolean): ContextSyncResponse {
  return { domain: "gsv-federation/2/context-page", nonce: "nonce", generation: "generation:one", mode: "snapshot",
    changes: records.map((record) => ({ id: record.assertion.id, record })), cursor: "cursor", more, leaseUntilMs: Date.now() + CONTEXT_LEASE_MS, signature: "signature" };
}
