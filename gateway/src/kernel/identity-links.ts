export type IdentityLinkRecord = {
  adapter: string;
  accountId: string;
  actorId: string;
  uid: number;
  generation: number;
  createdAt: number;
  linkedByUid: number;
  metadata: Record<string, unknown> | null;
};

export class IdentityLinkStore {
  constructor(private readonly sql: SqlStorage) {}

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
    const generation = this.advanceGeneration(adapter, accountId, actorId);

    this.sql.exec(
      `INSERT OR REPLACE INTO identity_links
       (adapter, account_id, actor_id, uid, generation, created_at, linked_by_uid, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      adapter,
      accountId,
      actorId,
      uid,
      generation,
      createdAt,
      linkedByUid,
      metadata ? JSON.stringify(metadata) : null,
    );

    return {
      adapter,
      accountId,
      actorId,
      uid,
      generation,
      createdAt,
      linkedByUid,
      metadata: metadata ?? null,
    };
  }

  unlink(adapter: string, accountId: string, actorId: string): boolean {
    const before = this.get(adapter, accountId, actorId);
    if (!before) return false;
    this.advanceGeneration(adapter, accountId, actorId);
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
      `SELECT adapter, account_id, actor_id, uid, generation, created_at, linked_by_uid, metadata_json
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

  listByAccount(adapter: string, accountId: string): IdentityLinkRecord[] {
    return this.sql.exec<RowShape>(
      `SELECT adapter, account_id, actor_id, uid, generation, created_at, linked_by_uid, metadata_json
       FROM identity_links
       WHERE adapter = ? AND account_id = ?
       ORDER BY created_at DESC`,
      adapter,
      accountId,
    ).toArray().map(toRecord);
  }

  list(uid?: number): IdentityLinkRecord[] {
    if (typeof uid === "number") {
      return this.sql.exec<RowShape>(
        `SELECT adapter, account_id, actor_id, uid, generation, created_at, linked_by_uid, metadata_json
         FROM identity_links
         WHERE uid = ?
         ORDER BY created_at DESC`,
        uid,
      ).toArray().map(toRecord);
    }

    return this.sql.exec<RowShape>(
      `SELECT adapter, account_id, actor_id, uid, generation, created_at, linked_by_uid, metadata_json
       FROM identity_links
      ORDER BY created_at DESC`,
    ).toArray().map(toRecord);
  }

  isCurrentGeneration(
    adapter: string,
    accountId: string,
    actorId: string,
    generation: number,
  ): boolean {
    const row = this.sql.exec<{ generation: number }>(
      `SELECT generation
       FROM identity_link_generations
       WHERE adapter = ? AND account_id = ? AND actor_id = ?`,
      adapter,
      accountId,
      actorId,
    ).toArray()[0];
    return Number.isSafeInteger(generation)
      && generation > 0
      && row?.generation === generation;
  }

  private advanceGeneration(adapter: string, accountId: string, actorId: string): number {
    const current = this.sql.exec<{ generation: number }>(
      `SELECT generation
       FROM identity_link_generations
       WHERE adapter = ? AND account_id = ? AND actor_id = ?`,
      adapter,
      accountId,
      actorId,
    ).toArray()[0]?.generation ?? 0;
    if (!Number.isSafeInteger(current) || current < 0 || current >= Number.MAX_SAFE_INTEGER) {
      throw new Error("Identity link generation is invalid");
    }
    const generation = current + 1;
    this.sql.exec(
      `INSERT INTO identity_link_generations (adapter, account_id, actor_id, generation)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (adapter, account_id, actor_id)
       DO UPDATE SET generation = excluded.generation`,
      adapter,
      accountId,
      actorId,
      generation,
    );
    return generation;
  }
}

type RowShape = {
  adapter: string;
  account_id: string;
  actor_id: string;
  uid: number;
  generation: number;
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
    generation: row.generation,
    createdAt: row.created_at,
    linkedByUid: row.linked_by_uid,
    metadata: row.metadata_json
      ? (JSON.parse(row.metadata_json) as Record<string, unknown>)
      : null,
  };
}
