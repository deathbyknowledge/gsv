import { z } from "zod/mini";
import {
  sharedContextKindsSchema, sharedContextRecordSchema,
  type ContactContextListArgs, type ContactContextListResult, type ContextSyncResponse,
  type SharedContextSource, type SharedContextKind, type SharedContextEntry,
} from "@humansandmachines/gsv/protocol";
import type { FederationContactRecord } from "./federation-store";

export type ContextSourceRow = {
  contact_id: string; owner_uid: number; generation: string; revision: number; kinds_json: string;
  sync_epoch: number; projection_id: string | null; run_id: string | null; cursor: string | null;
  next_cursor: string | null; state: SharedContextSource["state"]; next_due: number; updated_at: number | null; run_started: number | null;
};
type CacheRow = { contact_id: string; assertion_id: string; record_json: string; lease_until: number; received_at: number };
const ACTIVE_SOURCE = "c.contact_id = s.contact_id AND c.owner_uid = s.owner_uid AND c.generation = s.generation AND c.state = 'active'";
const listCursorSchema = z.strictObject({ source: z.string(), id: z.string(), subjectShip: z.string(), subjectId: z.string(), filterSource: z.string() });
const HOUR_MS = 60 * 60_000;

export class ContextSources {
  constructor(private readonly storage: DurableObjectStorage) {}
  private get sql(): SqlStorage { return this.storage.sql; }

  row(contactId: string): ContextSourceRow | null {
    return this.sql.exec<ContextSourceRow>("SELECT * FROM social_context_sources WHERE contact_id = ?", contactId).toArray()[0] ?? null;
  }

  list(ownerUid: number): SharedContextSource[] {
    return this.sql.exec<ContextSourceRow>(`SELECT s.* FROM social_context_sources s JOIN federation_contacts c ON ${ACTIVE_SOURCE}
      WHERE s.owner_uid = ? ORDER BY s.contact_id`, ownerUid).toArray().map(source);
  }

  subscribe(contact: FederationContactRecord, expectedRevision: number, kinds: SharedContextKind[]): SharedContextSource | null {
    return this.storage.transactionSync(() => {
      const previous = this.row(contact.id);
      if ((previous?.generation === contact.generation ? previous.revision : 0) !== expectedRevision) throw new Error("Context subscription changed; review it again");
      if (kinds.length === 0) {
        this.sql.exec("DELETE FROM social_context_sources WHERE contact_id = ?", contact.id);
        this.sql.exec("DELETE FROM social_context_cache WHERE contact_id = ?", contact.id);
        return null;
      }
      if (!previous) {
        const count = this.sql.exec<{ total: number; owner: number }>("SELECT count(*) AS total, COALESCE(sum(owner_uid = ?), 0) AS owner FROM social_context_sources", contact.ownerUid).one();
        if (count.owner >= 32 || count.total >= 64) throw new Error("Shared context source capacity reached");
      }
      this.sql.exec("DELETE FROM social_context_cache WHERE contact_id = ?", contact.id);
      this.sql.exec(`INSERT INTO social_context_sources (contact_id, owner_uid, generation, revision, kinds_json, state, next_due)
        VALUES (?, ?, ?, ?, ?, 'queued', ?) ON CONFLICT(contact_id) DO UPDATE SET generation = excluded.generation,
        revision = excluded.revision, kinds_json = excluded.kinds_json, sync_epoch = sync_epoch + 1, projection_id = NULL,
        run_id = NULL, cursor = NULL, next_cursor = NULL, state = 'queued', next_due = excluded.next_due, updated_at = NULL, run_started = NULL`,
      contact.id, contact.ownerUid, contact.generation, expectedRevision + 1, JSON.stringify(kinds.slice().sort()), Date.now());
      return source(this.row(contact.id)!);
    });
  }

  schedule(contactId: string, expectedRevision: number, now = Date.now()): void {
    if (!this.sql.exec("UPDATE social_context_sources SET next_due = ?, state = CASE WHEN run_id IS NULL THEN 'queued' ELSE 'syncing' END WHERE contact_id = ? AND revision = ? RETURNING contact_id", now, contactId, expectedRevision).toArray().length) throw new Error("Context subscription changed");
  }

  nextDue(): number | null {
    return this.sql.exec<{ due: number | null }>(`SELECT min(s.next_due) AS due FROM social_context_sources s JOIN federation_contacts c ON ${ACTIVE_SOURCE}`).one().due;
  }

