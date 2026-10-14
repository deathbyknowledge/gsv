import type { ProfileFields, ProfileState, PublicProfile } from "@humansandmachines/gsv/protocol";
import { profileFieldsSchema, publicProfileSchema } from "@humansandmachines/gsv/protocol";

type ProfileRow = {
  owner_uid: number;
  subject_id: string;
  revision: number;
  draft_json: string;
  published_alias: string | null;
  published_revision: number | null;
  published_json: string | null;
};
export type PublicProfileProjection = { ownerUid: number; revision: number; profile: PublicProfile };
export type PublicProfileLocator = { space: true } | { alias: string } | { subjectId: string };

export class ProfileStore {
  private readonly sql: SqlStorage;
  constructor(private readonly storage: DurableObjectStorage) { this.sql = storage.sql; }

  get(ownerUid: number, origin: string): ProfileState | null {
    const row = this.row(ownerUid);
    if (!row) return null;
    const state: ProfileState = {
      revision: row.revision, url: `${origin}/profile`, draft: profileFieldsSchema.parse(JSON.parse(row.draft_json)),
    };
    if (row.published_json && row.published_revision) state.published = { url: `${origin}/profile`, revision: row.published_revision };
    return state;
  }

  update(ownerUid: number, subjectId: string, expectedRevision: number, draft: ProfileFields): void {
    this.storage.transactionSync(() => {
      const existing = this.row(ownerUid);
      if ((existing?.revision ?? 0) !== expectedRevision) throw new Error("Profile changed; reload before saving");
      if (!existing && this.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM social_profiles").one().count > 0) throw new Error("A space has one public profile");
      if (existing && existing.subject_id !== subjectId) throw new Error("Profile identity changed");
      this.sql.exec(`INSERT INTO social_profiles (owner_uid, subject_id, revision, draft_json) VALUES (?, ?, 1, ?)
        ON CONFLICT(owner_uid) DO UPDATE SET revision = revision + 1, draft_json = excluded.draft_json`, ownerUid, subjectId, JSON.stringify(draft));
    });
  }

  publish(ownerUid: number, expectedRevision: number, profile: PublicProfile): void {
    this.storage.transactionSync(() => {
      const row = this.requireRevision(ownerUid, expectedRevision);
      if (profile.actor.subjectId !== row.subject_id || profile.revision !== expectedRevision) throw new Error("Profile publication identity changed");
      if (row.published_revision === expectedRevision) return;
      this.sql.exec(`UPDATE social_profiles SET published_alias = COALESCE(?, published_alias), published_revision = ?, published_json = ? WHERE owner_uid = ?`,
        profile.version === 2 ? profile.alias : null, expectedRevision, JSON.stringify(profile), ownerUid);
    });
  }

  unpublish(ownerUid: number, expectedRevision: number): void {
    this.storage.transactionSync(() => {
      this.requireRevision(ownerUid, expectedRevision);
      this.sql.exec(`UPDATE social_profiles SET revision = revision + 1,
        published_revision = NULL, published_json = NULL WHERE owner_uid = ?`, ownerUid);
    });
  }

  published(locator: PublicProfileLocator): PublicProfileProjection | null {
    const row = "space" in locator
      ? this.sql.exec<ProfileRow>("SELECT * FROM social_profiles").toArray()[0]
      : "alias" in locator
      ? this.sql.exec<ProfileRow>("SELECT * FROM social_profiles WHERE published_alias = ?", locator.alias).toArray()[0]
      : this.sql.exec<ProfileRow>("SELECT * FROM social_profiles WHERE subject_id = ?", locator.subjectId).toArray()[0];
    return row?.published_json && row.published_revision
      ? { ownerUid: row.owner_uid, revision: row.published_revision,
        profile: publicProfileSchema.parse(JSON.parse(row.published_json)) } : null;
  }

  upgradePublication(ownerUid: number, signature: string, profile: PublicProfile): void {
    this.sql.exec("UPDATE social_profiles SET published_json = ? WHERE owner_uid = ? AND json_extract(published_json, '$.signature') = ?",
      JSON.stringify(profile), ownerUid, signature);
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
