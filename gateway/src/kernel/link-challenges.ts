import type { AdapterSurfaceKind } from "../adapter-interface";

export type LinkChallengeRecord = {
  code: string;
  adapter: string;
  accountId: string;
  actorId: string;
  surfaceKind: AdapterSurfaceKind;
  surfaceId: string;
  createdAt: number;
  expiresAt: number;
  usedAt: number | null;
  usedByUid: number | null;
};

const DEFAULT_TTL_MS = 10 * 60 * 1000;

export class LinkChallengeStore {
  constructor(private readonly sql: SqlStorage) {}

  init(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS link_challenges (
        code         TEXT PRIMARY KEY,
        adapter      TEXT NOT NULL,
        account_id   TEXT NOT NULL,
        actor_id     TEXT NOT NULL,
        surface_kind TEXT NOT NULL,
        surface_id   TEXT NOT NULL,
        created_at   INTEGER NOT NULL,
        expires_at   INTEGER NOT NULL,
        used_at      INTEGER,
        used_by_uid  INTEGER
      )
    `);

    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_link_challenges_lookup
      ON link_challenges(adapter, account_id, actor_id)
    `);

    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_link_challenges_expires
      ON link_challenges(expires_at)
    `);
  }

  issue(input: {
    adapter: string;
    accountId: string;
    actorId: string;
    surfaceKind: AdapterSurfaceKind;
    surfaceId: string;
    ttlMs?: number;
  }): LinkChallengeRecord {
    this.pruneExpired();

    const existing = this.findActive(input.adapter, input.accountId, input.actorId);
    if (existing) {
      return existing;
    }

    const now = Date.now();
    const expiresAt = now + (input.ttlMs ?? DEFAULT_TTL_MS);
    const code = this.generateCode();

    this.sql.exec(
      `INSERT INTO link_challenges
       (code, adapter, account_id, actor_id, surface_kind, surface_id, created_at, expires_at, used_at, used_by_uid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
      code,
      input.adapter,
      input.accountId,
      input.actorId,
      input.surfaceKind,
      input.surfaceId,
      now,
      expiresAt,
    );

    return {
      code,
      adapter: input.adapter,
      accountId: input.accountId,
      actorId: input.actorId,
      surfaceKind: input.surfaceKind,
      surfaceId: input.surfaceId,
      createdAt: now,
      expiresAt,
      usedAt: null,
      usedByUid: null,
    };
  }

  consume(code: string, uid: number): LinkChallengeRecord | null {
    this.pruneExpired();

    const row = this.sql.exec<RowShape>(
      `SELECT code, adapter, account_id, actor_id, surface_kind, surface_id,
              created_at, expires_at, used_at, used_by_uid
       FROM link_challenges
       WHERE code = ?
       LIMIT 1`,
      code,
    ).toArray()[0];

    if (!row) return null;
    if (row.used_at !== null) return null;
    if (row.expires_at <= Date.now()) {
      this.sql.exec("DELETE FROM link_challenges WHERE code = ?", code);
      return null;
    }

    const usedAt = Date.now();
    this.sql.exec(
      `UPDATE link_challenges SET used_at = ?, used_by_uid = ? WHERE code = ?`,
      usedAt,
      uid,
      code,
    );

    return {
      code: row.code,
      adapter: row.adapter,
      accountId: row.account_id,
      actorId: row.actor_id,
      surfaceKind: row.surface_kind as AdapterSurfaceKind,
      surfaceId: row.surface_id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      usedAt,
      usedByUid: uid,
    };
  }

  pruneExpired(now = Date.now()): number {
    const rows = this.sql.exec<{ cnt: number }>(
      "SELECT COUNT(*) as cnt FROM link_challenges WHERE expires_at <= ? OR (used_at IS NOT NULL AND used_at <= ?)",
      now,
      now - (24 * 60 * 60 * 1000),
    ).toArray();
    const count = rows[0]?.cnt ?? 0;
    if (count > 0) {
      this.sql.exec(
        "DELETE FROM link_challenges WHERE expires_at <= ? OR (used_at IS NOT NULL AND used_at <= ?)",
        now,
        now - (24 * 60 * 60 * 1000),
      );
    }
    return count;
  }

  private findActive(adapter: string, accountId: string, actorId: string): LinkChallengeRecord | null {
    const row = this.sql.exec<RowShape>(
      `SELECT code, adapter, account_id, actor_id, surface_kind, surface_id,
              created_at, expires_at, used_at, used_by_uid
       FROM link_challenges
       WHERE adapter = ? AND account_id = ? AND actor_id = ? AND used_at IS NULL AND expires_at > ?
       ORDER BY created_at DESC
       LIMIT 1`,
      adapter,
      accountId,
      actorId,
      Date.now(),
    ).toArray()[0];

    if (!row) return null;
    return {
      code: row.code,
      adapter: row.adapter,
      accountId: row.account_id,
      actorId: row.actor_id,
      surfaceKind: row.surface_kind as AdapterSurfaceKind,
      surfaceId: row.surface_id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      usedAt: row.used_at,
      usedByUid: row.used_by_uid,
    };
  }

  private generateCode(): string {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const part = () => {
      let out = "";
      for (let i = 0; i < 4; i++) {
        const idx = Math.floor(Math.random() * alphabet.length);
        out += alphabet[idx];
      }
      return out;
    };

    return `${part()}-${part()}`;
  }
}

type RowShape = {
  code: string;
  adapter: string;
  account_id: string;
  actor_id: string;
  surface_kind: string;
  surface_id: string;
  created_at: number;
  expires_at: number;
  used_at: number | null;
  used_by_uid: number | null;
};
