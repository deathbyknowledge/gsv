import { contactDraftCreateSchema, type ContactDraft, type ContactDraftCreateArgs, type ContactDraftListResult, type ContactSendResult } from "@humansandmachines/gsv/protocol";

type DraftRow = {
  id: string; owner_uid: number; contact_id: string; intent_id: string; fingerprint: string; process_id: string;
  revision: number; state: ContactDraft["state"]; content_json: string; result_json: string | null;
  created_at: number; expires_at: number;
};
const RETENTION = 7 * 86_400_000;

/** All writes run inside the owning FederationStore transaction. */
export class ContactDraftStore {
  constructor(private readonly sql: SqlStorage) {}

  get(ownerUid: number, id: string, now = Date.now()): ContactDraft | null {
    const row = this.sql.exec<DraftRow>("SELECT * FROM social_drafts WHERE id = ? AND owner_uid = ?", id, ownerUid).toArray()[0];
    return row ? fromRow(row, now) : null;
  }

  replay(ownerUid: number, intent: string, fingerprint: string): ContactDraft | null {
    const row = this.sql.exec<DraftRow>("SELECT * FROM social_drafts WHERE owner_uid = ? AND intent_id = ?", ownerUid, intent).toArray()[0];
    if (!row) return null;
    if (row.fingerprint !== fingerprint) throw new Error("This draft identity already names different content; review a new draft");
    return fromRow(row, Date.now());
  }

  create(ownerUid: number, processId: string, content: ContactDraftCreateArgs, fingerprint: string, now = Date.now()): ContactDraft {
    const replay = this.replay(ownerUid, content.idempotencyKey, fingerprint);
    if (replay) return replay;
    const serialized = JSON.stringify(content);
    if (new TextEncoder().encode(serialized).byteLength > 65_536) throw new Error("Draft is too large; use fewer attachments or less text");
    this.sql.exec("DELETE FROM social_drafts WHERE expires_at < ?", now - 86_400_000);
    const capacity = this.sql.exec<{ owned: number; total: number; bytes: number }>(
      "SELECT sum(CASE WHEN owner_uid = ? THEN 1 ELSE 0 END) AS owned, count(*) AS total, coalesce(sum(length(CAST(content_json AS BLOB))), 0) AS bytes FROM social_drafts", ownerUid,
    ).one();
    if (capacity.owned >= 128 || capacity.total >= 2048 || capacity.bytes + new TextEncoder().encode(serialized).byteLength > 16 * 1024 * 1024) {
      throw new Error("Draft retention is full; older drafts expire after seven days");
    }
    const id = `draft:${crypto.randomUUID()}`;
    this.sql.exec("INSERT INTO social_drafts (id, owner_uid, contact_id, intent_id, fingerprint, process_id, content_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      id, ownerUid, content.contactId, content.idempotencyKey, fingerprint, processId, serialized, now, now + RETENTION);
    return this.get(ownerUid, id, now)!;
  }

  list(ownerUid: number, contactId: string, after: string, limit: number, now = Date.now()): ContactDraftListResult {
    const rows = this.sql.exec<DraftRow>("SELECT * FROM social_drafts WHERE owner_uid = ? AND contact_id = ? AND id > ? AND expires_at > ? ORDER BY id LIMIT ?",
      ownerUid, contactId, after, now, limit + 1).toArray();
    return { drafts: rows.slice(0, limit).map((row) => fromRow(row, now)), next: rows.length > limit ? rows[limit - 1].id : undefined };
  }

  decide(ownerUid: number, id: string, revision: number, action: "approve" | "discard", now = Date.now()): ContactDraft {
    const draft = this.get(ownerUid, id, now);
    if (!draft) throw new Error("Draft not found");
    if (action === "approve" && (draft.state === "sending" || draft.state === "sent") && revision === draft.revision - 1) return draft;
    if (action === "discard" && draft.state === "discarded" && revision === draft.revision - 1) return draft;
    if (draft.revision !== revision || draft.state !== "review") throw new Error("This draft changed or expired; reload it before deciding");
    this.sql.exec("UPDATE social_drafts SET state = ?, revision = revision + 1 WHERE id = ? AND revision = ?", action === "approve" ? "sending" : "discarded", id, revision);
    return this.get(ownerUid, id, now)!;
  }

  assertSending(ownerUid: number, id: string, now = Date.now()): ContactDraft {
    const draft = this.get(ownerUid, id, now);
    if (!draft || draft.state !== "sending" || draft.expiresAtMs <= now) throw new Error("This draft can no longer be submitted");
    return draft;
  }

  sent(ownerUid: number, id: string, result: ContactSendResult): ContactDraft {
    const draft = this.get(ownerUid, id);
    if (!draft || (draft.state !== "sending" && draft.state !== "sent")) throw new Error("Draft submission changed");
    this.sql.exec("UPDATE social_drafts SET state = 'sent', result_json = ? WHERE id = ? AND owner_uid = ?", JSON.stringify(result), id, ownerUid);
    return this.get(ownerUid, id)!;
  }
}

function fromRow(row: DraftRow, now: number): ContactDraft {
  // SAFETY: only sent() stores this typed local syscall result; remote input never writes result_json.
  const result = row.result_json ? JSON.parse(row.result_json) as ContactSendResult : undefined;
  return { id: row.id, ownerUid: row.owner_uid, processId: row.process_id, revision: row.revision,
    state: row.state === "review" && row.expires_at <= now ? "expired" : row.state,
    content: contactDraftCreateSchema.parse(JSON.parse(row.content_json)), result,
    createdAtMs: row.created_at, expiresAtMs: row.expires_at };
}
