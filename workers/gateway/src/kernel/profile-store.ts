import type { ProfileAvatar, ProfileFields, ProfileState, ShipProfileRecord } from "@humansandmachines/gsv/protocol";
import { PROFILE_AVATAR_MIME_TYPES, profileContactPolicy, profileFieldsSchema, shipProfileRecordSchema } from "@humansandmachines/gsv/protocol";
import { z } from "zod/mini";

type ProfileRow = {
  owner_uid: number;
  revision: number;
  draft_json: string;
  draft_avatar_cid: string | null;
  published_revision: number | null;
  published_json: string | null;
  published_cid: string | null;
};
type AvatarRow = { cid: string; mime_type: string; size: number };

/** A profile picture with its bytes. */
export type ProfileAvatarFile = ProfileAvatar & { bytes: Uint8Array };
/** The saved draft at one revision: what a publish writes. */
export type ProfileDraft = { revision: number; fields: ProfileFields; avatar: ProfileAvatar | null };
/** A record and the draft revision it holds. */
export type ProfilePublication = { revision: number; record: ShipProfileRecord };
/** A record the Ship's repository holds, named by its CID. */
export type PublishedProfileRecord = { cid: string; record: ShipProfileRecord };
/** The space's published profile: the record its repository holds. */
export type PublishedProfile = ProfilePublication & PublishedProfileRecord & { ownerUid: number };

const avatarMimeTypeSchema = z.enum(PROFILE_AVATAR_MIME_TYPES);

export class ProfileStore {
  private readonly sql: SqlStorage;
  /** The last publication asked for; each waits for the one before it. */
  private publications: Promise<void> = Promise.resolve();
  constructor(private readonly storage: DurableObjectStorage) { this.sql = storage.sql; }

  /** The owner's profile as their editor shows it, with `url` as its address. */
  get(ownerUid: number, url: string): ProfileState | null {
    const row = this.row(ownerUid);
    if (!row) return null;
    const state: ProfileState = { revision: row.revision, url, draft: draftFields(row) };
    const avatar = row.draft_avatar_cid ? this.avatarMetadata(row.draft_avatar_cid) : null;
    if (avatar) state.avatar = avatar;
    const published = publishedOf(row);
    if (published) {
      state.published = { url, cid: published.cid, contactPolicy: profileContactPolicy(published.record.contactPolicy), revision: published.revision };
    }
    return state;
  }

  draft(ownerUid: number): ProfileDraft | null {
    const row = this.row(ownerUid);
    if (!row) return null;
    return { revision: row.revision, fields: draftFields(row), avatar: row.draft_avatar_cid ? this.avatarMetadata(row.draft_avatar_cid) : null };
  }

  update(ownerUid: number, expectedRevision: number, draft: ProfileFields): void {
    this.storage.transactionSync(() => {
      this.requireEditable(ownerUid, expectedRevision);
      this.sql.exec(`INSERT INTO social_profiles (owner_uid, revision, draft_json) VALUES (?, 1, ?)
        ON CONFLICT(owner_uid) DO UPDATE SET revision = revision + 1, draft_json = excluded.draft_json`, ownerUid, JSON.stringify(draft));
    });
  }

  /** Replaces or removes the draft's picture; a profile saved for the first time starts from `initial`. */
  setAvatar(ownerUid: number, expectedRevision: number, avatar: ProfileAvatarFile | null, initial: ProfileFields): void {
    this.storage.transactionSync(() => {
      const existing = this.requireEditable(ownerUid, expectedRevision);
      if (avatar) {
        this.sql.exec("INSERT OR IGNORE INTO social_profile_avatars (cid, mime_type, bytes) VALUES (?, ?, ?)",
          avatar.cid, avatar.mimeType, avatar.bytes.slice().buffer);
      }
      if (existing) {
        this.sql.exec("UPDATE social_profiles SET revision = revision + 1, draft_avatar_cid = ? WHERE owner_uid = ?", avatar?.cid ?? null, ownerUid);
      } else {
        this.sql.exec("INSERT INTO social_profiles (owner_uid, revision, draft_json, draft_avatar_cid) VALUES (?, 1, ?, ?)",
          ownerUid, JSON.stringify(initial), avatar?.cid ?? null);
      }
      this.releaseAvatars();
    });
  }

  /** Records the record the Ship's repository now holds for `revision`, whatever the draft became meanwhile. */
  publish(ownerUid: number, revision: number, cid: string, record: ShipProfileRecord): void {
    this.storage.transactionSync(() => {
      this.sql.exec("UPDATE social_profiles SET published_revision = ?, published_json = ?, published_cid = ? WHERE owner_uid = ?",
        revision, JSON.stringify(record), cid, ownerUid);
      this.releaseAvatars();
    });
  }

