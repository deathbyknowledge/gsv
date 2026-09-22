import {
  sharedContextRecordSchema, sharedContextConsentSchema, signedContextAssertionSchema,
  type SharedContextPublication, type SharedContextConsent,
  type SharedContextConsentRequest, type SignedContextAssertion, type SharedContextKind,
  type ContactContextPublicationsArgs, type ContactContextPublicationsResult,
} from "@humansandmachines/gsv/protocol";
import type { FederationContactRecord } from "./federation-store";

export const CONTEXT_LEASE_MS = 24 * 60 * 60_000;
export const CONSENT_LEASE_MS = CONTEXT_LEASE_MS - 5 * 60_000;
const RENEW_BEFORE_MS = 12 * 60 * 60_000;
const RETENTION_MS = 8 * CONTEXT_LEASE_MS;
export type ContextPublicationRow = {
  owner_uid: number; id: string; sequence: number; revision: number; kind: SharedContextKind;
  state: "pending" | "published" | "withdrawn"; record_json: string; expires_at: number;
  intent_id: string; intent_hash: string; delivery_id: string | null;
  subject_contact_id: string | null; subject_generation: string | null; retired_at: number | null;
};
type ConsentRow = { owner_uid: number; contact_id: string; generation: string; assertion_id: string; revision: number; record_json: string | null; consent_json: string | null; delivery_id: string | null; expires_at: number; renewal_after: number | null };
export type ContextReceiptRow = { owner_uid: number; assertion_id: string; contact_id: string; generation: string; revision: number; lease_until: number; withdraw_through: number; consent_proposal: number };

export class ContextPublications {
  constructor(private readonly sql: SqlStorage) {}

  row(ownerUid: number, id: string): ContextPublicationRow | null {
    return this.sql.exec<ContextPublicationRow>("SELECT * FROM social_context_publications WHERE owner_uid = ? AND id = ?", ownerUid, id).toArray()[0] ?? null;
  }

  list(ownerUid: number, now = Date.now()): SharedContextPublication[] {
    return this.sql.exec<ContextPublicationRow>("SELECT * FROM social_context_publications WHERE owner_uid = ? ORDER BY sequence DESC", ownerUid).toArray().map((row) => publication(row, now));
  }

  ownedPage(ownerUid: number, args: ContactContextPublicationsArgs, now = Date.now()): ContactContextPublicationsResult {
    const limit = args.limit ?? 20;
    if (args.section === "publications") {
      const rows = this.sql.exec<ContextPublicationRow>("SELECT * FROM social_context_publications WHERE owner_uid = ? AND id > ? ORDER BY id LIMIT ?", ownerUid, args.cursor ?? "", limit + 1).toArray();
      const selected = rows.slice(0, limit);
      return { publications: selected.map((row) => publication(row, now)), consentRequests: [], ...(rows.length > limit ? { next: selected.at(-1)!.id } : undefined) };
    }
    const rows = this.sql.exec<ConsentRow>(`SELECT r.* FROM social_context_consents r JOIN federation_contacts c ON c.contact_id = r.contact_id
      AND c.owner_uid = r.owner_uid AND c.generation = r.generation AND c.state = 'active'
      WHERE r.owner_uid = ? AND r.expires_at > ? AND r.record_json IS NOT NULL AND (r.contact_id || char(0) || r.assertion_id) > ?
      ORDER BY r.contact_id, r.assertion_id LIMIT ?`, ownerUid, now, args.cursor ?? "", limit + 1).toArray();
    const selected = rows.slice(0, limit);
    const last = selected.at(-1);
    return { publications: [], consentRequests: selected.map(consentRequest), ...(rows.length > limit && last ? { next: `${last.contact_id}\u0000${last.assertion_id}` } : undefined) };
  }

