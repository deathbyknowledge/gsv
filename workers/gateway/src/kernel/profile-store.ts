import type { ProfileFields, ProfileState, PublicProfile } from "@humansandmachines/gsv/protocol";
import { profileFieldsSchema, publicProfileSchema } from "@humansandmachines/gsv/protocol";

type ProfileRow = {
  owner_uid: number;
  subject_id: string;
  revision: number;
  draft_json: string;
  published_alias: string | null;
  published_revision: number | null;
  published_key: string | null;
  pending_json: string | null;
  pending_key: string | null;
  pending_revision: number | null;
  publication_failed: number;
};
export type ProfilePublication = { ownerUid: number; revision: number; key: string; profile: PublicProfile };
export type PublicProfileProjection = { ownerUid: number; alias: string; revision: number; key: string };
export type PublicProfileLocator = { alias: string } | { subjectId: string };

export class ProfileStore {
  private readonly sql: SqlStorage;
  constructor(private readonly storage: DurableObjectStorage) { this.sql = storage.sql; }

  get(ownerUid: number, origin: string): ProfileState | null {
    const row = this.row(ownerUid);
    return row ? {
      revision: row.revision, draft: profileFieldsSchema.parse(JSON.parse(row.draft_json)),
      ...(row.published_alias && row.published_revision ? { published: { url: `${origin}/@${row.published_alias}`, revision: row.published_revision } } : {}),
      publishing: row.pending_revision !== null,
      publicationFailed: row.publication_failed === 1,
    } : null;
  }