  /** The profile is private once its record is gone from the repository, whatever the draft became meanwhile. */
  unpublish(ownerUid: number): void {
    this.storage.transactionSync(() => {
      this.sql.exec(`UPDATE social_profiles SET revision = revision + 1,
        published_revision = NULL, published_json = NULL, published_cid = NULL WHERE owner_uid = ?`, ownerUid);
      this.releaseAvatars();
    });
  }

  /** The owner's record in the Ship's repository and its CID, or null while the profile is private. */
  published(ownerUid: number): PublishedProfileRecord | null {
    const row = this.row(ownerUid);
    const published = row ? publishedOf(row) : null;
    return published ? { cid: published.cid, record: published.record } : null;
  }

  /** The space's one published profile, for its public page. */
  page(): PublishedProfile | null {
    const row = this.sql.exec<ProfileRow>("SELECT * FROM social_profiles").toArray()[0];
    return row ? publishedOf(row) : null;
  }

  /** A record published before profiles were records, which the repository doesn't hold yet. */
  pendingPublication(ownerUid: number): ProfilePublication | null {
    const row = this.row(ownerUid);
    if (!row?.published_json || row.published_revision === null || row.published_cid !== null) return null;
    return { revision: row.published_revision, record: shipProfileRecordSchema.parse(JSON.parse(row.published_json)) };
  }

  /** A picture the owner's draft or published record shows. */
  ownAvatar(ownerUid: number, cid: string): ProfileAvatarFile | null {
    const row = this.row(ownerUid);
    const published = row ? publishedOf(row) : null;
    const shown = row?.draft_avatar_cid === cid || published?.record.avatar?.ref.$link === cid;
    return shown ? this.avatar(cid) : null;
  }

  avatar(cid: string): ProfileAvatarFile | null {
    const row = this.sql.exec<AvatarRow & { bytes: ArrayBuffer }>(
      "SELECT cid, mime_type, length(bytes) AS size, bytes FROM social_profile_avatars WHERE cid = ?", cid).toArray()[0];
    return row ? { cid: row.cid, mimeType: avatarMimeTypeSchema.parse(row.mime_type), size: row.size, bytes: new Uint8Array(row.bytes) } : null;
  }

  /** Runs one publication at a time, in the order asked, so the repository and this store agree on the last one. */
  async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.publications;
    let release!: () => void;
    this.publications = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private avatarMetadata(cid: string): ProfileAvatar | null {
    const row = this.sql.exec<AvatarRow>("SELECT cid, mime_type, length(bytes) AS size FROM social_profile_avatars WHERE cid = ?", cid).toArray()[0];
    return row ? { cid: row.cid, mimeType: avatarMimeTypeSchema.parse(row.mime_type), size: row.size } : null;
  }

  /** Keeps only the pictures a draft or a published record shows. */
  private releaseAvatars(): void {
    this.sql.exec(`DELETE FROM social_profile_avatars WHERE cid NOT IN (
      SELECT draft_avatar_cid FROM social_profiles WHERE draft_avatar_cid IS NOT NULL
      UNION SELECT json_extract(published_json, '$.avatar.ref."$link"') FROM social_profiles
        WHERE json_extract(published_json, '$.avatar.ref."$link"') IS NOT NULL
    )`);
  }

  private requireEditable(ownerUid: number, expectedRevision: number): ProfileRow | null {
    const existing = this.row(ownerUid);
    if ((existing?.revision ?? 0) !== expectedRevision) throw new Error("Profile changed; reload before saving");
    if (!existing && this.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM social_profiles").one().count > 0) throw new Error("A Ship has one public profile");
    return existing;
  }

  private row(ownerUid: number): ProfileRow | null {
    return this.sql.exec<ProfileRow>("SELECT * FROM social_profiles WHERE owner_uid = ?", ownerUid).toArray()[0] ?? null;
  }
}

function draftFields(row: ProfileRow): ProfileFields {
  return profileFieldsSchema.parse(JSON.parse(row.draft_json));
}

function publishedOf(row: ProfileRow): PublishedProfile | null {
  if (!row.published_json || row.published_revision === null || row.published_cid === null) return null;
  return {
    ownerUid: row.owner_uid, revision: row.published_revision, cid: row.published_cid,
    record: shipProfileRecordSchema.parse(JSON.parse(row.published_json)),
  };
}