  write(input: { ownerUid: number; expectedRevision: number; expectedSequence: number; record: SignedContextAssertion; intentId: string; intentHash: string; contact?: FederationContactRecord; deliveryId?: string }, now = Date.now()): SharedContextPublication {
    const a = input.record.assertion;
    const existing = this.row(input.ownerUid, a.id);
    if (existing?.intent_id === input.intentId) {
      if (existing.intent_hash !== input.intentHash) throw new Error("Publication intent was reused for different content");
      return publication(existing, now);
    }
    if ((existing?.revision ?? 0) !== input.expectedRevision || (existing?.sequence ?? 0) !== input.expectedSequence || a.revision !== input.expectedRevision + 1) throw new Error("Shared statement changed; review it again");
    if (!existing) {
      const count = this.sql.exec<{ total: number; owner: number }>("SELECT count(*) AS total, COALESCE(sum(owner_uid = ?), 0) AS owner FROM social_context_publications", input.ownerUid).one();
      if (count.owner >= 128 || count.total >= 512) throw new Error("Shared statement capacity reached");
    }
    if (existing) this.queueWithdrawals(existing);
    const recordJson = JSON.stringify(input.record);
    if (new TextEncoder().encode(recordJson).length > (a.kind === "connection" ? 6144 : 8192)) throw new Error("Shared statement is too large");
    this.sql.exec(`INSERT INTO social_context_publications
      (owner_uid, id, sequence, revision, kind, state, record_json, expires_at, intent_id, intent_hash, delivery_id, subject_contact_id, subject_generation)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(owner_uid, id) DO UPDATE SET sequence = excluded.sequence, revision = excluded.revision, kind = excluded.kind,
      state = excluded.state, record_json = excluded.record_json, expires_at = excluded.expires_at, intent_id = excluded.intent_id,
      intent_hash = excluded.intent_hash, delivery_id = excluded.delivery_id, subject_contact_id = excluded.subject_contact_id,
      subject_generation = excluded.subject_generation, retired_at = NULL`,
    input.ownerUid, a.id, this.advance(input.ownerUid), a.revision, a.kind, a.kind === "connection" ? "pending" : "published",
    recordJson, a.expiresAtMs, input.intentId, input.intentHash, input.deliveryId ?? null, input.contact?.id ?? null, input.contact?.generation ?? null);
    return publication(this.row(input.ownerUid, a.id)!, now);
  }

  withdraw(ownerUid: number, id: string, expectedRevision: number, now = Date.now()): SharedContextPublication {
    const row = this.row(ownerUid, id);
    if (!row || row.revision !== expectedRevision) throw new Error("Shared statement changed; review it again");
    if (row.state !== "withdrawn") {
      this.queueWithdrawals(row);
      this.sql.exec("UPDATE social_context_publications SET state = 'withdrawn', sequence = ?, retired_at = ? WHERE owner_uid = ? AND id = ?", this.advance(ownerUid), now, ownerUid, id);
    }
    return publication(this.row(ownerUid, id)!, now);
  }

  consent(ownerUid: number, consent: SharedContextConsent, contact: FederationContactRecord): void {
    const row = this.row(ownerUid, consent.assertionId);
    if (!row || row.revision !== consent.assertionRevision || row.subject_contact_id !== contact.id || row.subject_generation !== contact.generation) return;
    const record = sharedContextRecordSchema.parse(JSON.parse(row.record_json));
    if (record.consent && (record.consent.decisionRevision > consent.decisionRevision
      || record.consent.decisionRevision === consent.decisionRevision && record.consent.leaseRevision >= consent.leaseRevision)) {
      if (record.consent.decisionRevision === consent.decisionRevision && record.consent.leaseRevision === consent.leaseRevision && JSON.stringify(record.consent) !== JSON.stringify(consent)) throw new Error("Connection consent revision was reused");
      return;
    }
    if (row.state === "withdrawn") return;
    if (consent.decision !== "approve") this.queueWithdrawals(row);
    this.sql.exec("UPDATE social_context_publications SET record_json = ?, state = ?, sequence = ?, retired_at = ? WHERE owner_uid = ? AND id = ?",
      JSON.stringify({ ...record, consent }), consent.decision === "approve" ? "published" : "withdrawn", this.advance(ownerUid),
      consent.decision === "approve" ? null : Date.now(), ownerUid, row.id);
  }

  consentRequest(contactId: string, id: string): SharedContextConsentRequest | null {
    const row = this.sql.exec<ConsentRow>("SELECT * FROM social_context_consents WHERE contact_id = ? AND assertion_id = ?", contactId, id).toArray()[0];
    return row?.record_json ? consentRequest(row) : null;
  }

