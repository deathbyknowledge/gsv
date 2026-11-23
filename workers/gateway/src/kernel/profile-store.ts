import type { ProfileAvatar, ProfileFields, ProfileState, ShipProfileRecord } from "@humansandmachines/gsv/protocol";
import { PROFILE_AVATAR_MIME_TYPES, profileContactPolicy, shipProfileRecordSchema } from "@humansandmachines/gsv/protocol";
import { z } from "zod/mini";
import type { BlueskyProfileRecord } from "./bluesky-profile";

type ProfileRow = {
  owner_uid: number;
  revision: number;
  record_json: string;
  record_cid: string | null;
  mirror_json: string | null;
};
type AvatarRow = { cid: string; mime_type: string; size: number };

/** A profile picture with its bytes. */
export type ProfileAvatarFile = ProfileAvatar & { bytes: Uint8Array };
/** The owner's profile at one revision: the record and the picture it shows. */
export type OwnerProfile = { revision: number; fields: ProfileFields; avatar: ProfileAvatar | null };
/** A record the Ship's repository holds, named by its CID. */
export type PublishedProfileRecord = { cid: string; record: ShipProfileRecord };
/** The space's published profile: the record its repository holds. */
export type PublishedProfile = PublishedProfileRecord & { ownerUid: number };

const avatarMimeTypeSchema = z.enum(PROFILE_AVATAR_MIME_TYPES);

/**
 * The owner's public profile: the `space.ship.profile` record the Ship's repository holds, at a revision
 * every change moves on. A profile published before profiles were records keeps its record without a CID
 * until the Kernel writes it to the repository.
 */
export class ProfileStore {
  private readonly sql: SqlStorage;
  /** The last publication asked for; each waits for the one before it. */
  private publications: Promise<void> = Promise.resolve();
  constructor(private readonly storage: DurableObjectStorage) { this.sql = storage.sql; }

  /** The owner's profile as their editor shows it, with `url` as its address; null until it is first published. */
  get(ownerUid: number, url: string): ProfileState | null {
    const row = this.row(ownerUid);
    if (!row) return null;
    const profile = this.profileOf(row);
    return {
      revision: profile.revision, url, fields: profile.fields,
      ...(profile.avatar ? { avatar: profile.avatar } : undefined), ...(row.record_cid ? { cid: row.record_cid } : undefined),
    };
  }

  /** The owner's profile, which the next change starts from; null until it is first published. */
  current(ownerUid: number): OwnerProfile | null {
    const row = this.row(ownerUid);
    return row ? this.profileOf(row) : null;
  }

  /**
   * Records `record`, which the Ship's repository now holds as `cid`, in place of the profile at
   * `expectedRevision`, 0 for the first. `mirror` is Bluesky's copy the repository holds beside it, or null for none.
   */
  publish(ownerUid: number, expectedRevision: number, cid: string, record: ShipProfileRecord, avatar: ProfileAvatarFile | null, mirror: BlueskyProfileRecord | null): void {
    this.storage.transactionSync(() => {
      const existing = this.row(ownerUid);
      if ((existing?.revision ?? 0) !== expectedRevision) throw new Error("Profile changed; reload before saving");
      if (!existing && this.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM social_profiles").one().count > 0) throw new Error("A Ship has one public profile");
      if (avatar) this.sql.exec("INSERT OR IGNORE INTO social_profile_avatars (cid, mime_type, bytes) VALUES (?, ?, ?)",
        avatar.cid, avatar.mimeType, avatar.bytes.slice().buffer);
      this.sql.exec(`INSERT INTO social_profiles (owner_uid, revision, record_json, record_cid, mirror_json) VALUES (?, 1, ?, ?, ?)
        ON CONFLICT(owner_uid) DO UPDATE SET revision = revision + 1, record_json = excluded.record_json,
          record_cid = excluded.record_cid, mirror_json = excluded.mirror_json`,
      ownerUid, JSON.stringify(record), cid, mirrorJson(mirror));
      // Keeps only the picture a record shows.
      this.sql.exec(`DELETE FROM social_profile_avatars WHERE cid NOT IN (
        SELECT json_extract(record_json, '$.avatar.ref."$link"') FROM social_profiles
          WHERE json_extract(record_json, '$.avatar.ref."$link"') IS NOT NULL
      )`);
    });
  }

  /** Records that the repository now holds a record published before profiles were records, as `cid`. */
  written(ownerUid: number, cid: string, mirror: BlueskyProfileRecord | null): void {
    this.sql.exec("UPDATE social_profiles SET record_cid = ?, mirror_json = ? WHERE owner_uid = ? AND record_cid IS NULL", cid, mirrorJson(mirror), ownerUid);
  }

  /** The owner's record in the Ship's repository and its CID, or null until the repository holds one. */
  published(ownerUid: number): PublishedProfileRecord | null {
    const row = this.row(ownerUid);
    return row?.record_cid ? { cid: row.record_cid, record: recordOf(row) } : null;
  }

  /** Whether the repository holds exactly `mirror` as Bluesky's copy of the published profile, or nothing for null. */
  holdsMirror(ownerUid: number, mirror: BlueskyProfileRecord | null): boolean {
    return (this.row(ownerUid)?.mirror_json ?? null) === mirrorJson(mirror);
  }

  /** Records Bluesky's copy the repository now holds beside the published record, or null once it holds none. */
  setMirror(ownerUid: number, mirror: BlueskyProfileRecord | null): void {
    this.sql.exec("UPDATE social_profiles SET mirror_json = ? WHERE owner_uid = ?", mirrorJson(mirror), ownerUid);
  }

  /** The space's one published profile, for its public page. */
  page(): PublishedProfile | null {
    const row = this.sql.exec<ProfileRow>("SELECT * FROM social_profiles WHERE record_cid IS NOT NULL").toArray()[0];
    return row?.record_cid ? { ownerUid: row.owner_uid, cid: row.record_cid, record: recordOf(row) } : null;
  }

  /** A record published before profiles were records, which the repository doesn't hold yet. */
  unwritten(ownerUid: number): ShipProfileRecord | null {
    const row = this.row(ownerUid);
    return row && row.record_cid === null ? recordOf(row) : null;
  }

  /** The picture the owner's profile shows. */
  ownAvatar(ownerUid: number, cid: string): ProfileAvatarFile | null {
    const row = this.row(ownerUid);
    return row && recordOf(row).avatar?.ref.$link === cid ? this.avatar(cid) : null;
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

  private profileOf(row: ProfileRow): OwnerProfile {
    const record = recordOf(row);
    return { revision: row.revision, fields: fieldsOf(record), avatar: record.avatar ? this.avatarMetadata(record.avatar.ref.$link) : null };
  }

  private row(ownerUid: number): ProfileRow | null {
    return this.sql.exec<ProfileRow>("SELECT * FROM social_profiles WHERE owner_uid = ?", ownerUid).toArray()[0] ?? null;
  }
}

function recordOf(row: ProfileRow): ShipProfileRecord {
  return shipProfileRecordSchema.parse(JSON.parse(row.record_json));
}

/** What the profile editor shows of a record. */
export function fieldsOf(record: ShipProfileRecord): ProfileFields {
  return { displayName: record.displayName, about: record.about ?? "", contactPolicy: profileContactPolicy(record.contactPolicy) };
}

/** A copy as stored, which a copy made the same way matches exactly. */
function mirrorJson(mirror: BlueskyProfileRecord | null): string | null {
  return mirror ? JSON.stringify(mirror) : null;
}
