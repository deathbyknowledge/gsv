export type IdentityLinkRecord = {
  adapter: string;
  accountId: string;
  actorId: string;
  uid: number;
  createdAt: number;
  linkedByUid: number;
  metadata: Record<string, unknown> | null;
};

export class IdentityLinkStore {
  constructor(private readonly sql: SqlStorage) {}

  init(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS identity_links (
        adapter       TEXT NOT NULL,
        account_id    TEXT NOT NULL,
        actor_id      TEXT NOT NULL,
        uid           INTEGER NOT NULL,
        created_at    INTEGER NOT NULL,
        linked_by_uid INTEGER NOT NULL,
        metadata_json TEXT,
        PRIMARY KEY (adapter, account_id, actor_id)
      )
    `);

    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_identity_links_uid
      ON identity_links(uid)
    `);
  }

  link(
    adapter: string,
    accountId: string,
    actorId: string,
    uid: number,
    linkedByUid: number,
    metadata?: Record<string, unknown>,
  ): IdentityLinkRecord {
    const now = Date.now();
    const existing = this.get(adapter, accountId, actorId);
    const createdAt = existing?.createdAt ?? now;

    this.sql.exec(
      `INSERT OR REPLACE INTO identity_links
       (adapter, account_id, actor_id, uid, created_at, linked_by_uid, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      adapter,
      accountId,
      actorId,
      uid,
      createdAt,
      linkedByUid,
      metadata ? JSON.stringify(metadata) : null,
    );

    return {
      adapter,
      accountId,
      actorId,
      uid,
      createdAt,
      linkedByUid,
      metadata: metadata ?? null,
    };
  }

  unlink(adapter: string, accountId: string, actorId: string): boolean {
    const before = this.get(adapter, accountId, actorId);
    if (!before) return false;
    this.sql.exec(
      `DELETE FROM identity_links WHERE adapter = ? AND account_id = ? AND actor_id = ?`,
      adapter,
      accountId,
      actorId,
    );
    return true;
  }

  resolveUid(adapter: string, accountId: string, actorId: string): number | null {
    const rows = this.sql.exec<{ uid: number }>(
      `SELECT uid FROM identity_links
       WHERE adapter = ? AND account_id = ? AND actor_id = ?
       LIMIT 1`,
      adapter,
      accountId,
      actorId,
    ).toArray();
    return rows[0]?.uid ?? null;
  }

  get(adapter: string, accountId: string, actorId: string): IdentityLinkRecord | null {
    const rows = this.sql.exec<RowShape>(
      `SELECT adapter, account_id, actor_id, uid, created_at, linked_by_uid, metadata_json
       FROM identity_links
       WHERE adapter = ? AND account_id = ? AND actor_id = ?
       LIMIT 1`,
      adapter,
      accountId,
      actorId,
    ).toArray();
    if (rows.length === 0) return null;
    return toRecord(rows[0]);
  }

  list(uid?: number): IdentityLinkRecord[] {
    if (typeof uid === "number") {
      return this.sql.exec<RowShape>(
        `SELECT adapter, account_id, actor_id, uid, created_at, linked_by_uid, metadata_json
         FROM identity_links
         WHERE uid = ?
         ORDER BY created_at DESC`,
        uid,
      ).toArray().map(toRecord);
    }

    return this.sql.exec<RowShape>(
      `SELECT adapter, account_id, actor_id, uid, created_at, linked_by_uid, metadata_json
       FROM identity_links
       ORDER BY created_at DESC`,
    ).toArray().map(toRecord);
  }
}

type RowShape = {
  adapter: string;
  account_id: string;
  actor_id: string;
  uid: number;
  created_at: number;
  linked_by_uid: number;
  metadata_json: string | null;
};

function toRecord(row: RowShape): IdentityLinkRecord {
  return {
    adapter: row.adapter,
    accountId: row.account_id,
    actorId: row.actor_id,
    uid: row.uid,
    createdAt: row.created_at,
    linkedByUid: row.linked_by_uid,
    metadata: row.metadata_json
      ? (JSON.parse(row.metadata_json) as Record<string, unknown>)
      : null,
  };
}