  consentRequests(ownerUid: number, now = Date.now()): SharedContextConsentRequest[] {
    return this.sql.exec<ConsentRow>(`SELECT r.* FROM social_context_consents r JOIN federation_contacts c ON c.contact_id = r.contact_id
      AND c.owner_uid = r.owner_uid AND c.generation = r.generation AND c.state = 'active'
      WHERE r.owner_uid = ? AND r.expires_at > ? AND r.record_json IS NOT NULL ORDER BY r.expires_at`, ownerUid, now).toArray().map(consentRequest);
  }

  receiveConsentRequest(contact: FederationContactRecord, record: SignedContextAssertion): void {
    const tombstone = this.sql.exec<ConsentRow>("SELECT * FROM social_context_consents WHERE contact_id = ? AND assertion_id = ?", contact.id, record.assertion.id).toArray()[0];
    if (tombstone?.generation === contact.generation && !tombstone.record_json && tombstone.revision >= record.assertion.revision) return;
    const existing = this.consentRequest(contact.id, record.assertion.id);
    if (existing?.generation === contact.generation && existing.record.assertion.revision >= record.assertion.revision) {
      if (existing.record.assertion.revision === record.assertion.revision && JSON.stringify(existing.record) !== JSON.stringify(record)) throw new Error("Connection proposal revision was reused");
      return;
    }
    if (!tombstone) {
      const count = this.sql.exec<{ total: number; owner: number }>("SELECT count(*) AS total, COALESCE(sum(owner_uid = ?), 0) AS owner FROM social_context_consents", contact.ownerUid).one();
      if (count.owner >= 128 || count.total >= 512) throw new Error("Connection consent inbox is full");
    }
    this.sql.exec(`INSERT INTO social_context_consents (owner_uid, contact_id, generation, assertion_id, revision, record_json, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(contact_id, assertion_id) DO UPDATE SET generation = excluded.generation,
      revision = excluded.revision, record_json = excluded.record_json, expires_at = excluded.expires_at, consent_json = NULL, delivery_id = NULL, renewal_after = NULL`,
    contact.ownerUid, contact.id, contact.generation, record.assertion.id, record.assertion.revision, JSON.stringify(record), record.assertion.expiresAtMs);
  }

  cancelConsentRequest(contact: FederationContactRecord, id: string, throughRevision: number): void {
    const row = this.sql.exec<ConsentRow>("SELECT * FROM social_context_consents WHERE contact_id = ? AND assertion_id = ?", contact.id, id).toArray()[0];
    if (row?.generation === contact.generation && row.revision > throughRevision) return;
    if (!row) {
      const count = this.sql.exec<{ total: number; owner: number }>("SELECT count(*) AS total, COALESCE(sum(owner_uid = ?), 0) AS owner FROM social_context_consents", contact.ownerUid).one();
      if (count.owner >= 128 || count.total >= 512) throw new Error("Connection consent inbox is full");
    }
    this.sql.exec(`INSERT INTO social_context_consents (owner_uid, contact_id, generation, assertion_id, revision, record_json, expires_at)
      VALUES (?, ?, ?, ?, ?, NULL, ?) ON CONFLICT(contact_id, assertion_id) DO UPDATE SET generation = excluded.generation,
      revision = excluded.revision, record_json = NULL, consent_json = NULL, delivery_id = NULL, expires_at = excluded.expires_at, renewal_after = NULL`,
    contact.ownerUid, contact.id, contact.generation, id, throughRevision, Date.now() + RETENTION_MS);
  }

  decide(contact: FederationContactRecord, expectedDecision: number, expectedLease: number, consent: SharedContextConsent, deliveryId: string): SharedContextConsentRequest {
    const current = this.consentRequest(contact.id, consent.assertionId);
    if (!current || current.generation !== contact.generation || current.record.assertion.revision !== consent.assertionRevision) throw new Error("Connection proposal changed");
    if (consent.decision === "approve" && consent.leaseUntilMs <= Date.now()) throw new Error("Connection proposal expired before consent was saved");
    if ((current.consent?.decisionRevision ?? 0) !== expectedDecision || (current.consent?.leaseRevision ?? 0) !== expectedLease) throw new Error("Connection consent changed; review it again");
    this.sql.exec("UPDATE social_context_consents SET consent_json = ?, delivery_id = ?, renewal_after = ? WHERE contact_id = ? AND assertion_id = ?", JSON.stringify(consent), deliveryId,
      consent.decision === "approve" && consent.leaseUntilMs < consent.expiresAtMs ? consent.leaseUntilMs - RENEW_BEFORE_MS : null, contact.id, consent.assertionId);
    return this.consentRequest(contact.id, consent.assertionId)!;
  }

