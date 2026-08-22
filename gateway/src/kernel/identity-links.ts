import type { AdapterSurface } from "../adapter-interface";
import { z } from "zod";
const metadataSchema = z.record(z.string(), z.unknown());
type IdentityLinkMetadata = z.output<typeof metadataSchema>;
const surfaceMetadataSchema = z.object({
  surfaceKind: z.string().optional(),
  surfaceId: z.string().optional(),
}).passthrough();

export type IdentityLinkRecord = {
  adapter: string;
  accountId: string;
  actorId: string;
  uid: number;
  createdAt: number;
  linkedByUid: number;
  metadata: IdentityLinkMetadata | null;
};

export class IdentityLinkStore {
  constructor(private readonly sql: SqlStorage) {}

  link(
    adapter: string,
    accountId: string,
    actorId: string,
    uid: number,
    linkedByUid: number,
    metadata?: IdentityLinkMetadata,
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

  bindSurfaceIfMissing(
    adapter: string,
    accountId: string,
    actorId: string,
    surface: AdapterSurface,
  ): IdentityLinkRecord | null {
    const existing = this.get(adapter, accountId, actorId);
    if (!existing) return null;
    const metadata = existing.metadata ?? {};
    const surfaceMetadata = surfaceMetadataSchema.parse(metadata);
    if (surfaceMetadata.surfaceKind !== undefined || surfaceMetadata.surfaceId !== undefined) {
      return existing;
    }
    const nextMetadata: IdentityLinkMetadata = {
      ...metadata,
      surfaceKind: surface.kind,
      surfaceId: surface.id,
    };
    if (surface.threadId) nextMetadata.threadId = surface.threadId;
    this.sql.exec(
      `UPDATE identity_links
          SET metadata_json = ?
        WHERE adapter = ? AND account_id = ? AND actor_id = ?`,
      JSON.stringify(nextMetadata),
      adapter,
      accountId,
      actorId,
    );
    return { ...existing, metadata: nextMetadata };
  }

  get(adapter: string, accountId: string, actorId: string): IdentityLinkRecord | null {
    const rows = this.sql.exec<IdentityLinkRow>(
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

  listByAccount(adapter: string, accountId: string): IdentityLinkRecord[] {
    return this.sql.exec<IdentityLinkRow>(
      `SELECT adapter, account_id, actor_id, uid, created_at, linked_by_uid, metadata_json
       FROM identity_links
       WHERE adapter = ? AND account_id = ?
       ORDER BY created_at DESC`,
      adapter,
      accountId,
    ).toArray().map(toRecord);
  }

  list(uid?: number): IdentityLinkRecord[] {
    if (uid !== undefined) {
      return this.sql.exec<IdentityLinkRow>(
        `SELECT adapter, account_id, actor_id, uid, created_at, linked_by_uid, metadata_json
         FROM identity_links
         WHERE uid = ?
         ORDER BY created_at DESC`,
        uid,
      ).toArray().map(toRecord);
    }

    return this.sql.exec<IdentityLinkRow>(
      `SELECT adapter, account_id, actor_id, uid, created_at, linked_by_uid, metadata_json
       FROM identity_links
       ORDER BY created_at DESC`,
    ).toArray().map(toRecord);
  }
}

type IdentityLinkRow = {
  adapter: string;
  account_id: string;
  actor_id: string;
  uid: number;
  created_at: number;
  linked_by_uid: number;
  metadata_json: string | null;
};

function toRecord(row: IdentityLinkRow): IdentityLinkRecord {
  return {
    adapter: row.adapter,
    accountId: row.account_id,
    actorId: row.actor_id,
    uid: row.uid,
    createdAt: row.created_at,
    linkedByUid: row.linked_by_uid,
    metadata: row.metadata_json ? parseMetadata(row.metadata_json) : null,
  };
}

function parseMetadata(value: string): IdentityLinkMetadata {
  try {
    const parsed = metadataSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}