  update(ownerUid: number, subjectId: string, expectedRevision: number, draft: ProfileFields): void {
    this.storage.transactionSync(() => {
      const existing = this.row(ownerUid);
      if ((existing?.revision ?? 0) !== expectedRevision) throw new Error("Profile changed; reload before saving");
      if (!existing && this.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM social_profiles").one().count >= 1000) throw new Error("Profile capacity reached");
      if (existing && existing.subject_id !== subjectId) throw new Error("Profile identity changed");
      const alias = this.sql.exec<{ owner_uid: number }>("SELECT owner_uid FROM social_profile_aliases WHERE alias = ?", draft.alias).toArray()[0];
      if (alias && alias.owner_uid !== ownerUid) throw new Error("This public alias is unavailable");
      if (!alias) {
        const count = this.sql.exec<{ owner_count: number; total: number }>("SELECT COUNT(*) AS total, COALESCE(SUM(owner_uid = ?), 0) AS owner_count FROM social_profile_aliases", ownerUid).one();
        if (count.owner_count >= 32 || count.total >= 10_000) throw new Error("Public alias capacity reached");
        this.sql.exec("INSERT INTO social_profile_aliases (alias, owner_uid) VALUES (?, ?)", draft.alias, ownerUid);
      }
      this.sql.exec(`INSERT INTO social_profiles (owner_uid, subject_id, revision, draft_json) VALUES (?, ?, 1, ?)
        ON CONFLICT(owner_uid) DO UPDATE SET revision = revision + 1, draft_json = excluded.draft_json`, ownerUid, subjectId, JSON.stringify(draft));
    });
  }

  preparePublication(ownerUid: number, expectedRevision: number, profile: PublicProfile): ProfilePublication | null {
    return this.storage.transactionSync(() => {
      const row = this.requireRevision(ownerUid, expectedRevision);
      if (profile.actor.subjectId !== row.subject_id || profile.revision !== expectedRevision) throw new Error("Profile publication identity changed");
      if (row.published_revision === expectedRevision) return null;
      const pending = this.publication(ownerUid);
      if (pending?.revision === expectedRevision) return pending;
      if (this.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM social_profile_garbage WHERE owner_uid = ?", ownerUid).one().count >= 64) {
        throw new Error("Previous profile cleanup is pending; try publishing again later");
      }
      if (pending) this.retireObject(ownerUid, pending.key);
      const key = `social/profiles/${encodeURIComponent(row.subject_id)}/${expectedRevision}.json`;
      this.sql.exec(`UPDATE social_profiles SET pending_revision = ?, pending_key = ?, pending_json = ?, publication_failed = 0 WHERE owner_uid = ?`,
        expectedRevision, key, JSON.stringify(profile), ownerUid);
      return { ownerUid, revision: expectedRevision, key, profile };
    });
  }

  publication(ownerUid: number): ProfilePublication | null {
    const row = this.row(ownerUid);
    return row?.pending_key && row.pending_revision && row.pending_json
      ? { ownerUid, revision: row.pending_revision, key: row.pending_key, profile: publicProfileSchema.parse(JSON.parse(row.pending_json)) } : null;
  }

  pendingOwners(): number[] {
    return this.sql.exec<{ owner_uid: number }>(`SELECT owner_uid FROM social_profiles WHERE pending_revision IS NOT NULL
      UNION SELECT owner_uid FROM social_profile_garbage LIMIT 1000`).toArray().map((row) => row.owner_uid);
  }

  finishPublication(job: ProfilePublication): boolean {
    return this.storage.transactionSync(() => {
      const row = this.row(job.ownerUid);
      if (row?.pending_revision !== job.revision || row.pending_key !== job.key) return false;
      if (row.published_key) this.retireObject(job.ownerUid, row.published_key);
      this.sql.exec(`UPDATE social_profiles SET published_alias = ?, published_revision = ?, published_key = ?,
        pending_revision = NULL, pending_key = NULL, pending_json = NULL, publication_failed = 0 WHERE owner_uid = ?`, job.profile.alias, job.revision, job.key, job.ownerUid);
      return true;
    });
  }

  failPublication(job: ProfilePublication): void {
    this.sql.exec("UPDATE social_profiles SET publication_failed = 1 WHERE owner_uid = ? AND pending_revision = ?", job.ownerUid, job.revision);
  }

  unpublish(ownerUid: number, expectedRevision: number): void {
    this.storage.transactionSync(() => {
      const row = this.requireRevision(ownerUid, expectedRevision);
      if (row.published_key) this.retireObject(ownerUid, row.published_key);
      if (row.pending_key) this.retireObject(ownerUid, row.pending_key);
      this.sql.exec(`UPDATE social_profiles SET revision = revision + 1, published_alias = NULL, published_revision = NULL, published_key = NULL,
        pending_revision = NULL, pending_key = NULL, pending_json = NULL, publication_failed = 0 WHERE owner_uid = ?`, ownerUid);
    });
  }

  published(locator: PublicProfileLocator): PublicProfileProjection | null {
    const row = "alias" in locator
      ? this.sql.exec<ProfileRow>("SELECT * FROM social_profiles WHERE published_alias = ?", locator.alias).toArray()[0]
      : this.sql.exec<ProfileRow>("SELECT * FROM social_profiles WHERE subject_id = ?", locator.subjectId).toArray()[0];
    return row?.published_key && row.published_revision && row.published_alias
      ? { ownerUid: row.owner_uid, alias: row.published_alias, revision: row.published_revision, key: row.published_key } : null;
  }

  retireObject(ownerUid: number, key: string): void {
    this.sql.exec("INSERT OR IGNORE INTO social_profile_garbage (object_key, owner_uid) VALUES (?, ?)", key, ownerUid);
  }

  garbage(ownerUid: number): string[] {
    return this.sql.exec<{ object_key: string }>(`SELECT g.object_key FROM social_profile_garbage g
      WHERE g.owner_uid = ? AND NOT EXISTS (
        SELECT 1 FROM social_profiles p WHERE p.published_key = g.object_key OR p.pending_key = g.object_key
      ) LIMIT 100`, ownerUid).toArray().map((row) => row.object_key);
  }

  collected(key: string): void {
    this.sql.exec("DELETE FROM social_profile_garbage WHERE object_key = ?", key);
  }

  hasPendingWork(ownerUid: number): boolean {
    return this.publication(ownerUid) !== null || this.garbage(ownerUid).length > 0;
  }

  private requireRevision(ownerUid: number, revision: number): ProfileRow {
    const row = this.row(ownerUid);
    if (!row || row.revision !== revision) throw new Error("Profile changed; reload before publishing");
    return row;
  }

  private row(ownerUid: number): ProfileRow | null {
    return this.sql.exec<ProfileRow>("SELECT * FROM social_profiles WHERE owner_uid = ?", ownerUid).toArray()[0] ?? null;
  }
}