  nextRenewal(now = Date.now()): number | null {
    return this.sql.exec<{ due: number | null }>(`SELECT min(r.renewal_after) AS due FROM social_context_consents r JOIN federation_contacts c
      ON c.contact_id = r.contact_id AND c.generation = r.generation AND c.state = 'active'
      WHERE r.renewal_after IS NOT NULL AND r.expires_at > ?`, now).one().due;
  }

  renewals(now = Date.now()): SharedContextConsentRequest[] {
    return this.sql.exec<ConsentRow>(`SELECT r.* FROM social_context_consents r JOIN federation_contacts c
      ON c.contact_id = r.contact_id AND c.generation = r.generation AND c.state = 'active'
      WHERE r.renewal_after <= ? AND r.expires_at > ? ORDER BY r.renewal_after LIMIT 10`, now, now).toArray().map(consentRequest);
  }

  deferRenewal(contactId: string, assertionId: string, until: number): void {
    this.sql.exec("UPDATE social_context_consents SET renewal_after = ? WHERE contact_id = ? AND assertion_id = ? AND renewal_after IS NOT NULL", until, contactId, assertionId);
  }

  sequence(ownerUid: number): number {
    return this.sql.exec<{ sequence: number }>("SELECT sequence FROM social_context_owners WHERE owner_uid = ?", ownerUid).toArray()[0]?.sequence ?? 0;
  }

  page(contact: FederationContactRecord, kinds: SharedContextKind[], after: number, watermark: number, now: number): ContextPublicationRow[] {
    return this.sql.exec<ContextPublicationRow>(`SELECT p.* FROM social_context_publications p WHERE p.owner_uid = ? AND p.sequence > ? AND p.sequence <= ?
      AND ((p.state = 'published' AND p.expires_at > ? AND (p.kind != 'connection' OR json_extract(p.record_json, '$.consent.leaseUntilMs') > ?)
        AND p.kind IN (SELECT value FROM json_each(?)))
        OR EXISTS (SELECT 1 FROM social_context_receipts r WHERE r.owner_uid = p.owner_uid AND r.assertion_id = p.id AND r.contact_id = ? AND r.generation = ? AND r.lease_until > ?))
      ORDER BY p.sequence LIMIT 11`, contact.ownerUid, after, watermark, now, now, JSON.stringify(kinds), contact.id, contact.generation, now).toArray();
  }

  rememberViewer(contact: FederationContactRecord, row: ContextPublicationRow, leaseUntil: number): void {
    const proofUntil = sharedContextRecordSchema.parse(JSON.parse(row.record_json)).consent?.leaseUntilMs ?? Infinity;
    if (!this.sql.exec("SELECT 1 FROM social_context_receipts WHERE owner_uid = ? AND assertion_id = ? AND contact_id = ? AND generation = ?", contact.ownerUid, row.id, contact.id, contact.generation).toArray().length
      && this.sql.exec<{ n: number }>("SELECT count(*) AS n FROM social_context_receipts").one().n >= 16_384) throw new Error("Shared context receipt capacity reached");
    this.sql.exec(`INSERT INTO social_context_receipts (owner_uid, assertion_id, contact_id, generation, revision, lease_until) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(owner_uid, assertion_id, contact_id, generation) DO UPDATE SET revision = excluded.revision,
        lease_until = CASE WHEN consent_proposal = 1 THEN max(lease_until, excluded.lease_until) ELSE excluded.lease_until END`,
    contact.ownerUid, row.id, contact.id, contact.generation, row.revision, Math.min(leaseUntil, row.expires_at, proofUntil));
  }

  renewViewers(contact: FederationContactRecord, kinds: SharedContextKind[], leaseUntil: number): void {
    this.sql.exec(`UPDATE social_context_receipts AS r SET lease_until = min(?, (SELECT min(p.expires_at, COALESCE(json_extract(p.record_json, '$.consent.leaseUntilMs'), p.expires_at)) FROM social_context_publications p WHERE p.owner_uid = r.owner_uid AND p.id = r.assertion_id))
      WHERE r.contact_id = ? AND r.generation = ? AND r.consent_proposal = 0 AND EXISTS (SELECT 1 FROM social_context_publications p
        WHERE p.owner_uid = r.owner_uid AND p.id = r.assertion_id AND p.revision = r.revision AND p.state = 'published'
        AND p.kind IN (SELECT value FROM json_each(?)))`, leaseUntil, contact.id, contact.generation, JSON.stringify(kinds));
  }

