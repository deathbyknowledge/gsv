/** An account a host moderates: com.atproto.admin.defs#repoRef. */
export type RepoRef = { $type: "com.atproto.admin.defs#repoRef"; did: string };

/** A record version: com.atproto.repo.strongRef. */
export type StrongRef = { $type: "com.atproto.repo.strongRef"; uri: string; cid: string };

/** One of an account's blobs: com.atproto.admin.defs#repoBlobRef. */
export type RepoBlobRef = { $type: "com.atproto.admin.defs#repoBlobRef"; did: string; cid: string; recordUri?: string };

/** What com.atproto.admin.updateSubjectStatus names. */
export type ModerationSubject = RepoRef | StrongRef | RepoBlobRef;

/** com.atproto.admin.defs#statusAttr. */
export type StatusAttr = { applied: boolean; ref?: string };

/** com.atproto.admin.updateSubjectStatus's input, with the reason the host gives the account's person. */
export type SubjectStatusUpdate = { subject: ModerationSubject; takedown: StatusAttr; reason?: string };

/** com.atproto.admin.getSubjectStatus's output, which updateSubjectStatus answers too. */
export type SubjectStatus = { subject: ModerationSubject; takedown: StatusAttr };

/** com.atproto.admin.getSubjectStatus's parameters. */
export type SubjectStatusQuery = { did?: string; uri?: string; blob?: string };

/** A subject the host has taken down, and the reason it gives the account's person. */
export type Takedown = { subject: ModerationSubject; ref: string; reason: string | null; at: number };

export const REPO_REF = "com.atproto.admin.defs#repoRef";
export const STRONG_REF = "com.atproto.repo.strongRef";
export const REPO_BLOB_REF = "com.atproto.admin.defs#repoBlobRef";

/** The table's checks keep a CID on every record row, and a record URI only on blob rows. */
type TakedownRow = { subject: string; ref: string; reason: string | null; applied_at: number } & (
  | { kind: "account"; cid: null; record_uri: null }
  | { kind: "record"; cid: string; record_uri: null }
  | { kind: "blob"; cid: null; record_uri: string | null }
);

/**
 * What a host has taken down of one account's repository, keyed by the
 * account's DID, a record's AT URI or a blob's CID. A takedown stays with its
 * subject until the host restores it, so a record its owner edits, deletes or
 * writes again stays hidden, and so do the same bytes uploaded again.
 */
export class Takedowns {
  constructor(
    private readonly sql: SqlStorage,
    private readonly did: string,
  ) {}

  has(key: string): boolean {
    return this.sql.exec("SELECT 1 FROM takedowns WHERE subject = ?", key).toArray().length > 0;
  }

  get(key: string): Takedown | null {
    const row = this.sql.exec<TakedownRow>("SELECT * FROM takedowns WHERE subject = ?", key).toArray()[0];
    return row ? this.takedown(row) : null;
  }

  /** Every takedown, oldest first. */
  list(): Takedown[] {
    return this.sql.exec<TakedownRow>("SELECT * FROM takedowns ORDER BY applied_at, subject").toArray().map((row) => this.takedown(row));
  }

  /** The taken-down records whose AT URIs begin with a collection's prefix. */
  records(prefix: string): Set<string> {
    return new Set(this.sql.exec<{ subject: string }>(
      "SELECT subject FROM takedowns WHERE kind = 'record' AND substr(subject, 1, ?) = ?",
      prefix.length,
      prefix,
    ).toArray().map((row) => row.subject));
  }

  /** Takes a subject down, or replaces the reference and reason of its takedown. */
  apply(subject: ModerationSubject, ref: string, reason: string | null, at: number): void {
    const [kind, cid, recordUri] = subject.$type === REPO_REF
      ? ["account", null, null]
      : subject.$type === STRONG_REF ? ["record", subject.cid, null] : ["blob", null, subject.recordUri ?? null];
    this.sql.exec(
      `INSERT INTO takedowns (subject, kind, cid, record_uri, ref, reason, applied_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (subject) DO UPDATE SET cid = excluded.cid, record_uri = excluded.record_uri, ref = excluded.ref,
         reason = excluded.reason, applied_at = excluded.applied_at`,
      subjectKey(subject),
      kind,
      cid,
      recordUri,
      ref,
      reason,
      at,
    );
  }

  restore(key: string): void {
    this.sql.exec("DELETE FROM takedowns WHERE subject = ?", key);
  }

  private takedown(row: TakedownRow): Takedown {
    const taken = { ref: row.ref, reason: row.reason, at: row.applied_at };
    switch (row.kind) {
      case "account": return { subject: { $type: REPO_REF, did: row.subject }, ...taken };
      case "record": return { subject: { $type: STRONG_REF, uri: row.subject, cid: row.cid }, ...taken };
      case "blob": {
        const subject: RepoBlobRef = { $type: REPO_BLOB_REF, did: this.did, cid: row.subject };
        if (row.record_uri !== null) subject.recordUri = row.record_uri;
        return { subject, ...taken };
      }
    }
  }
}

/** The key a takedown keeps its subject by. */
export function subjectKey(subject: ModerationSubject): string {
  switch (subject.$type) {
    case REPO_REF: return subject.did;
    case STRONG_REF: return subject.uri;
    case REPO_BLOB_REF: return subject.cid;
  }
}