  due(now = Date.now()): ContextSourceRow | null {
    return this.sql.exec<ContextSourceRow>(`SELECT s.* FROM social_context_sources s JOIN federation_contacts c ON ${ACTIVE_SOURCE}
      WHERE s.next_due <= ? ORDER BY s.next_due, s.contact_id LIMIT 1`, now).toArray()[0] ?? null;
  }

  begin(row: ContextSourceRow, now = Date.now()): ContextSourceRow | null {
    return this.storage.transactionSync(() => {
      if (!this.current(row)) return null;
      if (row.run_id) return row;
      const runId = crypto.randomUUID();
      if (row.cursor && row.projection_id) this.sql.exec(`INSERT INTO social_context_cache
        SELECT contact_id, ?, assertion_id, owner_uid, subject_ship, subject_id, kind, revision, lease_until, received_at, record_json
        FROM social_context_cache WHERE contact_id = ? AND projection_id = ?`, runId, row.contact_id, row.projection_id);
      this.assertCapacity(row.contact_id, runId);
      this.sql.exec("UPDATE social_context_sources SET run_id = ?, next_cursor = cursor, state = 'syncing', run_started = ? WHERE contact_id = ?", runId, now, row.contact_id);
      return this.row(row.contact_id)!;
    });
  }

  apply(row: ContextSourceRow, page: ContextSyncResponse, now = Date.now()): boolean {
    return this.storage.transactionSync(() => {
      if (!row.run_id || !this.current(row)) return false;
      if (page.mode !== (row.cursor ? "delta" : "snapshot")) throw new Error("Source changed the shared context sync mode");
      const kinds = sharedContextKindsSchema.parse(JSON.parse(row.kinds_json));
      for (const change of page.changes) {
        this.sql.exec("DELETE FROM social_context_cache WHERE contact_id = ? AND projection_id = ? AND assertion_id = ?", row.contact_id, row.run_id, change.id);
        if (!change.record) continue;
        const a = change.record.assertion;
        if (a.id !== change.id || !kinds.includes(a.kind)) throw new Error("Source returned unrequested context");
        this.sql.exec(`INSERT INTO social_context_cache (contact_id, projection_id, assertion_id, owner_uid, subject_ship, subject_id, kind, revision, lease_until, received_at, record_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, row.contact_id, row.run_id, a.id, row.owner_uid, a.subject.shipId, a.subject.subjectId,
        a.kind, a.revision, Math.min(page.leaseUntilMs, a.expiresAtMs, change.record.consent?.leaseUntilMs ?? Infinity), now, JSON.stringify(change.record));
      }
      this.assertCapacity(row.contact_id, row.run_id);
      if (page.more) {
        this.sql.exec("UPDATE social_context_sources SET next_cursor = ?, next_due = ? WHERE contact_id = ?", page.cursor, now + 1000, row.contact_id);
      } else {
        this.sql.exec("DELETE FROM social_context_cache WHERE contact_id = ? AND projection_id != ?", row.contact_id, row.run_id);
        this.sql.exec("UPDATE social_context_cache SET lease_until = min(?, json_extract(record_json, '$.assertion.expiresAtMs'), COALESCE(json_extract(record_json, '$.consent.leaseUntilMs'), json_extract(record_json, '$.assertion.expiresAtMs'))), received_at = ? WHERE contact_id = ? AND projection_id = ?", page.leaseUntilMs, now, row.contact_id, row.run_id);
        this.sql.exec(`UPDATE social_context_sources SET projection_id = run_id, run_id = NULL, cursor = ?, next_cursor = NULL,
          state = 'current', updated_at = ?, next_due = ?, run_started = NULL WHERE contact_id = ?`, page.cursor, now, now + HOUR_MS, row.contact_id);
      }
      return true;
    });
  }

  fail(row: ContextSourceRow, resetCursor: boolean, now = Date.now()): void {
    this.storage.transactionSync(() => {
      if (!this.current(row)) return;
      if (row.run_id) this.sql.exec("DELETE FROM social_context_cache WHERE contact_id = ? AND projection_id = ?", row.contact_id, row.run_id);
      this.sql.exec(`UPDATE social_context_sources SET state = 'unavailable', sync_epoch = sync_epoch + 1, run_id = NULL,
        next_cursor = NULL, cursor = CASE WHEN ? THEN NULL ELSE cursor END, next_due = ?, run_started = NULL WHERE contact_id = ?`, resetCursor ? 1 : 0, now + HOUR_MS, row.contact_id);
    });
  }

  receiveWithdrawal(contact: FederationContactRecord, id: string, throughRevision: number): void {
    this.storage.transactionSync(() => {
      const row = this.row(contact.id);
      if (!row || row.generation !== contact.generation) return;
      this.sql.exec("DELETE FROM social_context_cache WHERE contact_id = ? AND assertion_id = ? AND revision <= ?", contact.id, id, throughRevision);
      if (row.run_id) this.sql.exec("DELETE FROM social_context_cache WHERE contact_id = ? AND projection_id = ?", contact.id, row.run_id);
      this.sql.exec(`UPDATE social_context_sources SET sync_epoch = sync_epoch + 1, run_id = NULL, cursor = NULL,
        next_cursor = NULL, state = 'queued', next_due = ?, run_started = NULL WHERE contact_id = ?`, Date.now(), contact.id);
    });
  }

  entries(ownerUid: number, args: ContactContextListArgs, now = Date.now()): ContactContextListResult {
    const subjectShip = args.subject?.shipId ?? "";
    const subjectId = args.subject?.subjectId ?? "";
    const filterSource = args.sourceContactId ?? "";
    const after = args.cursor ? listCursorSchema.parse(JSON.parse(args.cursor)) : null;
    if (after && (after.subjectShip !== subjectShip || after.subjectId !== subjectId || after.filterSource !== filterSource)) throw new Error("Shared context cursor belongs to another view");
    const limit = args.limit ?? 30;
    const rows = this.sql.exec<CacheRow>(`SELECT r.* FROM social_context_cache r JOIN social_context_sources s ON s.contact_id = r.contact_id AND s.owner_uid = r.owner_uid AND s.projection_id = r.projection_id
      JOIN federation_contacts c ON ${ACTIVE_SOURCE}
      WHERE r.owner_uid = ? AND r.lease_until > ? AND (? = '' OR (r.subject_ship = ? AND r.subject_id = ?))
      AND (? = '' OR r.contact_id = ?) AND (r.contact_id > ? OR (r.contact_id = ? AND r.assertion_id > ?))
      ORDER BY r.contact_id, r.assertion_id LIMIT ?`, ownerUid, now, subjectShip, subjectShip, subjectId, filterSource, filterSource,
    after?.source ?? "", after?.source ?? "", after?.id ?? "", limit + 1).toArray();
    const selected = rows.slice(0, limit);
    const last = selected.at(-1);
    const entries: SharedContextEntry[] = selected.map((row) => ({ sourceContactId: row.contact_id,
      record: sharedContextRecordSchema.parse(JSON.parse(row.record_json)), leaseUntilMs: row.lease_until, receivedAtMs: row.received_at }));
    return { entries, ...(rows.length > limit && last ? { next: JSON.stringify({ source: last.contact_id, id: last.assertion_id, subjectShip, subjectId, filterSource }) } : undefined) };
  }

  retireContact(contactId: string): void {
    this.sql.exec("DELETE FROM social_context_cache WHERE contact_id = ?", contactId);
    this.sql.exec("DELETE FROM social_context_sources WHERE contact_id = ?", contactId);
  }

  private current(row: ContextSourceRow): boolean {
    const current = this.row(row.contact_id);
    return !!current && current.generation === row.generation && current.revision === row.revision && current.sync_epoch === row.sync_epoch
      && current.run_id === row.run_id && current.next_cursor === row.next_cursor;
  }

  private assertCapacity(contactId: string, projection: string): void {
    const count = this.sql.exec<{ total: number; bytes: number; source: number }>(`SELECT count(*) AS total, COALESCE(sum(length(CAST(record_json AS BLOB))), 0) AS bytes,
      COALESCE(sum(contact_id = ? AND projection_id = ?), 0) AS source FROM social_context_cache`, contactId, projection).one();
    if (count.total > 4096 || count.bytes > 16 * 1024 * 1024 || count.source > 128) throw new Error("Shared context cache capacity reached");
  }
}

function source(row: ContextSourceRow): SharedContextSource {
  return { contactId: row.contact_id, generation: row.generation, revision: row.revision,
    kinds: sharedContextKindsSchema.parse(JSON.parse(row.kinds_json)), state: row.state, nextSyncAtMs: row.next_due,
    ...(row.updated_at !== null ? { updatedAtMs: row.updated_at } : undefined) };
}