  rememberProposal(contact: FederationContactRecord, row: ContextPublicationRow): void {
    this.rememberViewer(contact, row, row.expires_at);
    this.sql.exec("UPDATE social_context_receipts SET consent_proposal = 1 WHERE owner_uid = ? AND assertion_id = ? AND contact_id = ? AND generation = ?", contact.ownerUid, row.id, contact.id, contact.generation);
  }

  withdrawals(now = Date.now()): ContextReceiptRow[] {
    return this.sql.exec<ContextReceiptRow>("SELECT * FROM social_context_receipts WHERE withdraw_through > 0 AND lease_until > ? ORDER BY withdraw_through LIMIT 20", now).toArray();
  }

  sentWithdrawal(row: ContextReceiptRow): void {
    this.sql.exec("UPDATE social_context_receipts SET withdraw_through = 0 WHERE owner_uid = ? AND assertion_id = ? AND contact_id = ? AND generation = ? AND withdraw_through = ?", row.owner_uid, row.assertion_id, row.contact_id, row.generation, row.withdraw_through);
  }

  retireConnections(contactId: string, generation: string, now = Date.now()): void {
    for (const row of this.sql.exec<ContextPublicationRow>("SELECT * FROM social_context_publications WHERE subject_contact_id = ? AND subject_generation = ? AND state != 'withdrawn'", contactId, generation).toArray()) {
      this.withdraw(row.owner_uid, row.id, row.revision, now);
    }
  }

  prune(now = Date.now()): void {
    this.sql.exec("DELETE FROM social_context_receipts WHERE rowid IN (SELECT rowid FROM social_context_receipts WHERE lease_until <= ? LIMIT 100)", now);
    this.sql.exec("DELETE FROM social_context_consents WHERE rowid IN (SELECT rowid FROM social_context_consents WHERE expires_at < ? LIMIT 100)", now - RETENTION_MS);
    this.sql.exec("DELETE FROM social_context_publications WHERE rowid IN (SELECT rowid FROM social_context_publications WHERE COALESCE(retired_at, expires_at) < ? LIMIT 100)", now - RETENTION_MS);
  }

  private advance(ownerUid: number): number {
    return this.sql.exec<{ sequence: number }>(`INSERT INTO social_context_owners (owner_uid, sequence) VALUES (?, 1)
      ON CONFLICT(owner_uid) DO UPDATE SET sequence = sequence + 1 RETURNING sequence`, ownerUid).one().sequence;
  }

  private queueWithdrawals(row: ContextPublicationRow): void {
    this.sql.exec("UPDATE social_context_receipts SET withdraw_through = max(withdraw_through, ?) WHERE owner_uid = ? AND assertion_id = ? AND lease_until > ?", row.revision, row.owner_uid, row.id, Date.now());
  }
}

export function publication(row: ContextPublicationRow, now = Date.now()): SharedContextPublication {
  const record = sharedContextRecordSchema.parse(JSON.parse(row.record_json));
  return { record,
    state: row.state === "withdrawn" ? "withdrawn" : row.expires_at <= now ? "expired" : row.state === "pending" ? "awaiting-consent"
      : record.assertion.kind === "connection" && (!record.consent || record.consent.leaseUntilMs <= now) ? "paused" : "published",
    ...(row.delivery_id ? { deliveryId: row.delivery_id } : undefined) };
}

function consentRequest(row: ConsentRow): SharedContextConsentRequest {
  if (!row.record_json) throw new Error("Cancelled connection proposal has no reviewable record");
  return { contactId: row.contact_id, generation: row.generation, record: signedContextAssertionSchema.parse(JSON.parse(row.record_json)),
    ...(row.consent_json ? { consent: sharedContextConsentSchema.parse(JSON.parse(row.consent_json)) } : undefined),
    ...(row.delivery_id ? { deliveryId: row.delivery_id } : undefined) };
}
