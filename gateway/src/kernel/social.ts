import type {
  SocialAtUri,
  SocialContactAddArgs,
  SocialContactAddResult,
  SocialContactGrantsSetArgs,
  SocialContactGrantsSetResult,
  SocialContactListArgs,
  SocialContactListResult,
  SocialContactPublicListArgs,
  SocialContactPublicListResult,
  SocialContactPublishArgs,
  SocialContactPublishResult,
  SocialContactRemoveArgs,
  SocialContactRemoveResult,
  SocialContactSummary,
  SocialContactUnpublishArgs,
  SocialContactUnpublishResult,
  SocialDid,
  SocialGrant,
  SocialIdentityGetArgs,
  SocialIdentityGetResult,
  SocialIdentityRepublishArgs,
  SocialIdentityRepublishResult,
  SocialIdentitySetArgs,
  SocialIdentitySetResult,
  SocialInboundArgs,
  SocialInboundResult,
  SocialInstanceGetArgs,
  SocialInstanceGetResult,
  SocialInstanceUpdateArgs,
  SocialInstanceUpdateResult,
  SocialLocalIdentity,
  SocialMessageDirection,
  SocialMessageSendArgs,
  SocialMessageSendResult,
  SocialMessageSender,
  SocialMessageStatusGetArgs,
  SocialMessageStatusGetResult,
  SocialMessageStatusListArgs,
  SocialMessageStatusListResult,
  SocialMessageStatusState,
  SocialMessageStatusSummary,
  SocialMessageStatusUpdateArgs,
  SocialMessageStatusUpdateResult,
  SocialMessageSummary,
  SocialNewsCreateArgs,
  SocialNewsCreateResult,
  SocialNewsDeleteArgs,
  SocialNewsDeleteResult,
  SocialNewsListArgs,
  SocialNewsListResult,
  SocialPackageListArgs,
  SocialPackageListResult,
  SocialPackageReleaseListArgs,
  SocialPackageReleaseListResult,
  SocialProfileGetArgs,
  SocialProfileGetResult,
  SocialProfileUpdateArgs,
  SocialProfileUpdateResult,
  SocialPublicRecordEntry,
  SocialSetupArgs,
  SocialSetupResult,
  SocialSignedRequestEnvelope,
  SocialThreadCreateArgs,
  SocialThreadCreateResult,
  SocialThreadGetArgs,
  SocialThreadGetResult,
  SocialThreadListArgs,
  SocialThreadListResult,
  SocialRemoteOperation,
  SocialThreadSummary,
  SocialThreadStatus,
  SocialUserListArgs,
  SocialUserListResult,
  SocialVouchCreateArgs,
  SocialVouchCreateResult,
  SocialVouchDeleteArgs,
  SocialVouchDeleteResult,
  SocialVouchListArgs,
  SocialVouchListResult,
  SpaceGsvCollection,
  SpaceGsvContactRecord,
  SpaceGsvInstanceRecord,
  SpaceGsvNewsRecord,
  SpaceGsvPackageRecord,
  SpaceGsvPackageReleaseRecord,
  SpaceGsvProfileRecord,
  SpaceGsvRecord,
  SpaceGsvUserRecord,
  SpaceGsvVouchRecord,
} from "@gsv/protocol/syscalls/social";
import type { ProcessIdentity } from "@gsv/protocol/syscalls/system";
import type { InstalledPackageRecord } from "./packages";
import {
  isSocialRemoteOperation,
  SPACE_GSV_CONTACT,
  SPACE_GSV_INSTANCE,
  SPACE_GSV_NEWS,
  SPACE_GSV_PACKAGE,
  SPACE_GSV_PACKAGE_RELEASE,
  SPACE_GSV_PROFILE,
  SPACE_GSV_USER,
  SPACE_GSV_VOUCH,
  SOCIAL_REMOTE_OPERATIONS,
} from "@gsv/protocol/syscalls/social";
import type { KernelContext } from "./context";
import { requirePdsClient } from "../pds/client";
import { isGsvDevMode, socialOriginForHandle } from "../dev";
import { GsvFs } from "../fs/gsv-fs";
import { createHomeKnowledgeBackend } from "../fs/backends/home-knowledge";
import { dispatchMindEvent } from "./mind";
import { remoteSocialProcessAuthority } from "./authority";
import { sendFrameToProcess } from "../shared/utils";

const SELF_RKEY = "self";
const DID_PATTERN = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/;
const MAIN_SOCIAL_UID = 1000;
const FRIEND_SELF_RKEY = "self";
const SOCIAL_ID_PATTERN = /^[A-Za-z0-9._-]{1,200}$/;
const MAX_SOCIAL_TEXT_BYTES = 16 * 1024;
const MAX_SOCIAL_BODY_BYTES = 64 * 1024;
const SOCIAL_ENVELOPE_TTL_MS = 5 * 60 * 1000;
const SOCIAL_DELIVERY_RETRY_DELAYS_MS = [
  10_000,
  60_000,
  5 * 60_000,
  30 * 60_000,
  2 * 60 * 60_000,
] as const;
const SOCIAL_MAX_DELIVERY_ATTEMPTS = 1 + SOCIAL_DELIVERY_RETRY_DELAYS_MS.length;
const SOCIAL_INBOUND_METHODS = new Set<SocialRemoteOperation>([
  "social.thread.create",
  "social.message.send",
  "social.message.status.update",
]);
const P256_MULTICODEC_PREFIX = [0x80, 0x24] as const;
const P256_FIELD_PRIME = BigInt("0xffffffff00000001000000000000000000000000ffffffffffffffffffffffff");
const P256_B = BigInt("0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b");

type IdentityRow = {
  uid: number;
  did: string;
  handle: string | null;
  pds_endpoint: string;
  created_at: number;
  updated_at: number;
};

type RecordRow = {
  uid: number;
  collection: string;
  rkey: string;
  uri: string | null;
  cid: string | null;
  record_json: string;
  created_at: number;
  updated_at: number;
};

type SettingsRow = {
  uid: number;
  service_private_jwk_json: string;
  service_public_key_multibase: string;
  created_at: number;
  updated_at: number;
};

type FriendRow = {
  uid: number;
  handle: string;
  did: string;
  pds_endpoint: string;
  note: string | null;
  display_name: string | null;
  profile_json: string | null;
  instance_json: string;
  agent_card_json: string | null;
  created_at: number;
  updated_at: number;
  synced_at: number | null;
};

type FriendRecordRow = {
  uid: number;
  friend_handle: string;
  collection: string;
  rkey: string;
  uri: string | null;
  cid: string | null;
  record_json: string;
  created_at: number;
  updated_at: number;
  synced_at: number;
};

type FriendGrantRow = {
  uid: number;
  friend_handle: string;
  operation: string;
  scope_json: string | null;
  expires_at: string | null;
  created_at: number;
  updated_at: number;
};

type InboundReplayRow = {
  uid: number;
  envelope_id: string;
  nonce: string;
  from_handle: string;
  method: string;
  received_at: number;
  expires_at: number;
};

type ThreadRow = {
  uid: number;
  thread_id: string;
  peer_handle: string;
  conversation_id: string;
  status: string;
  created_at: number;
  updated_at: number;
  expires_at: string | null;
};

type MessageRow = {
  uid: number;
  message_id: string;
  thread_id: string;
  direction: string;
  from_handle: string;
  to_handle: string;
  text: string | null;
  body_json: string | null;
  sender_json: string | null;
  delivery_method: string | null;
  delivery_status: string;
  delivery_attempt_count: number | null;
  next_retry_at: number | null;
  retry_schedule_id: string | null;
  last_delivery_error: string | null;
  remote_event_id: string | null;
  created_at: number;
  updated_at: number;
};

type MessageStatusRow = {
  uid: number;
  message_id: string;
  thread_id: string;
  state: string;
  summary: string | null;
  needs_human_reason: string | null;
  body_json: string | null;
  remote_event_id: string | null;
  created_at: number;
  updated_at: number;
};

export type SocialIdentityRecord = {
  uid: number;
  did: SocialDid;
  handle?: string;
  pdsEndpoint: string;
  createdAt: number;
  updatedAt: number;
};

export type SocialServiceSettings = {
  uid: number;
  servicePrivateJwk: JsonWebKey;
  servicePublicKeyMultibase: string;
  createdAt: number;
  updatedAt: number;
};

export type SocialPublicRecord<TRecord extends SpaceGsvRecord = SpaceGsvRecord> = {
  uid: number;
  collection: SpaceGsvCollection;
  rkey: string;
  uri?: string;
  cid?: string;
  record: TRecord;
  createdAt: number;
  updatedAt: number;
};

export type SocialFriendPublicRecord<TRecord extends SpaceGsvRecord = SpaceGsvRecord> = {
  uid: number;
  friendHandle: string;
  collection: SpaceGsvCollection;
  rkey: string;
  uri?: string;
  cid?: string;
  record: TRecord;
  createdAt: number;
  updatedAt: number;
  syncedAt: number;
};

export type SocialFriendRecord = {
  uid: number;
  handle: string;
  did: SocialDid;
  pdsEndpoint: string;
  note: string;
  displayName?: string;
  profile?: SpaceGsvProfileRecord;
  instance: SpaceGsvInstanceRecord;
  createdAt: number;
  updatedAt: number;
  syncedAt?: number;
};

export type SocialThreadRecord = {
  uid: number;
  threadId: string;
  peerHandle: string;
  conversationId: string;
  status: SocialThreadStatus;
  createdAt: number;
  updatedAt: number;
  expiresAt?: string;
};

export type SocialMessageRecord = {
  uid: number;
  messageId: string;
  threadId: string;
  direction: SocialMessageDirection;
  fromHandle: string;
  toHandle: string;
  sender?: SocialMessageSender;
  text?: string;
  body?: unknown;
  deliveryMethod?: SocialRemoteOperation;
  deliveryStatus: SocialMessageSummary["deliveryStatus"];
  deliveryAttemptCount: number;
  nextRetryAt?: number;
  retryScheduleId?: string;
  lastDeliveryError?: string;
  remoteEventId?: string;
  createdAt: number;
  updatedAt: number;
};

export type SocialMessageStatusRecord = {
  uid: number;
  messageId: string;
  threadId: string;
  state: SocialMessageStatusState;
  summary?: string;
  needsHumanReason?: string;
  body?: unknown;
  remoteEventId?: string;
  createdAt: number;
  updatedAt: number;
};

export type SocialDeliveryRetryResult =
  | { retried: true; message: SocialMessageSummary }
  | { retried: false; reason: string };

export type SocialPromptContext = {
  remoteGSVs: string;
  localGsvUsers: string;
};

export function buildSocialPromptContext(ctx: KernelContext): SocialPromptContext {
  const users = listLocalSocialUsers(ctx);
  const localGsvUsers = users.length === 0
    ? "- (none)"
    : users.map((user) =>
        user.displayName && user.displayName !== user.username
          ? `- ${user.username}: ${user.displayName}`
          : `- ${user.username}`
      ).join("\n");
  const friends = ctx.social?.listFriends(MAIN_SOCIAL_UID) ?? [];
  const remoteGSVs = friends.length === 0
    ? "- (none)"
    : friends.map((friend) => `- ${friend.handle}: ${friend.note || "(no note)"}`).join("\n");
  return { remoteGSVs, localGsvUsers };
}

export class SocialStore {
  constructor(private readonly sql: SqlStorage) {}

  init(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS social_identities (
        uid INTEGER PRIMARY KEY,
        did TEXT NOT NULL UNIQUE,
        handle TEXT,
        pds_endpoint TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    this.sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_social_identities_did ON social_identities (did)",
    );
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS social_records (
        uid INTEGER NOT NULL,
        collection TEXT NOT NULL,
        rkey TEXT NOT NULL,
        uri TEXT,
        cid TEXT,
        record_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (uid, collection, rkey)
      )
    `);
    this.sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_social_records_collection ON social_records (collection, updated_at DESC)",
    );
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS social_settings (
        uid INTEGER PRIMARY KEY,
        service_private_jwk_json TEXT NOT NULL,
        service_public_key_multibase TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS social_friends (
        uid INTEGER NOT NULL,
        handle TEXT NOT NULL,
        did TEXT NOT NULL,
        pds_endpoint TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        display_name TEXT,
        profile_json TEXT,
        instance_json TEXT NOT NULL,
        agent_card_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        synced_at INTEGER,
        PRIMARY KEY (uid, handle)
      )
    `);
    this.sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_social_friends_did ON social_friends (uid, did)",
    );
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS social_friend_records (
        uid INTEGER NOT NULL,
        friend_handle TEXT NOT NULL,
        collection TEXT NOT NULL,
        rkey TEXT NOT NULL,
        uri TEXT,
        cid TEXT,
        record_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        synced_at INTEGER NOT NULL,
        PRIMARY KEY (uid, friend_handle, collection, rkey)
      )
    `);
    this.sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_social_friend_records_collection ON social_friend_records (uid, friend_handle, collection, updated_at DESC)",
    );
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS social_friend_grants (
        uid INTEGER NOT NULL,
        friend_handle TEXT NOT NULL,
        operation TEXT NOT NULL,
        scope_json TEXT,
        expires_at TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (uid, friend_handle, operation)
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS social_inbound_replays (
        uid INTEGER NOT NULL,
        envelope_id TEXT NOT NULL,
        nonce TEXT NOT NULL,
        from_handle TEXT NOT NULL,
        method TEXT NOT NULL,
        received_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY (uid, envelope_id)
      )
    `);
    this.sql.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_social_inbound_replays_nonce ON social_inbound_replays (uid, nonce)",
    );
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS social_threads (
        uid INTEGER NOT NULL,
        thread_id TEXT NOT NULL,
        peer_handle TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at TEXT,
        PRIMARY KEY (uid, thread_id)
      )
    `);
    this.sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_social_threads_peer ON social_threads (uid, peer_handle, updated_at DESC)",
    );
    this.sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_social_threads_status ON social_threads (uid, status, updated_at DESC)",
    );
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS social_messages (
        uid INTEGER NOT NULL,
        message_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        direction TEXT NOT NULL,
        from_handle TEXT NOT NULL,
        to_handle TEXT NOT NULL,
        text TEXT,
        body_json TEXT,
        sender_json TEXT,
        delivery_method TEXT,
        delivery_status TEXT NOT NULL,
        delivery_attempt_count INTEGER NOT NULL DEFAULT 0,
        next_retry_at INTEGER,
        retry_schedule_id TEXT,
        last_delivery_error TEXT,
        remote_event_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (uid, message_id)
      )
    `);
    this.sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_social_messages_thread ON social_messages (uid, thread_id, created_at ASC)",
    );
    this.sql.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_social_messages_remote_event ON social_messages (uid, remote_event_id)",
    );
    this.sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_social_messages_retry ON social_messages (delivery_status, next_retry_at)",
    );
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS social_message_statuses (
        uid INTEGER NOT NULL,
        message_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        state TEXT NOT NULL,
        summary TEXT,
        needs_human_reason TEXT,
        body_json TEXT,
        remote_event_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (uid, message_id)
      )
    `);
    this.sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_social_message_statuses_thread ON social_message_statuses (uid, thread_id, updated_at DESC)",
    );
    this.sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_social_message_statuses_state ON social_message_statuses (uid, state, updated_at DESC)",
    );
    this.sql.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_social_message_statuses_remote_event ON social_message_statuses (uid, remote_event_id)",
    );
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS social_delivery_attempts (
        uid INTEGER NOT NULL,
        attempt_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        attempted_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (uid, attempt_id)
      )
    `);
    this.sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_social_delivery_attempts_message ON social_delivery_attempts (uid, message_id, attempted_at ASC)",
    );
  }

  getIdentity(uid: number): SocialIdentityRecord | null {
    const rows = this.sql.exec<IdentityRow>(
      "SELECT * FROM social_identities WHERE uid = ? LIMIT 1",
      uid,
    ).toArray();
    return rows[0] ? toIdentityRecord(rows[0]) : null;
  }

  getIdentityByHandle(handle: string): SocialIdentityRecord | null {
    const rows = this.sql.exec<IdentityRow>(
      "SELECT * FROM social_identities WHERE handle = ? LIMIT 1",
      handle,
    ).toArray();
    return rows[0] ? toIdentityRecord(rows[0]) : null;
  }

  getInstanceIdentity(): SocialIdentityRecord | null {
    const rows = this.sql.exec<IdentityRow>(
      "SELECT * FROM social_identities ORDER BY uid ASC LIMIT 1",
    ).toArray();
    return rows[0] ? toIdentityRecord(rows[0]) : null;
  }

  upsertIdentity(input: {
    uid: number;
    did: SocialDid;
    handle?: string;
    pdsEndpoint: string;
  }): SocialIdentityRecord {
    const existing = this.getIdentity(input.uid);
    const now = Date.now();
    const createdAt = existing?.createdAt ?? now;
    this.sql.exec(
      `INSERT OR REPLACE INTO social_identities
        (uid, did, handle, pds_endpoint, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      input.uid,
      input.did,
      input.handle ?? null,
      input.pdsEndpoint,
      createdAt,
      now,
    );
    return {
      uid: input.uid,
      did: input.did,
      handle: input.handle,
      pdsEndpoint: input.pdsEndpoint,
      createdAt,
      updatedAt: now,
    };
  }

  getPublicRecord<TRecord extends SpaceGsvRecord>(
    uid: number,
    collection: SpaceGsvCollection,
    rkey: string = SELF_RKEY,
  ): SocialPublicRecord<TRecord> | null {
    const rows = this.sql.exec<RecordRow>(
      "SELECT * FROM social_records WHERE uid = ? AND collection = ? AND rkey = ? LIMIT 1",
      uid,
      collection,
      rkey,
    ).toArray();
    return rows[0] ? toPublicRecord<TRecord>(rows[0]) : null;
  }

  upsertPublicRecord<TRecord extends SpaceGsvRecord>(input: {
    uid: number;
    collection: SpaceGsvCollection;
    rkey?: string;
    record: TRecord;
    uri?: string;
    cid?: string;
  }): SocialPublicRecord<TRecord> {
    const rkey = input.rkey ?? SELF_RKEY;
    const existing = this.getPublicRecord(input.uid, input.collection, rkey);
    const now = Date.now();
    const createdAt = existing?.createdAt ?? now;
    this.sql.exec(
      `INSERT OR REPLACE INTO social_records
        (uid, collection, rkey, uri, cid, record_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      input.uid,
      input.collection,
      rkey,
      input.uri ?? existing?.uri ?? null,
      input.cid ?? existing?.cid ?? null,
      JSON.stringify(input.record),
      createdAt,
      now,
    );
    return {
      uid: input.uid,
      collection: input.collection,
      rkey,
      uri: input.uri ?? existing?.uri,
      cid: input.cid ?? existing?.cid,
      record: input.record,
      createdAt,
      updatedAt: now,
    };
  }

  listPublicRecords<TRecord extends SpaceGsvRecord>(
    uid: number,
    collection: SpaceGsvCollection,
    limit: number,
  ): SocialPublicRecord<TRecord>[] {
    return this.sql.exec<RecordRow>(
      `SELECT * FROM social_records
       WHERE uid = ? AND collection = ?
       ORDER BY updated_at DESC
       LIMIT ?`,
      uid,
      collection,
      limit,
    ).toArray().map(toPublicRecord<TRecord>);
  }

  deletePublicRecord(uid: number, collection: SpaceGsvCollection, rkey: string): boolean {
    const existing = this.getPublicRecord(uid, collection, rkey);
    if (!existing) {
      return false;
    }
    this.sql.exec(
      "DELETE FROM social_records WHERE uid = ? AND collection = ? AND rkey = ?",
      uid,
      collection,
      rkey,
    );
    return true;
  }

  getSettings(uid: number): SocialServiceSettings | null {
    const rows = this.sql.exec<SettingsRow>(
      "SELECT * FROM social_settings WHERE uid = ? LIMIT 1",
      uid,
    ).toArray();
    return rows[0] ? toServiceSettings(rows[0]) : null;
  }

  upsertSettings(input: {
    uid: number;
    servicePrivateJwk: JsonWebKey;
    servicePublicKeyMultibase: string;
  }): SocialServiceSettings {
    const existing = this.getSettings(input.uid);
    const now = Date.now();
    const createdAt = existing?.createdAt ?? now;
    this.sql.exec(
      `INSERT OR REPLACE INTO social_settings
        (uid, service_private_jwk_json, service_public_key_multibase, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      input.uid,
      JSON.stringify(input.servicePrivateJwk),
      input.servicePublicKeyMultibase,
      createdAt,
      now,
    );
    return {
      uid: input.uid,
      servicePrivateJwk: input.servicePrivateJwk,
      servicePublicKeyMultibase: input.servicePublicKeyMultibase,
      createdAt,
      updatedAt: now,
    };
  }

  listFriends(uid: number): SocialFriendRecord[] {
    return this.sql.exec<FriendRow>(
      "SELECT * FROM social_friends WHERE uid = ? ORDER BY handle ASC",
      uid,
    ).toArray().map(toFriendRecord);
  }

  getFriend(uid: number, handle: string): SocialFriendRecord | null {
    const rows = this.sql.exec<FriendRow>(
      "SELECT * FROM social_friends WHERE uid = ? AND handle = ? LIMIT 1",
      uid,
      handle,
    ).toArray();
    return rows[0] ? toFriendRecord(rows[0]) : null;
  }

  getFriendByDid(uid: number, did: SocialDid): SocialFriendRecord | null {
    const rows = this.sql.exec<FriendRow>(
      "SELECT * FROM social_friends WHERE uid = ? AND did = ? LIMIT 1",
      uid,
      did,
    ).toArray();
    return rows[0] ? toFriendRecord(rows[0]) : null;
  }

  upsertFriend(input: {
    uid: number;
    handle: string;
    did: SocialDid;
    pdsEndpoint: string;
    note: string;
    displayName?: string;
    profile?: SpaceGsvProfileRecord;
    instance: SpaceGsvInstanceRecord;
  }): { friend: SocialFriendRecord; created: boolean } {
    const existing = this.getFriend(input.uid, input.handle);
    const now = Date.now();
    const createdAt = existing?.createdAt ?? now;
    this.sql.exec(
      `INSERT OR REPLACE INTO social_friends
        (uid, handle, did, pds_endpoint, note, display_name, profile_json, instance_json, agent_card_json, created_at, updated_at, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.uid,
      input.handle,
      input.did,
      input.pdsEndpoint,
      input.note,
      input.displayName ?? null,
      input.profile ? JSON.stringify(input.profile) : null,
      JSON.stringify(input.instance),
      null,
      createdAt,
      now,
      now,
    );
    return {
      friend: {
        uid: input.uid,
        handle: input.handle,
        did: input.did,
        pdsEndpoint: input.pdsEndpoint,
        note: input.note,
        displayName: input.displayName,
        profile: input.profile,
        instance: input.instance,
        createdAt,
        updatedAt: now,
        syncedAt: now,
      },
      created: !existing,
    };
  }

  removeFriend(uid: number, handle: string): boolean {
    const existing = this.getFriend(uid, handle);
    if (!existing) {
      return false;
    }
    this.sql.exec(
      "DELETE FROM social_friend_grants WHERE uid = ? AND friend_handle = ?",
      uid,
      handle,
    );
    this.sql.exec(
      "DELETE FROM social_friend_records WHERE uid = ? AND friend_handle = ?",
      uid,
      handle,
    );
    this.sql.exec(
      "DELETE FROM social_friends WHERE uid = ? AND handle = ?",
      uid,
      handle,
    );
    return true;
  }

  getFriendGrants(uid: number, handle: string): SocialGrant[] {
    return this.sql.exec<FriendGrantRow>(
      "SELECT * FROM social_friend_grants WHERE uid = ? AND friend_handle = ? ORDER BY operation ASC",
      uid,
      handle,
    ).toArray().map(toGrantRecord);
  }

  replaceFriendGrants(uid: number, handle: string, grants: SocialGrant[]): SocialGrant[] {
    const now = Date.now();
    this.sql.exec(
      "DELETE FROM social_friend_grants WHERE uid = ? AND friend_handle = ?",
      uid,
      handle,
    );
    for (const grant of grants) {
      this.sql.exec(
        `INSERT OR REPLACE INTO social_friend_grants
          (uid, friend_handle, operation, scope_json, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        uid,
        handle,
        grant.operation,
        grant.scope ? JSON.stringify(grant.scope) : null,
        grant.expiresAt ?? null,
        now,
        now,
      );
    }
    return this.getFriendGrants(uid, handle);
  }

  toFriendSummary(friend: SocialFriendRecord): SocialContactSummary {
    const grants = this.getFriendGrants(friend.uid, friend.handle);
    return toFriendSummary(friend, grants);
  }

  listFriendPublicRecords<TRecord extends SpaceGsvRecord>(input: {
    uid: number;
    friendHandle: string;
    collection: SpaceGsvCollection;
    limit: number;
  }): SocialFriendPublicRecord<TRecord>[] {
    return this.sql.exec<FriendRecordRow>(
      `SELECT * FROM social_friend_records
       WHERE uid = ? AND friend_handle = ? AND collection = ?
       ORDER BY updated_at DESC
       LIMIT ?`,
      input.uid,
      input.friendHandle,
      input.collection,
      input.limit,
    ).toArray().map(toFriendPublicRecord<TRecord>);
  }

  replaceFriendPublicRecords<TRecord extends SpaceGsvRecord>(input: {
    uid: number;
    friendHandle: string;
    collection: SpaceGsvCollection;
    records: Array<{
      rkey: string;
      uri?: string;
      cid?: string;
      record: TRecord;
      createdAt?: number;
      updatedAt?: number;
    }>;
    now?: number;
  }): SocialFriendPublicRecord<TRecord>[] {
    const now = input.now ?? Date.now();
    this.sql.exec(
      "DELETE FROM social_friend_records WHERE uid = ? AND friend_handle = ? AND collection = ?",
      input.uid,
      input.friendHandle,
      input.collection,
    );
    for (const record of input.records) {
      this.sql.exec(
        `INSERT INTO social_friend_records
          (uid, friend_handle, collection, rkey, uri, cid, record_json, created_at, updated_at, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        input.uid,
        input.friendHandle,
        input.collection,
        record.rkey,
        record.uri ?? null,
        record.cid ?? null,
        JSON.stringify(record.record),
        record.createdAt ?? now,
        record.updatedAt ?? now,
        now,
      );
    }
    return this.listFriendPublicRecords<TRecord>({
      uid: input.uid,
      friendHandle: input.friendHandle,
      collection: input.collection,
      limit: Math.max(input.records.length, 1),
    });
  }

  pruneExpiredInboundReplays(uid: number, now: number): void {
    this.sql.exec(
      "DELETE FROM social_inbound_replays WHERE uid = ? AND expires_at <= ?",
      uid,
      now,
    );
  }

  hasInboundReplay(uid: number, envelopeId: string, nonce: string): boolean {
    const rows = this.sql.exec<InboundReplayRow>(
      "SELECT * FROM social_inbound_replays WHERE uid = ? AND (envelope_id = ? OR nonce = ?) LIMIT 1",
      uid,
      envelopeId,
      nonce,
    ).toArray();
    return rows.length > 0;
  }

  recordInboundReplay(input: {
    uid: number;
    envelopeId: string;
    nonce: string;
    fromHandle: string;
    method: SocialRemoteOperation;
    receivedAt: number;
    expiresAt: number;
  }): void {
    this.sql.exec(
      `INSERT INTO social_inbound_replays
        (uid, envelope_id, nonce, from_handle, method, received_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      input.uid,
      input.envelopeId,
      input.nonce,
      input.fromHandle,
      input.method,
      input.receivedAt,
      input.expiresAt,
    );
  }

  getThread(uid: number, threadId: string): SocialThreadRecord | null {
    const rows = this.sql.exec<ThreadRow>(
      "SELECT * FROM social_threads WHERE uid = ? AND thread_id = ? LIMIT 1",
      uid,
      threadId,
    ).toArray();
    return rows[0] ? toThreadRecord(rows[0]) : null;
  }

  listThreads(input: {
    uid: number;
    peerHandle?: string;
    status?: SocialThreadStatus;
    limit: number;
  }): SocialThreadRecord[] {
    let rows: ThreadRow[];
    if (input.peerHandle && input.status) {
      rows = this.sql.exec<ThreadRow>(
        "SELECT * FROM social_threads WHERE uid = ? AND peer_handle = ? AND status = ? ORDER BY updated_at DESC LIMIT ?",
        input.uid,
        input.peerHandle,
        input.status,
        input.limit,
      ).toArray();
    } else if (input.peerHandle) {
      rows = this.sql.exec<ThreadRow>(
        "SELECT * FROM social_threads WHERE uid = ? AND peer_handle = ? ORDER BY updated_at DESC LIMIT ?",
        input.uid,
        input.peerHandle,
        input.limit,
      ).toArray();
    } else if (input.status) {
      rows = this.sql.exec<ThreadRow>(
        "SELECT * FROM social_threads WHERE uid = ? AND status = ? ORDER BY updated_at DESC LIMIT ?",
        input.uid,
        input.status,
        input.limit,
      ).toArray();
    } else {
      rows = this.sql.exec<ThreadRow>(
        "SELECT * FROM social_threads WHERE uid = ? ORDER BY updated_at DESC LIMIT ?",
        input.uid,
        input.limit,
      ).toArray();
    }
    return rows.map(toThreadRecord);
  }

  upsertThread(input: {
    uid: number;
    threadId: string;
    peerHandle: string;
    status?: SocialThreadStatus;
    expiresAt?: string;
    now?: number;
  }): SocialThreadRecord {
    const existing = this.getThread(input.uid, input.threadId);
    const now = input.now ?? Date.now();
    const createdAt = existing?.createdAt ?? now;
    const status = input.status ?? existing?.status ?? "active";
    const expiresAt = input.expiresAt ?? existing?.expiresAt;
    const conversationId = existing?.conversationId ?? socialConversationId(input.peerHandle, input.threadId);
    this.sql.exec(
      `INSERT OR REPLACE INTO social_threads
        (uid, thread_id, peer_handle, conversation_id, status, created_at, updated_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      input.uid,
      input.threadId,
      input.peerHandle,
      conversationId,
      status,
      createdAt,
      now,
      expiresAt ?? null,
    );
    return {
      uid: input.uid,
      threadId: input.threadId,
      peerHandle: input.peerHandle,
      conversationId,
      status,
      createdAt,
      updatedAt: now,
      expiresAt,
    };
  }

  getMessage(uid: number, messageId: string): SocialMessageRecord | null {
    const rows = this.sql.exec<MessageRow>(
      "SELECT * FROM social_messages WHERE uid = ? AND message_id = ? LIMIT 1",
      uid,
      messageId,
    ).toArray();
    return rows[0] ? toMessageRecord(rows[0]) : null;
  }

  getMessageByRemoteEventId(uid: number, remoteEventId: string): SocialMessageRecord | null {
    const rows = this.sql.exec<MessageRow>(
      "SELECT * FROM social_messages WHERE uid = ? AND remote_event_id = ? LIMIT 1",
      uid,
      remoteEventId,
    ).toArray();
    return rows[0] ? toMessageRecord(rows[0]) : null;
  }

  listMessages(uid: number, threadId: string): SocialMessageRecord[] {
    return this.sql.exec<MessageRow>(
      "SELECT * FROM social_messages WHERE uid = ? AND thread_id = ? ORDER BY created_at ASC",
      uid,
      threadId,
    ).toArray().map(toMessageRecord);
  }

  upsertMessage(input: {
    uid: number;
    messageId: string;
    threadId: string;
    direction: SocialMessageDirection;
    fromHandle: string;
    toHandle: string;
    sender?: SocialMessageSender;
    text?: string;
    body?: unknown;
    deliveryMethod?: SocialRemoteOperation;
    deliveryStatus: SocialMessageSummary["deliveryStatus"];
    deliveryAttemptCount?: number;
    nextRetryAt?: number | null;
    retryScheduleId?: string | null;
    lastDeliveryError?: string | null;
    remoteEventId?: string;
    now?: number;
  }): SocialMessageRecord {
    const existing = this.getMessage(input.uid, input.messageId);
    const now = input.now ?? Date.now();
    const createdAt = existing?.createdAt ?? now;
    this.sql.exec(
      `INSERT OR REPLACE INTO social_messages
        (uid, message_id, thread_id, direction, from_handle, to_handle, text, body_json,
         sender_json, delivery_method, delivery_status, delivery_attempt_count,
         next_retry_at, retry_schedule_id, last_delivery_error, remote_event_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.uid,
      input.messageId,
      input.threadId,
      input.direction,
      input.fromHandle,
      input.toHandle,
      input.text ?? null,
      input.body === undefined
        ? existing?.body === undefined ? null : JSON.stringify(existing.body)
        : JSON.stringify(input.body),
      input.sender === undefined
        ? existing?.sender === undefined ? null : JSON.stringify(existing.sender)
        : JSON.stringify(input.sender),
      input.deliveryMethod ?? existing?.deliveryMethod ?? null,
      input.deliveryStatus,
      input.deliveryAttemptCount ?? existing?.deliveryAttemptCount ?? 0,
      input.nextRetryAt === undefined ? existing?.nextRetryAt ?? null : input.nextRetryAt,
      input.retryScheduleId === undefined ? existing?.retryScheduleId ?? null : input.retryScheduleId,
      input.lastDeliveryError === undefined ? existing?.lastDeliveryError ?? null : input.lastDeliveryError,
      input.remoteEventId ?? existing?.remoteEventId ?? null,
      createdAt,
      now,
    );
    return {
      uid: input.uid,
      messageId: input.messageId,
      threadId: input.threadId,
      direction: input.direction,
      fromHandle: input.fromHandle,
      toHandle: input.toHandle,
      sender: input.sender === undefined ? existing?.sender : input.sender,
      text: input.text,
      body: input.body === undefined ? existing?.body : input.body,
      deliveryMethod: input.deliveryMethod ?? existing?.deliveryMethod,
      deliveryStatus: input.deliveryStatus,
      deliveryAttemptCount: input.deliveryAttemptCount ?? existing?.deliveryAttemptCount ?? 0,
      nextRetryAt: input.nextRetryAt === undefined ? existing?.nextRetryAt : input.nextRetryAt ?? undefined,
      retryScheduleId: input.retryScheduleId === undefined ? existing?.retryScheduleId : input.retryScheduleId ?? undefined,
      lastDeliveryError: input.lastDeliveryError === undefined ? existing?.lastDeliveryError : input.lastDeliveryError ?? undefined,
      remoteEventId: input.remoteEventId ?? existing?.remoteEventId,
      createdAt,
      updatedAt: now,
    };
  }

  updateMessageDeliveryState(input: {
    uid: number;
    messageId: string;
    deliveryStatus: SocialMessageSummary["deliveryStatus"];
    deliveryAttemptCount: number;
    nextRetryAt?: number | null;
    retryScheduleId?: string | null;
    lastDeliveryError?: string | null;
    now?: number;
  }): SocialMessageRecord | null {
    const existing = this.getMessage(input.uid, input.messageId);
    if (!existing) {
      return null;
    }
    const now = input.now ?? Date.now();
    this.sql.exec(
      `UPDATE social_messages
          SET delivery_status = ?,
              delivery_attempt_count = ?,
              next_retry_at = ?,
              retry_schedule_id = ?,
              last_delivery_error = ?,
              updated_at = ?
        WHERE uid = ? AND message_id = ?`,
      input.deliveryStatus,
      input.deliveryAttemptCount,
      input.nextRetryAt ?? null,
      input.retryScheduleId ?? null,
      input.lastDeliveryError ?? null,
      now,
      input.uid,
      input.messageId,
    );
    return {
      ...existing,
      deliveryStatus: input.deliveryStatus,
      deliveryAttemptCount: input.deliveryAttemptCount,
      nextRetryAt: input.nextRetryAt ?? undefined,
      retryScheduleId: input.retryScheduleId ?? undefined,
      lastDeliveryError: input.lastDeliveryError ?? undefined,
      updatedAt: now,
    };
  }

  getMessageStatus(uid: number, messageId: string): SocialMessageStatusRecord | null {
    const rows = this.sql.exec<MessageStatusRow>(
      "SELECT * FROM social_message_statuses WHERE uid = ? AND message_id = ? LIMIT 1",
      uid,
      messageId,
    ).toArray();
    return rows[0] ? toMessageStatusRecord(rows[0]) : null;
  }

  getMessageStatusByRemoteEventId(uid: number, remoteEventId: string): SocialMessageStatusRecord | null {
    const rows = this.sql.exec<MessageStatusRow>(
      "SELECT * FROM social_message_statuses WHERE uid = ? AND remote_event_id = ? LIMIT 1",
      uid,
      remoteEventId,
    ).toArray();
    return rows[0] ? toMessageStatusRecord(rows[0]) : null;
  }

  listMessageStatuses(input: {
    uid: number;
    state?: SocialMessageStatusState;
    limit: number;
  }): SocialMessageStatusRecord[] {
    const rows = input.state
      ? this.sql.exec<MessageStatusRow>(
          "SELECT * FROM social_message_statuses WHERE uid = ? AND state = ? ORDER BY updated_at DESC LIMIT ?",
          input.uid,
          input.state,
          input.limit,
        ).toArray()
      : this.sql.exec<MessageStatusRow>(
          "SELECT * FROM social_message_statuses WHERE uid = ? ORDER BY updated_at DESC LIMIT ?",
          input.uid,
          input.limit,
        ).toArray();
    return rows.map(toMessageStatusRecord);
  }

  listMessageStatusesForThread(uid: number, threadId: string): SocialMessageStatusRecord[] {
    return this.sql.exec<MessageStatusRow>(
      "SELECT * FROM social_message_statuses WHERE uid = ? AND thread_id = ? ORDER BY updated_at ASC",
      uid,
      threadId,
    ).toArray().map(toMessageStatusRecord);
  }

  upsertMessageStatus(input: {
    uid: number;
    messageId: string;
    threadId: string;
    state: SocialMessageStatusState;
    summary?: string;
    needsHumanReason?: string;
    body?: unknown;
    remoteEventId?: string;
    now?: number;
  }): SocialMessageStatusRecord {
    const existing = this.getMessageStatus(input.uid, input.messageId);
    const now = input.now ?? Date.now();
    const createdAt = existing?.createdAt ?? now;
    this.sql.exec(
      `INSERT OR REPLACE INTO social_message_statuses
        (uid, message_id, thread_id, state, summary, needs_human_reason, body_json,
         remote_event_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.uid,
      input.messageId,
      input.threadId,
      input.state,
      input.summary ?? existing?.summary ?? null,
      input.needsHumanReason ?? existing?.needsHumanReason ?? null,
      input.body === undefined
        ? existing?.body === undefined ? null : JSON.stringify(existing.body)
        : JSON.stringify(input.body),
      input.remoteEventId ?? existing?.remoteEventId ?? null,
      createdAt,
      now,
    );
    return {
      uid: input.uid,
      messageId: input.messageId,
      threadId: input.threadId,
      state: input.state,
      summary: input.summary ?? existing?.summary,
      needsHumanReason: input.needsHumanReason ?? existing?.needsHumanReason,
      body: input.body === undefined ? existing?.body : input.body,
      remoteEventId: input.remoteEventId ?? existing?.remoteEventId,
      createdAt,
      updatedAt: now,
    };
  }

  recordDeliveryAttempt(input: {
    uid: number;
    messageId: string;
    status: SocialMessageSummary["deliveryStatus"];
    error?: string;
    now?: number;
  }): void {
    const now = input.now ?? Date.now();
    this.sql.exec(
      `INSERT INTO social_delivery_attempts
        (uid, attempt_id, message_id, status, error, attempted_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      input.uid,
      crypto.randomUUID(),
      input.messageId,
      input.status,
      input.error ?? null,
      now,
      now,
    );
  }

  toLocalIdentity(identity: SocialIdentityRecord): SocialLocalIdentity {
    return {
      uid: identity.uid,
      handle: identity.handle ?? handleFromDid(identity.did),
      pdsEndpoint: identity.pdsEndpoint,
      profile: this.getPublicRecord<SpaceGsvProfileRecord>(
        identity.uid,
        SPACE_GSV_PROFILE,
      )?.record,
      instance: this.getPublicRecord<SpaceGsvInstanceRecord>(
        identity.uid,
        SPACE_GSV_INSTANCE,
      )?.record,
    };
  }
}

export async function handleSocialSetup(
  args: SocialSetupArgs,
  ctx: KernelContext,
): Promise<SocialSetupResult> {
  const uid = requireMainSocialUserUid(ctx);
  const store = requireSocialStore(ctx);
  ensureInstanceIdentityOwner(store, uid);
  const origin = normalizePublicOrigin(args.origin, ctx.env);
  const handle = args.handle === undefined
    ? origin.hostname.toLowerCase()
    : normalizeHandle(args.handle, "handle");
  if (handle !== origin.hostname.toLowerCase() && !isGsvDevMode(ctx.env)) {
    throw new Error("social handle must match origin host");
  }
  const did = normalizeDid(`did:web:${handle}`);
  const existing = store.getIdentity(uid);
  if (existing && existing.did !== did) {
    throw new Error(`Social identity is already linked to ${existing.did}`);
  }

  const account = await requirePdsClient(ctx.env).ensureAccount({
    host: handle === origin.hostname.toLowerCase() ? origin.host : handle,
    handle,
    did,
    password: randomSetupPassword(),
  });
  if (account.did !== did) {
    throw new Error(`PDS account resolved to ${account.did}, expected ${did}`);
  }
  if (account.handle !== handle) {
    throw new Error(`PDS account returned handle ${account.handle}, expected ${handle}`);
  }

  const identity = store.upsertIdentity({
    uid,
    did,
    handle,
    pdsEndpoint: origin.origin,
  });
  const username = ctx.identity?.process.username ?? "GSV";
  const records = await publishBaselineSocialRecords(ctx, identity, {
    endpoint: origin.origin,
    profileDisplayName: args.displayName,
    profileDescription: args.description,
    fallbackDisplayName: username,
  });

  return {
    identity: store.toLocalIdentity(identity),
    createdAccount: account.created,
    records,
  };
}

export function handleSocialIdentityGet(
  _args: SocialIdentityGetArgs,
  ctx: KernelContext,
): SocialIdentityGetResult {
  const uid = requireSocialOwnerUid(ctx);
  const identity = requireSocialStore(ctx).getIdentity(uid);
  return {
    identity: identity ? requireSocialStore(ctx).toLocalIdentity(identity) : null,
  };
}

export function handleSocialIdentitySet(
  args: SocialIdentitySetArgs,
  ctx: KernelContext,
): SocialIdentitySetResult {
  const uid = requireMainSocialUserUid(ctx);
  const handle = normalizeHandle(args.handle, "handle");
  const did = normalizeDid(`did:web:${handle}`);
  const pdsEndpoint = normalizePdsEndpoint(args.pdsEndpoint, ctx.env);
  const store = requireSocialStore(ctx);
  ensureInstanceIdentityOwner(store, uid);
  const existing = store.getIdentity(uid);
  if (existing && existing.did !== did) {
    throw new Error(`Social identity is already linked to ${existing.did}`);
  }
  const identity = store.upsertIdentity({
    uid,
    did,
    handle,
    pdsEndpoint,
  });
  return {
    identity: store.toLocalIdentity(identity),
  };
}

export async function handleSocialIdentityRepublish(
  _args: SocialIdentityRepublishArgs,
  ctx: KernelContext,
): Promise<SocialIdentityRepublishResult> {
  const uid = requireMainSocialUserUid(ctx);
  const store = requireSocialStore(ctx);
  const identity = requireWritableSocialIdentity(ctx);
  const profile = store.getPublicRecord<SpaceGsvProfileRecord>(
    uid,
    SPACE_GSV_PROFILE,
  )?.record;
  const username = ctx.identity?.process.username ?? "GSV";
  const records = await publishBaselineSocialRecords(ctx, identity, {
    endpoint: identity.pdsEndpoint,
    profile,
    fallbackDisplayName: username,
  });
  return {
    identity: store.toLocalIdentity(identity),
    records,
  };
}

export function handleSocialProfileGet(
  args: SocialProfileGetArgs,
  ctx: KernelContext,
): SocialProfileGetResult {
  const resolved = resolveReadableIdentity(args.handle, ctx);
  return {
    profile: resolved
      ? requireSocialStore(ctx).getPublicRecord<SpaceGsvProfileRecord>(
          resolved.uid,
          SPACE_GSV_PROFILE,
        )?.record ?? null
      : null,
  };
}

export async function handleSocialProfileUpdate(
  args: SocialProfileUpdateArgs,
  ctx: KernelContext,
): Promise<SocialProfileUpdateResult> {
  const identity = requireWritableSocialIdentity(ctx);
  const record = validateProfileRecord(args.record);
  const result = await publishSelfRecord(ctx, identity, SPACE_GSV_PROFILE, record);
  return {
    record: result.record,
    uri: result.uri as SocialAtUri | undefined,
  };
}

export function handleSocialInstanceGet(
  args: SocialInstanceGetArgs,
  ctx: KernelContext,
): SocialInstanceGetResult {
  const resolved = resolveReadableIdentity(args.handle, ctx);
  return {
    instance: resolved
      ? requireSocialStore(ctx).getPublicRecord<SpaceGsvInstanceRecord>(
          resolved.uid,
          SPACE_GSV_INSTANCE,
        )?.record ?? null
      : null,
  };
}

export async function handleSocialInstanceUpdate(
  args: SocialInstanceUpdateArgs,
  ctx: KernelContext,
): Promise<SocialInstanceUpdateResult> {
  const identity = requireWritableSocialIdentity(ctx);
  const record = validateInstanceRecord(args.record);
  const result = await publishSelfRecord(ctx, identity, SPACE_GSV_INSTANCE, record);
  return {
    record: result.record,
    uri: result.uri as SocialAtUri | undefined,
  };
}

export function handleSocialContactList(
  _args: SocialContactListArgs,
  ctx: KernelContext,
): SocialContactListResult {
  const uid = requireSocialOwnerUid(ctx);
  const store = requireSocialStore(ctx);
  return {
    contacts: store.listFriends(uid).map((friend) => store.toFriendSummary(friend)),
  };
}

export async function handleSocialContactAdd(
  args: SocialContactAddArgs,
  ctx: KernelContext,
): Promise<SocialContactAddResult> {
  const uid = requireMainSocialUserUid(ctx);
  const identity = requireWritableSocialIdentity(ctx);
  const handle = normalizeHandle(args.handle, "handle");
  if (identity.handle === handle) {
    throw new Error("Cannot add the local GSV identity as a contact");
  }
  const note = normalizeFriendNote(args.note);
  const grants = args.grants === undefined ? undefined : validateGrants(args.grants);
  const publicIdentity = await resolveFriendPublicIdentity(handle, ctx.env);
  const displayName = nonEmpty(args.displayName)
    ?? nonEmpty(publicIdentity.profile?.displayName)
    ?? handle;
  const store = requireSocialStore(ctx);
  const { friend, created } = store.upsertFriend({
    uid,
    handle,
    did: publicIdentity.did,
    pdsEndpoint: publicIdentity.instance.endpoint,
    note,
    displayName,
    profile: publicIdentity.profile,
    instance: publicIdentity.instance,
  });
  if (grants !== undefined) {
    store.replaceFriendGrants(uid, handle, grants);
  }
  return {
    contact: store.toFriendSummary(friend),
    created,
  };
}

export function handleSocialContactRemove(
  args: SocialContactRemoveArgs,
  ctx: KernelContext,
): SocialContactRemoveResult {
  const uid = requireMainSocialUserUid(ctx);
  const handle = normalizeHandle(args.handle, "handle");
  return {
    removed: requireSocialStore(ctx).removeFriend(uid, handle),
  };
}

export function handleSocialContactGrantsSet(
  args: SocialContactGrantsSetArgs,
  ctx: KernelContext,
): SocialContactGrantsSetResult {
  const uid = requireMainSocialUserUid(ctx);
  const handle = normalizeHandle(args.handle, "handle");
  const grants = validateGrants(args.grants);
  const store = requireSocialStore(ctx);
  const friend = store.getFriend(uid, handle);
  if (!friend) {
    throw new Error(`Contact is not known: ${handle}`);
  }
  store.replaceFriendGrants(uid, handle, grants);
  return {
    contact: store.toFriendSummary(friend),
  };
}

export async function handleSocialUserList(
  args: SocialUserListArgs,
  ctx: KernelContext,
): Promise<SocialUserListResult> {
  const uid = requireSocialOwnerUid(ctx);
  const store = requireSocialStore(ctx);
  const limit = normalizeLimit(args.limit, 50);
  if (args.handle === undefined) {
    const published = store.listPublicRecords<SpaceGsvUserRecord>(uid, SPACE_GSV_USER, limit);
    const records = published.length > 0
      ? published
      : listLocalSocialUsers(ctx).slice(0, limit).map((user) => ({
          uid,
          collection: SPACE_GSV_USER,
          rkey: user.username,
          uri: undefined,
          cid: undefined,
          record: compactRecord({
            $type: SPACE_GSV_USER,
            createdAt: new Date().toISOString(),
            username: user.username,
            displayName: user.displayName,
            acceptsContact: true,
          }) as SpaceGsvUserRecord,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }));
    const handle = requireLocalHandle(requireWritableSocialIdentity(ctx));
    return {
      users: records.map((entry) => ({
        handle,
        uri: entry.uri as SocialAtUri | undefined,
        record: entry.record,
      })),
    };
  }

  const handle = normalizeHandle(args.handle, "handle");
  const friend = requireFriend(store, uid, handle);
  requireRemoteMethod(friend, "social.user.read");
  const records = await syncFriendPublicRecords<SpaceGsvUserRecord>({
    ctx,
    store,
    uid,
    friend,
    collection: SPACE_GSV_USER,
    limit,
    validate: validateUserRecord,
  });
  return {
    users: records.map((entry) => ({
      handle,
      uri: entry.uri as SocialAtUri | undefined,
      record: entry.record,
    })),
  };
}

export async function handleSocialContactPublicList(
  args: SocialContactPublicListArgs,
  ctx: KernelContext,
): Promise<SocialContactPublicListResult> {
  const contacts = await listSocialPublicRecords<SpaceGsvContactRecord>({
    args,
    ctx,
    collection: SPACE_GSV_CONTACT,
    method: "social.contact.read",
    validate: validateContactRecord,
  });
  return { contacts };
}

export async function handleSocialContactPublish(
  args: SocialContactPublishArgs,
  ctx: KernelContext,
): Promise<SocialContactPublishResult> {
  const now = new Date().toISOString();
  const record = validateContactRecord(compactRecord({
    ...args.record,
    $type: SPACE_GSV_CONTACT,
    createdAt: args.record.createdAt ?? now,
    updatedAt: now,
  }));
  const rkey = normalizeOptionalRkey(args.rkey) ?? contactRkey(record);
  const published = await publishSelfRecord(ctx, requireWritableSocialIdentity(ctx), SPACE_GSV_CONTACT, record, rkey);
  return { record: published.record, uri: published.uri as SocialAtUri | undefined };
}

export async function handleSocialContactUnpublish(
  args: SocialContactUnpublishArgs,
  ctx: KernelContext,
): Promise<SocialContactUnpublishResult> {
  return deleteSelfPublicRecord(ctx, SPACE_GSV_CONTACT, args.uri, "contact record");
}

export async function handleSocialPackageList(
  args: SocialPackageListArgs,
  ctx: KernelContext,
): Promise<SocialPackageListResult> {
  const packages = await listSocialPublicRecords<SpaceGsvPackageRecord>({
    args,
    ctx,
    collection: SPACE_GSV_PACKAGE,
    method: "social.package.read",
    validate: validatePackageRecord,
  });
  return { packages };
}

export async function handleSocialPackageReleaseList(
  args: SocialPackageReleaseListArgs,
  ctx: KernelContext,
): Promise<SocialPackageReleaseListResult> {
  const releases = await listSocialPublicRecords<SpaceGsvPackageReleaseRecord>({
    args,
    ctx,
    collection: SPACE_GSV_PACKAGE_RELEASE,
    method: "social.package.release.read",
    validate: validatePackageReleaseRecord,
  });
  return {
    releases: args.packageUri
      ? releases.filter((entry) => entry.record.package.uri === args.packageUri)
      : releases,
  };
}

export async function handleSocialVouchCreate(
  args: SocialVouchCreateArgs,
  ctx: KernelContext,
): Promise<SocialVouchCreateResult> {
  const now = new Date().toISOString();
  const record = validateVouchRecord(compactRecord({
    ...args.record,
    $type: SPACE_GSV_VOUCH,
    createdAt: args.record.createdAt ?? now,
    updatedAt: now,
  }));
  const rkey = normalizeOptionalRkey(args.rkey) ?? newSocialId("vouch");
  const published = await publishSelfRecord(ctx, requireWritableSocialIdentity(ctx), SPACE_GSV_VOUCH, record, rkey);
  return { record: published.record, uri: published.uri as SocialAtUri | undefined };
}

export async function handleSocialVouchDelete(
  args: SocialVouchDeleteArgs,
  ctx: KernelContext,
): Promise<SocialVouchDeleteResult> {
  return deleteSelfPublicRecord(ctx, SPACE_GSV_VOUCH, args.uri, "vouch");
}

export async function handleSocialVouchList(
  args: SocialVouchListArgs,
  ctx: KernelContext,
): Promise<SocialVouchListResult> {
  const vouches = await listSocialPublicRecords<SpaceGsvVouchRecord>({
    args,
    ctx,
    collection: SPACE_GSV_VOUCH,
    method: "social.vouch.read",
    validate: validateVouchRecord,
  });
  return { vouches };
}

export async function handleSocialNewsCreate(
  args: SocialNewsCreateArgs,
  ctx: KernelContext,
): Promise<SocialNewsCreateResult> {
  const now = new Date().toISOString();
  const record = validateNewsRecord(compactRecord({
    ...args.record,
    $type: SPACE_GSV_NEWS,
    createdAt: args.record.createdAt ?? now,
    updatedAt: now,
  }));
  const rkey = normalizeOptionalRkey(args.rkey) ?? newSocialId("news");
  const published = await publishSelfRecord(ctx, requireWritableSocialIdentity(ctx), SPACE_GSV_NEWS, record, rkey);
  return { record: published.record, uri: published.uri as SocialAtUri | undefined };
}

export async function handleSocialNewsDelete(
  args: SocialNewsDeleteArgs,
  ctx: KernelContext,
): Promise<SocialNewsDeleteResult> {
  return deleteSelfPublicRecord(ctx, SPACE_GSV_NEWS, args.uri, "news");
}

export async function handleSocialNewsList(
  args: SocialNewsListArgs,
  ctx: KernelContext,
): Promise<SocialNewsListResult> {
  const news = await listSocialPublicRecords<SpaceGsvNewsRecord>({
    args,
    ctx,
    collection: SPACE_GSV_NEWS,
    method: "social.news.read",
    validate: validateNewsRecord,
  });
  return { news };
}

export async function syncPublicPackageSocialRecordsForRepo(
  ctx: KernelContext,
  repo: string,
  isPublic: boolean,
): Promise<SocialAtUri[]> {
  if (!ctx.social) {
    return [];
  }
  const identity = ctx.social.getIdentity(MAIN_SOCIAL_UID);
  if (!identity) {
    return [];
  }
  const records = ctx.packages.list({})
    .filter((pkg) => pkg.manifest.source.repo === repo);
  const uris: SocialAtUri[] = [];
  for (const pkg of records) {
    const rkey = packageRecordRkey(pkg);
    if (!isPublic) {
      await deletePublicPackageRecordIfPresent(ctx, identity, rkey);
      continue;
    }
    const published = await publishPackageRecord(ctx, identity, pkg, rkey);
    if (published.uri) {
      uris.push(published.uri as SocialAtUri);
    }
  }
  return uris;
}

export async function handleSocialThreadCreate(
  args: SocialThreadCreateArgs,
  ctx: KernelContext,
): Promise<SocialThreadCreateResult> {
  const uid = requireSocialOwnerUid(ctx);
  const localIdentity = requireWritableSocialIdentity(ctx);
  const localHandle = requireLocalHandle(localIdentity);
  const sender = socialSenderForCaller(ctx);
  const peerHandle = normalizeHandle(args.peerHandle, "peerHandle");
  const store = requireSocialStore(ctx);
  const friend = requireFriend(store, uid, peerHandle);
  requireRemoteMethod(friend, "social.thread.create");
  if (args.expiresAt !== undefined) {
    requireIsoString(args.expiresAt, "expiresAt");
  }

  const thread = store.upsertThread({
    uid,
    threadId: newSocialId("thread"),
    peerHandle,
    expiresAt: args.expiresAt,
  });

  let initialMessage: SocialMessageRecord | undefined;
  if (args.initialMessage !== undefined) {
    const text = normalizeMessageText(args.initialMessage, "initialMessage");
    initialMessage = store.upsertMessage({
      uid,
      messageId: newSocialId("msg"),
      threadId: thread.threadId,
      direction: "outbound",
      fromHandle: localHandle,
      toHandle: peerHandle,
      sender,
      text,
      deliveryMethod: "social.thread.create",
      deliveryStatus: "queued",
    });
    initialMessage = await attemptOutboundDelivery({
      ctx,
      store,
      localIdentity,
      friend,
      thread,
      message: initialMessage,
      method: "social.thread.create",
    });
  }

  return {
    thread: toThreadSummary(thread),
    initialMessage: initialMessage ? toMessageSummary(initialMessage) : undefined,
  };
}

export function handleSocialThreadList(
  args: SocialThreadListArgs,
  ctx: KernelContext,
): SocialThreadListResult {
  const uid = requireSocialOwnerUid(ctx);
  const store = requireSocialStore(ctx);
  return {
    threads: store.listThreads({
      uid,
      peerHandle: args.peerHandle === undefined ? undefined : normalizeHandle(args.peerHandle, "peerHandle"),
      status: args.status === undefined ? undefined : normalizeThreadStatus(args.status, "status"),
      limit: normalizeLimit(args.limit, 50),
    }).map(toThreadSummary),
  };
}

export function handleSocialThreadGet(
  args: SocialThreadGetArgs,
  ctx: KernelContext,
): SocialThreadGetResult {
  const uid = requireSocialOwnerUid(ctx);
  const threadId = normalizeSocialId(args.threadId, "threadId");
  const store = requireSocialStore(ctx);
  const thread = store.getThread(uid, threadId);
  return {
    thread: thread ? toThreadSummary(thread) : null,
    messages: thread ? store.listMessages(uid, threadId).map(toMessageSummary) : [],
    statuses: thread ? summarizeMessageStatusesForThread(store, uid, threadId) : [],
  };
}

export async function handleSocialMessageSend(
  args: SocialMessageSendArgs,
  ctx: KernelContext,
): Promise<SocialMessageSendResult> {
  const uid = requireSocialOwnerUid(ctx);
  const localIdentity = requireWritableSocialIdentity(ctx);
  const localHandle = requireLocalHandle(localIdentity);
  const sender = socialSenderForCaller(ctx);
  const toHandle = normalizeHandle(args.toHandle, "toHandle");
  const store = requireSocialStore(ctx);
  const friend = requireFriend(store, uid, toHandle);
  requireRemoteMethod(friend, "social.message.send");
  if (args.expiresAt !== undefined) {
    requireIsoString(args.expiresAt, "expiresAt");
  }

  const thread = args.threadId === undefined
    ? store.upsertThread({
        uid,
        threadId: newSocialId("thread"),
        peerHandle: toHandle,
        expiresAt: args.expiresAt,
    })
    : requireExistingThread(store, uid, args.threadId, toHandle);
  const messageInput = normalizeMessagePayload(args, "message");
  const message = store.upsertMessage({
    uid,
    messageId: newSocialId("msg"),
    threadId: thread.threadId,
    direction: "outbound",
    fromHandle: localHandle,
    toHandle,
    sender,
    text: messageInput.text,
    body: messageInput.body,
    deliveryMethod: "social.message.send",
    deliveryStatus: "queued",
  });
  const delivered = await attemptOutboundDelivery({
    ctx,
    store,
    localIdentity,
    friend,
    thread,
    message,
    method: "social.message.send",
  });

  return {
    thread: toThreadSummary(thread),
    message: toMessageSummary(delivered),
  };
}

export function handleSocialMessageStatusList(
  args: SocialMessageStatusListArgs,
  ctx: KernelContext,
): SocialMessageStatusListResult {
  const uid = requireSocialOwnerUid(ctx);
  const store = requireSocialStore(ctx);
  const peerHandle = args.peerHandle === undefined ? undefined : normalizeHandle(args.peerHandle, "peerHandle");
  const direction = args.direction === undefined || args.direction === "all"
    ? undefined
    : normalizeMessageDirection(args.direction, "direction");
  const statuses = store.listMessageStatuses({
    uid,
    state: args.state === undefined ? undefined : normalizeMessageStatusState(args.state, "state"),
    limit: normalizeLimit(args.limit, 100),
  });
  return {
    statuses: statuses.flatMap((status) => {
      const message = store.getMessage(uid, status.messageId);
      if (!message) {
        return [];
      }
      if (peerHandle && message.fromHandle !== peerHandle && message.toHandle !== peerHandle) {
        return [];
      }
      if (direction && message.direction !== direction) {
        return [];
      }
      return [toMessageStatusSummary(status, message)];
    }),
  };
}

export function handleSocialMessageStatusGet(
  args: SocialMessageStatusGetArgs,
  ctx: KernelContext,
): SocialMessageStatusGetResult {
  const uid = requireSocialOwnerUid(ctx);
  const messageId = normalizeSocialId(args.messageId, "messageId");
  const store = requireSocialStore(ctx);
  const status = store.getMessageStatus(uid, messageId);
  const message = status ? store.getMessage(uid, status.messageId) : null;
  return {
    status: status && message ? toMessageStatusSummary(status, message) : null,
  };
}

export async function handleSocialMessageStatusUpdate(
  args: SocialMessageStatusUpdateArgs,
  ctx: KernelContext,
): Promise<SocialMessageStatusUpdateResult> {
  const uid = requireSocialOwnerUid(ctx);
  const localIdentity = requireWritableSocialIdentity(ctx);
  const localHandle = requireLocalHandle(localIdentity);
  const messageId = normalizeSocialId(args.messageId, "messageId");
  const state = normalizeMessageStatusState(args.state, "state");
  const summary = args.summary === undefined ? undefined : normalizeOptionalText(args.summary, "summary", 2048);
  const needsHumanReason = args.needsHumanReason === undefined
    ? undefined
    : normalizeOptionalText(args.needsHumanReason, "needsHumanReason", 2048);
  const body = args.body === undefined ? undefined : normalizeSocialBody(args.body, "body");
  const store = requireSocialStore(ctx);
  const message = store.getMessage(uid, messageId);
  if (!message) {
    throw new Error(`Message is not known: ${messageId}`);
  }
  const previousStatus = store.getMessageStatus(uid, messageId);
  const status = store.upsertMessageStatus({
    uid,
    messageId,
    threadId: message.threadId,
    state,
    summary,
    needsHumanReason,
    body,
  });
  notifyMessageStatusTransition(ctx, message, previousStatus, status);
  await deliverNeedsHumanToInitSafe(ctx, message, previousStatus, status);

  if (message.direction === "inbound") {
    const peerHandle = message.fromHandle === localHandle ? message.toHandle : message.fromHandle;
    const friend = requireFriend(store, uid, peerHandle);
    if (friend.instance.acceptedSocialMethods.includes("social.message.status.update")) {
      await sendMessageStatusUpdateEnvelope({
        ctx,
        store,
        localIdentity,
        friend,
        status,
        message,
      });
    }
  }

  await refreshSocialInboxContextSafe(ctx, store);

  return {
    status: toMessageStatusSummary(status, message),
  };
}

export async function handleSocialInbound(
  args: SocialInboundArgs,
  ctx: KernelContext,
): Promise<SocialInboundResult> {
  if (ctx.identity?.role !== "service") {
    return rejectInbound("social.inbound is service-only");
  }

  const store = requireSocialStore(ctx);
  const localIdentity = store.getIdentity(MAIN_SOCIAL_UID);
  if (!localIdentity) {
    return rejectInbound("Local social identity is not linked");
  }

  let envelope: SocialSignedRequestEnvelope;
  try {
    envelope = normalizeSignedEnvelope(args.envelope);
  } catch (error) {
    return rejectInbound(error instanceof Error ? error.message : String(error));
  }
  const now = args.receivedAt ? Date.parse(args.receivedAt) : Date.now();
  if (!Number.isFinite(now)) {
    return rejectInbound("receivedAt must be an ISO date string");
  }

  const expiresAt = Date.parse(envelope.expiresAt);
  if (expiresAt <= now) {
    return rejectInbound("Envelope expired");
  }
  if (envelope.toDid !== localIdentity.did) {
    return rejectInbound("Envelope recipient does not match local identity");
  }

  const friend = store.getFriendByDid(MAIN_SOCIAL_UID, envelope.fromDid);
  if (!friend) {
    return rejectInbound("Unknown sender");
  }

  let publicIdentity: { did: SocialDid; instance: SpaceGsvInstanceRecord };
  try {
    publicIdentity = await resolveFriendServiceIdentity(friend.handle, ctx.env);
  } catch (error) {
    return rejectInbound(error instanceof Error ? error.message : String(error));
  }
  if (publicIdentity.did !== envelope.fromDid) {
    return rejectInbound("Sender handle no longer resolves to envelope DID");
  }
  if (publicIdentity.instance.serviceKey.id !== envelope.keyId) {
    return rejectInbound("Envelope key does not match sender service key");
  }
  if (!SOCIAL_INBOUND_METHODS.has(envelope.method)) {
    return rejectInbound(`Inbound method is not implemented: ${envelope.method}`);
  }

  const grant = store.getFriendGrants(MAIN_SOCIAL_UID, friend.handle)
    .find((candidate) => candidate.operation === envelope.method);
  if (!grant) {
    return rejectInbound(`Missing grant for ${envelope.method}`);
  }
  if (grant.expiresAt && Date.parse(grant.expiresAt) <= now) {
    return rejectInbound(`Grant expired for ${envelope.method}`);
  }

  store.pruneExpiredInboundReplays(MAIN_SOCIAL_UID, now);

  const verified = await verifySocialEnvelopeSignature(
    envelope,
    publicIdentity.instance.serviceKey.publicKeyMultibase,
  );
  if (!verified) {
    return rejectInbound("Invalid envelope signature");
  }

  if (store.hasInboundReplay(MAIN_SOCIAL_UID, envelope.id, envelope.nonce)) {
    const existing = store.getMessageByRemoteEventId(MAIN_SOCIAL_UID, envelope.id);
    if (existing) {
      return {
        ok: true,
        status: "accepted",
        threadId: existing.threadId,
        messageId: existing.messageId,
      };
    }
    return rejectInbound("Envelope replayed");
  }

  let accepted: SocialInboundResult;
  try {
    accepted = await acceptInboundSocialEnvelope({
      ctx,
      store,
      localIdentity,
      friend,
      envelope,
      now,
    });
  } catch (error) {
    return rejectInbound(error instanceof Error ? error.message : String(error));
  }

  store.recordInboundReplay({
    uid: MAIN_SOCIAL_UID,
    envelopeId: envelope.id,
    nonce: envelope.nonce,
    fromHandle: friend.handle,
    method: envelope.method,
    receivedAt: now,
    expiresAt,
  });

  return accepted;
}

export async function handleSocialDeliveryRetry(
  input: { messageId: string; retryScheduleId?: string | null },
  ctx: KernelContext,
): Promise<SocialDeliveryRetryResult> {
  const store = requireSocialStore(ctx);
  const messageId = normalizeSocialId(input.messageId, "messageId");
  const message = store.getMessage(MAIN_SOCIAL_UID, messageId);
  if (!message) {
    return { retried: false, reason: "message not found" };
  }
  if (message.direction !== "outbound") {
    return { retried: false, reason: "message is not outbound" };
  }
  if (message.deliveryStatus !== "retrying") {
    return { retried: false, reason: `message status is ${message.deliveryStatus}` };
  }
  if (
    input.retryScheduleId &&
    message.retryScheduleId &&
    input.retryScheduleId !== message.retryScheduleId
  ) {
    return { retried: false, reason: "stale retry schedule" };
  }
  if (message.nextRetryAt !== undefined && message.nextRetryAt > Date.now()) {
    return { retried: false, reason: "message retry is not due" };
  }

  const localIdentity = store.getIdentity(MAIN_SOCIAL_UID);
  if (!localIdentity) {
    return { retried: false, reason: "local social identity is not linked" };
  }
  const thread = store.getThread(MAIN_SOCIAL_UID, message.threadId);
  if (!thread) {
    return { retried: false, reason: "thread not found" };
  }
  const friend = store.getFriend(MAIN_SOCIAL_UID, message.toHandle);
  if (!friend) {
    return { retried: false, reason: "contact not found" };
  }
  const method = message.deliveryMethod ?? inferDeliveryMethod(message);
  const retried = await attemptOutboundDelivery({
    ctx,
    store,
    localIdentity,
    friend,
    thread,
    message,
    method,
  });
  return {
    retried: true,
    message: toMessageSummary(retried),
  };
}

type NormalizedMessagePayload = {
  text?: string;
  body?: unknown;
};

type InboundMessageBody = NormalizedMessagePayload & {
  threadId?: string;
  messageId?: string;
  sender?: SocialMessageSender;
  expiresAt?: string;
};

type InboundMessageStatusUpdateBody = {
  threadId?: string;
  messageId: string;
  state: SocialMessageStatusState;
  summary?: string;
  needsHumanReason?: string;
  body?: unknown;
};

async function attemptOutboundDelivery(input: {
  ctx: KernelContext;
  store: SocialStore;
  localIdentity: SocialIdentityRecord;
  friend: SocialFriendRecord;
  thread: SocialThreadRecord;
  message: SocialMessageRecord;
  method: SocialRemoteOperation;
  bodyOverride?: Record<string, unknown>;
}): Promise<SocialMessageRecord> {
  const settings = await ensureServiceSettings(input.store, input.localIdentity.uid);
  const createdAt = new Date().toISOString();
  const envelope = await signSocialEnvelope({
    id: newSocialId("env"),
    method: input.method,
    fromDid: input.localIdentity.did,
    toDid: input.friend.did,
    createdAt,
    expiresAt: new Date(Date.parse(createdAt) + SOCIAL_ENVELOPE_TTL_MS).toISOString(),
    nonce: newSocialId("nonce"),
    keyId: `${input.localIdentity.did}#gsv-social-key`,
    body: input.bodyOverride ?? compactRecord({
      threadId: input.thread.threadId,
      messageId: input.message.messageId,
      sender: input.message.sender,
      text: input.message.text,
      body: input.message.body,
      expiresAt: input.thread.expiresAt,
    }),
  }, settings.servicePrivateJwk);

  let status: SocialMessageSummary["deliveryStatus"] = "failed";
  let error: string | undefined;
  let retryable = false;
  try {
    const response = await fetch(new URL("/social/inbound", input.friend.pdsEndpoint).toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ envelope }),
    });
    const responseBody = await parseFetchBody(response);
    const accepted = responseBody && typeof responseBody === "object"
      && (responseBody as { ok?: unknown }).ok === true;
    if (response.ok && accepted) {
      status = "accepted";
    } else {
      retryable = response.status >= 500 || response.status === 429;
      status = retryable ? "retrying" : "failed";
      error = `remote status=${response.status}: ${formatFetchBody(responseBody)}`;
    }
  } catch (caught) {
    status = "retrying";
    retryable = true;
    error = caught instanceof Error ? caught.message : String(caught);
  }

  const attemptCount = input.message.deliveryAttemptCount + 1;
  let nextRetryAt: number | null = null;
  let retryScheduleId: string | null = null;
  if (status === "retrying") {
    const retryPlan = await scheduleDeliveryRetry({
      ctx: input.ctx,
      messageId: input.message.messageId,
      attemptCount,
      retryable,
    });
    status = retryPlan.status;
    nextRetryAt = retryPlan.nextRetryAt;
    retryScheduleId = retryPlan.retryScheduleId;
  }

  input.store.recordDeliveryAttempt({
    uid: input.localIdentity.uid,
    messageId: input.message.messageId,
    status,
    error,
  });
  return input.store.updateMessageDeliveryState({
    uid: input.localIdentity.uid,
    messageId: input.message.messageId,
    deliveryStatus: status,
    deliveryAttemptCount: attemptCount,
    nextRetryAt,
    retryScheduleId,
    lastDeliveryError: error ?? null,
  }) ?? input.message;
}

async function sendMessageStatusUpdateEnvelope(input: {
  ctx: KernelContext;
  store: SocialStore;
  localIdentity: SocialIdentityRecord;
  friend: SocialFriendRecord;
  status: SocialMessageStatusRecord;
  message: SocialMessageRecord;
}): Promise<void> {
  const settings = await ensureServiceSettings(input.store, input.localIdentity.uid);
  const createdAt = new Date().toISOString();
  const envelope = await signSocialEnvelope({
    id: newSocialId("env"),
    method: "social.message.status.update",
    fromDid: input.localIdentity.did,
    toDid: input.friend.did,
    createdAt,
    expiresAt: new Date(Date.parse(createdAt) + SOCIAL_ENVELOPE_TTL_MS).toISOString(),
    nonce: newSocialId("nonce"),
    keyId: `${input.localIdentity.did}#gsv-social-key`,
    body: compactRecord({
      threadId: input.message.threadId,
      messageId: input.message.messageId,
      state: input.status.state,
      summary: input.status.summary,
      needsHumanReason: input.status.needsHumanReason,
      body: input.status.body,
    }),
  }, settings.servicePrivateJwk);

  const response = await fetch(new URL("/social/inbound", input.friend.pdsEndpoint).toString(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ envelope }),
  });
  const responseBody = await parseFetchBody(response);
  const accepted = responseBody && typeof responseBody === "object"
    && (responseBody as { ok?: unknown }).ok === true;
  if (!response.ok || !accepted) {
    throw new Error(`remote status=${response.status}: ${formatFetchBody(responseBody)}`);
  }
}

async function scheduleDeliveryRetry(input: {
  ctx: KernelContext;
  messageId: string;
  attemptCount: number;
  retryable: boolean;
}): Promise<{
  status: SocialMessageSummary["deliveryStatus"];
  nextRetryAt: number | null;
  retryScheduleId: string | null;
}> {
  if (!input.retryable || input.attemptCount >= SOCIAL_MAX_DELIVERY_ATTEMPTS) {
    return { status: "failed", nextRetryAt: null, retryScheduleId: null };
  }

  const delayMs = SOCIAL_DELIVERY_RETRY_DELAYS_MS[input.attemptCount - 1];
  const nextRetryAt = Date.now() + delayMs;
  const retryScheduleId = input.ctx.scheduleSocialDeliveryRetry
    ? await input.ctx.scheduleSocialDeliveryRetry(input.messageId, nextRetryAt)
    : null;
  return {
    status: "retrying",
    nextRetryAt,
    retryScheduleId,
  };
}

async function acceptInboundSocialEnvelope(input: {
  ctx: KernelContext;
  store: SocialStore;
  localIdentity: SocialIdentityRecord;
  friend: SocialFriendRecord;
  envelope: SocialSignedRequestEnvelope;
  now: number;
}): Promise<SocialInboundResult> {
  if (input.envelope.method === "social.message.status.update") {
    return acceptInboundMessageStatusUpdate(input);
  }
  if (
    input.envelope.method !== "social.thread.create" &&
    input.envelope.method !== "social.message.send"
  ) {
    throw new Error(`Inbound method is not implemented: ${input.envelope.method}`);
  }

  const existing = input.store.getMessageByRemoteEventId(MAIN_SOCIAL_UID, input.envelope.id);
  if (existing) {
    return {
      ok: true,
      status: "accepted",
      threadId: existing.threadId,
      messageId: existing.messageId,
    };
  }

  const body = normalizeInboundMessageBody(input.envelope.body);
  const threadId = body.threadId ?? newSocialId("thread");
  const thread = input.store.upsertThread({
    uid: MAIN_SOCIAL_UID,
    threadId,
    peerHandle: input.friend.handle,
    expiresAt: body.expiresAt,
    now: input.now,
  });
  const messageId = body.messageId ?? newSocialId("msg");
  const existingMessage = input.store.getMessage(MAIN_SOCIAL_UID, messageId);
  if (existingMessage) {
    return {
      ok: true,
      status: "accepted",
      threadId: existingMessage.threadId,
      messageId: existingMessage.messageId,
    };
  }

  const localHandle = requireLocalHandle(input.localIdentity);
  const message = input.store.upsertMessage({
    uid: MAIN_SOCIAL_UID,
    messageId,
    threadId: thread.threadId,
    direction: "inbound",
    fromHandle: input.friend.handle,
    toHandle: localHandle,
    sender: body.sender,
    text: body.text,
    body: body.body,
    deliveryMethod: input.envelope.method,
    deliveryStatus: "delivered",
    remoteEventId: input.envelope.id,
    now: input.now,
  });
  input.store.upsertMessageStatus({
    uid: MAIN_SOCIAL_UID,
    messageId: message.messageId,
    threadId: thread.threadId,
    state: "received",
    remoteEventId: input.envelope.id,
    now: input.now,
  });

  try {
    await deliverInboundMessageToMind(input.ctx, input.friend, thread, message);
  } catch (error) {
    console.error("[social.inbound] failed to deliver message to mind process", error);
  }

  return {
    ok: true,
    status: "accepted",
    threadId: thread.threadId,
    messageId: message.messageId,
  };
}

async function acceptInboundMessageStatusUpdate(input: {
  ctx: KernelContext;
  store: SocialStore;
  localIdentity: SocialIdentityRecord;
  friend: SocialFriendRecord;
  envelope: SocialSignedRequestEnvelope;
  now: number;
}): Promise<SocialInboundResult> {
  const existingStatus = input.store.getMessageStatusByRemoteEventId(MAIN_SOCIAL_UID, input.envelope.id);
  if (existingStatus) {
    return {
      ok: true,
      status: "accepted",
      threadId: existingStatus.threadId,
      messageId: existingStatus.messageId,
    };
  }

  const body = normalizeInboundMessageStatusUpdateBody(input.envelope.body);
  const message = input.store.getMessage(MAIN_SOCIAL_UID, body.messageId);
  if (!message) {
    throw new Error(`Message is not known: ${body.messageId}`);
  }
  const status = input.store.upsertMessageStatus({
    uid: MAIN_SOCIAL_UID,
    messageId: message.messageId,
    threadId: body.threadId ?? message.threadId,
    state: body.state,
    summary: body.summary,
    needsHumanReason: body.needsHumanReason,
    body: body.body,
    remoteEventId: input.envelope.id,
    now: input.now,
  });

  await refreshSocialInboxContextSafe(input.ctx, input.store);

  return {
    ok: true,
    status: "accepted",
    threadId: status.threadId,
    messageId: status.messageId,
  };
}

async function deliverInboundMessageToMind(
  ctx: KernelContext,
  friend: SocialFriendRecord,
  thread: SocialThreadRecord,
  message: SocialMessageRecord,
): Promise<void> {
  const identity = identityForUid(MAIN_SOCIAL_UID, ctx);
  await dispatchMindEvent(ctx, {
    identity,
    source: "social.message",
    threadKey: thread.threadId,
    title: `Social message from ${message.fromHandle}`,
    text: renderInboundSocialMessage(thread, message),
    body: {
      thread: toThreadSummary(thread),
      message: toMessageSummary(message),
    },
    metadata: {
      peerHandle: message.fromHandle,
      conversationId: thread.conversationId,
      direction: message.direction,
    },
    includeStructuredData: false,
    authority: remoteSocialProcessAuthority({
      peerHandle: friend.handle,
      peerDid: friend.did,
      threadId: thread.threadId,
      messageId: message.messageId,
    }),
  });
}

function notifyMessageStatusTransition(
  ctx: KernelContext,
  message: SocialMessageRecord,
  previousStatus: SocialMessageStatusRecord | null,
  nextStatus: SocialMessageStatusRecord,
): void {
  if (!ctx.notifications) {
    return;
  }
  if (!isNewNeedsHumanTransition(message, previousStatus, nextStatus)) {
    return;
  }
  const detail = nextStatus.needsHumanReason ?? nextStatus.summary ?? message.text ?? message.messageId;
  const notification = ctx.notifications.create({
    uid: MAIN_SOCIAL_UID,
    title: `Social message needs human: ${message.fromHandle}`,
    body: truncateNotificationBody(detail),
    level: "warning",
    source: { kind: "user" },
    actions: [],
    expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
  });
  ctx.broadcastToUid?.(MAIN_SOCIAL_UID, "notification.created", { notification });
}

async function deliverNeedsHumanToInitSafe(
  ctx: KernelContext,
  message: SocialMessageRecord,
  previousStatus: SocialMessageStatusRecord | null,
  nextStatus: SocialMessageStatusRecord,
): Promise<void> {
  if (!isNewNeedsHumanTransition(message, previousStatus, nextStatus)) {
    return;
  }
  try {
    const identity = identityForUid(MAIN_SOCIAL_UID, ctx);
    const init = ctx.procs.ensureInit(identity);
    await sendFrameToProcess(init.pid, {
      type: "req",
      id: crypto.randomUUID(),
      call: "proc.mind.message",
      args: {
        sourcePid: ctx.processId,
        conversationId: initSocialEscalationConversationId(message),
        message: renderNeedsHumanInitEvent(ctx, message, nextStatus),
        metadata: {
          source: "social.needs_human",
          peerHandle: message.fromHandle,
          threadId: message.threadId,
          messageId: message.messageId,
        },
      },
    });
  } catch (error) {
    console.error("[social] failed to deliver needs_human event to init", error);
  }
}

function isNewNeedsHumanTransition(
  message: SocialMessageRecord,
  previousStatus: SocialMessageStatusRecord | null,
  nextStatus: SocialMessageStatusRecord,
): boolean {
  return message.direction === "inbound" &&
    nextStatus.state === "needs_human" &&
    previousStatus?.state !== "needs_human";
}

function truncateNotificationBody(value: string): string {
  const normalized = value.trim();
  return normalized.length <= 240 ? normalized : `${normalized.slice(0, 237)}...`;
}

async function refreshSocialInboxContextSafe(ctx: KernelContext, store: SocialStore): Promise<void> {
  try {
    await refreshSocialInboxContext(ctx, store);
  } catch (error) {
    console.error("[social] failed to refresh social inbox context", error);
  }
}

async function refreshSocialInboxContext(ctx: KernelContext, store: SocialStore): Promise<void> {
  if (!ctx.env.STORAGE) {
    return;
  }
  const identity = identityForUid(MAIN_SOCIAL_UID, ctx);
  const fs = new GsvFs(
    ctx.env.STORAGE,
    identity,
    undefined,
    undefined,
    undefined,
    createHomeKnowledgeBackend(ctx.env.STORAGE, ctx.env.RIPGIT, identity),
  );
  const active = store.listMessageStatuses({ uid: MAIN_SOCIAL_UID, limit: 100 })
    .flatMap((status) => {
      if (!isActiveInboxMessageStatus(status.state)) {
        return [];
      }
      const message = store.getMessage(MAIN_SOCIAL_UID, status.messageId);
      return message?.direction === "inbound" ? [{ status, message }] : [];
    });
  const path = `${identity.home}/context.d/90-social-inbox.md`;
  if (active.length === 0) {
    await fs.rm(path, { force: true });
    return;
  }
  await fs.writeFile(path, renderSocialInboxContext(active));
}

function isActiveInboxMessageStatus(state: SocialMessageStatusState): boolean {
  return state === "received" ||
    state === "triaged" ||
    state === "in_progress" ||
    state === "needs_human";
}

function identityForUid(uid: number, ctx: KernelContext): ProcessIdentity {
  const existing = ctx.procs.getIdentity(`init:${uid}`);
  if (existing) {
    return existing;
  }
  const user = ctx.auth.getPasswdByUid(uid);
  if (!user) {
    throw new Error(`Cannot resolve social owner uid ${uid}`);
  }
  return {
    uid: user.uid,
    gid: user.gid,
    gids: ctx.auth.resolveGids(user.username, user.gid),
    username: user.username,
    home: user.home,
    cwd: user.home,
    workspaceId: null,
  };
}

function listLocalSocialUsers(ctx: KernelContext): Array<{ username: string; displayName?: string }> {
  return ctx.auth.getPasswdEntries()
    .filter((entry) => entry.uid >= 1000)
    .map((entry) => {
      const username = socialUserRkey(entry.username);
      const gecos = nonEmpty(entry.gecos);
      return {
        username,
        displayName: gecos && gecos !== username ? gecos : undefined,
      };
    });
}

function socialUserRkey(username: string): string {
  const rkey = username.trim().toLowerCase();
  if (!SOCIAL_ID_PATTERN.test(rkey)) {
    throw new Error(`local username cannot be published as a social user rkey: ${username}`);
  }
  return rkey;
}

function socialSenderForCaller(ctx: KernelContext): SocialMessageSender {
  const identity = ctx.identity?.process;
  if (!identity) {
    return { kind: "gsv", displayName: "GSV" };
  }
  const username = socialUserRkey(identity.username);
  const userRecord = ctx.social?.getPublicRecord<SpaceGsvUserRecord>(
    MAIN_SOCIAL_UID,
    SPACE_GSV_USER,
    username,
  )?.record;
  const displayName = userRecord?.displayName ?? displayNameForUid(ctx, identity.uid);
  const processId = ctx.processId;
  const process = processId ? ctx.procs.get(processId) : null;
  if (process?.profile === "mind") {
    return compactRecord({
      kind: "mind",
      username,
      displayName: "GSV Mind",
      publicHandle: userRecord?.publicHandle,
      processId,
    }) as SocialMessageSender;
  }
  if (process) {
    return compactRecord({
      kind: "process",
      username,
      displayName,
      publicHandle: userRecord?.publicHandle,
      processId,
      processLabel: process.label ?? undefined,
      profile: process.profile,
    }) as SocialMessageSender;
  }
  return compactRecord({
    kind: "user",
    username,
    displayName,
    publicHandle: userRecord?.publicHandle,
  }) as SocialMessageSender;
}

function displayNameForUid(ctx: KernelContext, uid: number): string | undefined {
  const user = ctx.auth.getPasswdByUid(uid);
  if (!user) {
    return undefined;
  }
  const gecos = nonEmpty(user.gecos);
  return gecos && gecos !== user.username ? gecos : undefined;
}

function renderInboundSocialMessage(thread: SocialThreadRecord, message: SocialMessageRecord): string {
  const lines = [
    "Inbound social message from an approved Contact.",
    "Handle this event by using the social command surface. A private transcript reply is not delivered to the peer.",
    `From: ${message.fromHandle}`,
    ...(message.sender ? [`Sender: ${formatSocialSender(message.sender)}`] : []),
    `Thread: ${thread.threadId}`,
    `Message: ${message.messageId}`,
    "",
    "Expected actions:",
    `- If safe and useful to answer autonomously, reply with: social message send ${message.fromHandle} "<text>" --thread ${thread.threadId}`,
    `- After handling, mark complete with: social status update ${message.messageId} --state completed --summary "..."`,
    `- If the local human must decide, escalate with: social status update ${message.messageId} --state needs_human --reason "..."`,
    "- Do not just describe these actions; run the command that matches your decision.",
  ];
  if (message.text) {
    lines.push("", "Message text:", message.text);
  }
  return lines.join("\n");
}

function formatSocialSender(sender: SocialMessageSender): string {
  switch (sender.kind) {
    case "gsv":
      return sender.displayName ?? "GSV";
    case "mind":
      return sender.username
        ? `${sender.displayName ?? "GSV Mind"} acting for ${sender.username}`
        : sender.displayName ?? "GSV Mind";
    case "process": {
      const display = sender.displayName && sender.displayName !== sender.username
        ? `${sender.displayName} (${sender.username})`
        : sender.username;
      const details = [
        sender.processLabel,
        sender.profile,
        sender.processId,
      ].filter((value): value is string => Boolean(value));
      return details.length > 0 ? `${display} process ${details.join(" / ")}` : `${display} process`;
    }
    case "user":
      return sender.displayName && sender.displayName !== sender.username
        ? `${sender.displayName} (${sender.username})`
        : sender.username;
  }
}

function initSocialEscalationConversationId(message: SocialMessageRecord): string {
  return `social:${message.fromHandle}:${message.threadId}`;
}

function renderNeedsHumanInitEvent(
  ctx: KernelContext,
  message: SocialMessageRecord,
  status: SocialMessageStatusRecord,
): string {
  const reason = status.needsHumanReason ?? status.summary ?? "The GSV Mind needs local human input.";
  const sourcePid = ctx.processId?.trim();
  const mindConversationId = `mind:social.message:${message.threadId}`;
  const lines = [
    "I need the local user's input before answering this social message.",
    "",
    `From: ${message.fromHandle}`,
    ...(message.sender ? [`Sender: ${formatSocialSender(message.sender)}`] : []),
    `Thread: ${message.threadId}`,
    `Message: ${message.messageId}`,
    `Reason: ${reason}`,
    "",
    "Original message:",
    message.text ?? "(no text body)",
    "",
    "Use the normal init conversation to ask the local user what to do. Do not guess their preference, permission, schedule, availability, or commitment.",
    "",
    "Useful commands:",
    `- Inspect the thread: social thread read ${message.threadId}`,
    `- If the user gives an answer to send: social message send ${message.fromHandle} "<reply>" --thread ${message.threadId}`,
    `- Then mark handled: social status update ${message.messageId} --state completed --summary "Answered via init"`,
    `- If the user declines or no response should be sent: social status update ${message.messageId} --state declined --summary "..."`,
  ];
  if (sourcePid) {
    lines.push(
      "",
      `Escalating process: ${sourcePid}`,
      `Mind conversation: ${mindConversationId}`,
      `Optional handoff back to Mind: proc send ${sourcePid} --conversation ${mindConversationId} "<what the user decided>"`,
    );
  }
  return lines.join("\n");
}

function renderSocialInboxContext(entries: Array<{
  status: SocialMessageStatusRecord;
  message: SocialMessageRecord;
}>): string {
  const lines = [
    "# Social Inbox",
    "",
    "Active Contact messages visible to GSV Mind.",
    "Use the social command to inspect messages, reply, and update message status.",
    "Escalate human preference, permission, schedule, availability, or commitment requests with needs_human.",
    "",
  ];
  for (const { status, message } of entries.sort((left, right) => right.status.updatedAt - left.status.updatedAt)) {
    lines.push(
      `## ${status.summary ?? message.text ?? message.messageId}`,
      "",
      `- Message: ${message.messageId}`,
      `- From: ${message.fromHandle}`,
      ...(message.sender ? [`- Sender: ${formatSocialSender(message.sender)}`] : []),
      `- To: ${message.toHandle}`,
      `- State: ${status.state}`,
      `- Updated: ${new Date(status.updatedAt).toISOString()}`,
      `- Inspect: social thread get ${message.threadId}`,
      `- Reply: social message send ${message.fromHandle} "<text>" --thread ${message.threadId}`,
      `- Update: social status update ${message.messageId} --state completed --summary "..."`,
      `- Escalate: social status update ${message.messageId} --state needs_human --reason "..."`,
    );
    if (status.needsHumanReason) {
      lines.push(`- Needs human: ${status.needsHumanReason}`);
    }
    lines.push(`- Thread: ${message.threadId}`);
    if (message.text) {
      lines.push("", message.text);
    }
    const structured = status.body ?? message.body;
    if (structured !== undefined) {
      lines.push("", "```json", JSON.stringify(structured, null, 2), "```");
    }
    lines.push("");
  }
  return lines.join("\n");
}

type BaselineSocialRecordOptions = {
  endpoint: string;
  profile?: SpaceGsvProfileRecord;
  profileDisplayName?: string;
  profileDescription?: string;
  fallbackDisplayName: string;
};

async function publishBaselineSocialRecords(
  ctx: KernelContext,
  identity: SocialIdentityRecord,
  options: BaselineSocialRecordOptions,
): Promise<SocialIdentityRepublishResult["records"]> {
  const store = requireSocialStore(ctx);
  const settings = await ensureServiceSettings(store, identity.uid);
  const now = new Date().toISOString();
  const existingProfile = options.profile;
  const profileDisplayName = nonEmpty(options.profileDisplayName)
    ?? nonEmpty(existingProfile?.displayName)
    ?? options.fallbackDisplayName;

  const profileRecord = compactRecord({
    $type: SPACE_GSV_PROFILE,
    createdAt: existingProfile?.createdAt ?? now,
    updatedAt: now,
    displayName: profileDisplayName,
    description: nonEmpty(options.profileDescription) ?? nonEmpty(existingProfile?.description),
    avatar: existingProfile?.avatar,
    avatarAlt: existingProfile?.avatarAlt,
    links: existingProfile?.links,
  }) as SpaceGsvProfileRecord;
  const instanceRecord: SpaceGsvInstanceRecord = {
    $type: SPACE_GSV_INSTANCE,
    createdAt: now,
    updatedAt: now,
    endpoint: options.endpoint,
    protocolVersion: 1,
    serviceKey: {
      id: `${identity.did}#gsv-social-key`,
      type: "Multikey",
      publicKeyMultibase: settings.servicePublicKeyMultibase,
    },
    acceptedSocialMethods: [...SOCIAL_REMOTE_OPERATIONS],
  };

  const profile = await publishSelfRecord(ctx, identity, SPACE_GSV_PROFILE, profileRecord);
  const instance = await publishSelfRecord(ctx, identity, SPACE_GSV_INSTANCE, instanceRecord);
  const users = await publishLocalUserDirectoryRecords(ctx, identity, now);

  return {
    profile: profile.uri as SocialAtUri | undefined,
    instance: instance.uri as SocialAtUri | undefined,
    users: users.flatMap((record) => record.uri ? [record.uri as SocialAtUri] : []),
  };
}

async function publishSelfRecord<TRecord extends SpaceGsvRecord>(
  ctx: KernelContext,
  identity: SocialIdentityRecord,
  collection: SpaceGsvCollection,
  record: TRecord,
  rkey: string = SELF_RKEY,
): Promise<SocialPublicRecord<TRecord>> {
  const host = pdsHostForIdentity(ctx.env, identity);
  const response = await requirePdsClient(ctx.env).putRecord({
    host,
    repo: identity.did,
    collection,
    rkey,
    record,
    validate: true,
  });
  return requireSocialStore(ctx).upsertPublicRecord({
    uid: identity.uid,
    collection,
    rkey,
    record,
    uri: response.uri,
    cid: response.cid,
  });
}

async function deleteSelfPublicRecord(
  ctx: KernelContext,
  collection: SpaceGsvCollection,
  uri: SocialAtUri,
  label: string,
): Promise<{ deleted: boolean }> {
  const uid = requireSocialOwnerUid(ctx);
  const identity = requireWritableSocialIdentity(ctx);
  const parsed = parseSocialAtUri(uri, collection);
  if (parsed.did !== identity.did) {
    throw new Error(`${label} uri does not belong to the local social identity`);
  }
  await requirePdsClient(ctx.env).deleteRecord({
    host: pdsHostForIdentity(ctx.env, identity),
    repo: identity.did,
    collection,
    rkey: parsed.rkey,
  });
  return {
    deleted: requireSocialStore(ctx).deletePublicRecord(uid, collection, parsed.rkey),
  };
}

async function listSocialPublicRecords<TRecord extends SpaceGsvRecord>(input: {
  args: { handle?: string; limit?: number };
  ctx: KernelContext;
  collection: SpaceGsvCollection;
  method: SocialRemoteOperation;
  validate: (record: unknown) => TRecord;
}): Promise<Array<SocialPublicRecordEntry<TRecord>>> {
  const uid = requireSocialOwnerUid(input.ctx);
  const store = requireSocialStore(input.ctx);
  const limit = normalizeLimit(input.args.limit, 50);
  if (input.args.handle === undefined) {
    const identity = requireWritableSocialIdentity(input.ctx);
    const handle = requireLocalHandle(identity);
    return store.listPublicRecords<TRecord>(uid, input.collection, limit).map((entry) =>
      toSocialPublicRecordEntry(handle, identity.did, input.collection, entry)
    );
  }

  const handle = normalizeHandle(input.args.handle, "handle");
  const friend = requireFriend(store, uid, handle);
  requireRemoteMethod(friend, input.method);
  const records = await syncFriendPublicRecords<TRecord>({
    ctx: input.ctx,
    store,
    uid,
    friend,
    collection: input.collection,
    limit,
    validate: input.validate,
  });
  return records.flatMap((entry) => entry.uri
    ? [{
        handle,
        uri: entry.uri as SocialAtUri,
        cid: entry.cid,
        record: entry.record,
      }]
    : []);
}

function toSocialPublicRecordEntry<TRecord extends SpaceGsvRecord>(
  handle: string,
  did: SocialDid,
  collection: SpaceGsvCollection,
  entry: SocialPublicRecord<TRecord>,
): SocialPublicRecordEntry<TRecord> {
  return {
    handle,
    uri: (entry.uri ?? `at://${did}/${collection}/${entry.rkey}`) as SocialAtUri,
    cid: entry.cid,
    record: entry.record,
  };
}

function normalizeOptionalRkey(value: unknown): string | undefined {
  return value === undefined ? undefined : normalizeSocialId(value, "rkey");
}

function contactRkey(record: SpaceGsvContactRecord): string {
  return record.subject.handle
    ? sanitizeSocialRkey(record.subject.handle)
    : sanitizeSocialRkey(record.subject.did.replace(/^did:/, ""));
}

function sanitizeSocialRkey(value: string): string {
  const sanitized = value.toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 200);
  return sanitized || newSocialId("record");
}

async function publishPackageRecord(
  ctx: KernelContext,
  identity: SocialIdentityRecord,
  pkg: InstalledPackageRecord,
  rkey: string,
): Promise<SocialPublicRecord<SpaceGsvPackageRecord>> {
  const existing = requireSocialStore(ctx).getPublicRecord<SpaceGsvPackageRecord>(
    identity.uid,
    SPACE_GSV_PACKAGE,
    rkey,
  )?.record;
  const now = new Date().toISOString();
  const record = validatePackageRecord(compactRecord({
    $type: SPACE_GSV_PACKAGE,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    name: pkg.manifest.name,
    displayName: packageDisplayName(pkg),
    description: pkg.manifest.description,
    source: {
      repo: pkg.manifest.source.repo,
      ref: pkg.manifest.source.ref,
      subdir: pkg.manifest.source.subdir,
    },
  }) as SpaceGsvPackageRecord);
  return publishSelfRecord(ctx, identity, SPACE_GSV_PACKAGE, record, rkey);
}

async function deletePublicPackageRecordIfPresent(
  ctx: KernelContext,
  identity: SocialIdentityRecord,
  rkey: string,
): Promise<void> {
  const store = requireSocialStore(ctx);
  const existing = store.getPublicRecord<SpaceGsvPackageRecord>(identity.uid, SPACE_GSV_PACKAGE, rkey);
  if (!existing) {
    return;
  }
  await requirePdsClient(ctx.env).deleteRecord({
    host: pdsHostForIdentity(ctx.env, identity),
    repo: identity.did,
    collection: SPACE_GSV_PACKAGE,
    rkey,
  });
  store.deletePublicRecord(identity.uid, SPACE_GSV_PACKAGE, rkey);
}

function packageRecordRkey(pkg: InstalledPackageRecord): string {
  return sanitizeSocialRkey(pkg.manifest.name);
}

function packageDisplayName(pkg: InstalledPackageRecord): string | undefined {
  return pkg.manifest.entrypoints.find((entry) => entry.kind === "ui" && entry.name.trim())?.name;
}

async function publishLocalUserDirectoryRecords(
  ctx: KernelContext,
  identity: SocialIdentityRecord,
  now: string,
): Promise<Array<SocialPublicRecord<SpaceGsvUserRecord>>> {
  const records: Array<SocialPublicRecord<SpaceGsvUserRecord>> = [];
  for (const user of listLocalSocialUsers(ctx)) {
    const existing = requireSocialStore(ctx).getPublicRecord<SpaceGsvUserRecord>(
      identity.uid,
      SPACE_GSV_USER,
      user.username,
    )?.record;
    const record = compactRecord({
      $type: SPACE_GSV_USER,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      username: user.username,
      displayName: user.displayName,
      description: existing?.description,
      publicHandle: existing?.publicHandle,
      acceptsContact: existing?.acceptsContact ?? true,
    }) as SpaceGsvUserRecord;
    records.push(await publishSelfRecord(ctx, identity, SPACE_GSV_USER, record, user.username));
  }
  return records;
}

function pdsHostForIdentity(env: Env, identity: SocialIdentityRecord): string {
  const endpoint = new URL(identity.pdsEndpoint);
  if (identity.handle) {
    const handleOrigin = new URL(socialOriginForHandle(env, identity.handle));
    if (handleOrigin.origin === endpoint.origin) {
      return identity.handle;
    }
  }
  return endpoint.host;
}

function requireSocialStore(ctx: KernelContext): SocialStore {
  if (!ctx.social) {
    throw new Error("Social store is required");
  }
  return ctx.social;
}

function requireUserUid(ctx: KernelContext): number {
  const identity = ctx.identity;
  if (!identity || identity.role !== "user") {
    throw new Error("Authentication required");
  }
  return identity.process.uid;
}

function requireMainSocialUserUid(ctx: KernelContext): number {
  const uid = requireUserUid(ctx);
  if (uid !== MAIN_SOCIAL_UID) {
    throw new Error("Social identity is limited to the main GSV user");
  }
  return uid;
}

function requireSocialOwnerUid(ctx: KernelContext): number {
  requireUserUid(ctx);
  return MAIN_SOCIAL_UID;
}

function ensureInstanceIdentityOwner(store: SocialStore, uid: number): void {
  const existing = store.getInstanceIdentity();
  if (existing && existing.uid !== uid) {
    throw new Error(`Social identity is already linked to uid ${existing.uid}`);
  }
}

function resolveReadableIdentity(
  handle: string | undefined,
  ctx: KernelContext,
): SocialIdentityRecord | null {
  const store = requireSocialStore(ctx);
  if (handle) {
    return store.getIdentityByHandle(normalizeHandle(handle, "handle"));
  }
  return store.getIdentity(requireSocialOwnerUid(ctx));
}

function requireWritableSocialIdentity(ctx: KernelContext): SocialIdentityRecord {
  const identity = requireSocialStore(ctx).getIdentity(requireSocialOwnerUid(ctx));
  if (!identity) {
    throw new Error("Social identity is not linked");
  }
  return identity;
}

function requireLocalHandle(identity: SocialIdentityRecord): string {
  return identity.handle ?? handleFromDid(identity.did);
}

function requireFriend(store: SocialStore, uid: number, handle: string): SocialFriendRecord {
  const friend = store.getFriend(uid, handle);
  if (!friend) {
    throw new Error(`Contact is not known: ${handle}`);
  }
  return friend;
}

function requireRemoteMethod(friend: SocialFriendRecord, method: SocialRemoteOperation): void {
  if (!friend.instance.acceptedSocialMethods.includes(method)) {
    throw new Error(`${friend.handle} does not advertise ${method}`);
  }
}

function requireExistingThread(
  store: SocialStore,
  uid: number,
  threadIdValue: unknown,
  expectedPeerHandle?: string,
): SocialThreadRecord {
  const threadId = normalizeSocialId(threadIdValue, "threadId");
  const thread = store.getThread(uid, threadId);
  if (!thread) {
    throw new Error(`Thread is not known: ${threadId}`);
  }
  if (expectedPeerHandle && thread.peerHandle !== expectedPeerHandle) {
    throw new Error(`Thread ${threadId} belongs to ${thread.peerHandle}, not ${expectedPeerHandle}`);
  }
  return thread;
}

function inferDeliveryMethod(message: SocialMessageRecord): SocialRemoteOperation {
  return message.deliveryMethod ?? "social.message.send";
}

function normalizeDid(value: unknown): SocialDid {
  if (typeof value !== "string") {
    throw new Error("did is required");
  }
  const did = value.trim() as SocialDid;
  if (!DID_PATTERN.test(did)) {
    throw new Error("invalid did");
  }
  return did;
}

function handleFromDid(did: SocialDid): string {
  const prefix = "did:web:";
  if (!did.startsWith(prefix)) {
    throw new Error("Social identity does not have a handle");
  }
  return normalizeHandle(decodeURIComponent(did.slice(prefix.length).replace(/:/g, ".")), "handle");
}

function normalizeHandle(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string`);
  }
  const handle = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(handle) || !handle.includes(".")) {
    throw new Error(`invalid ${field}`);
  }
  return handle;
}

function normalizeSocialId(value: unknown, field: string): string {
  const id = requireString(value, field).trim();
  if (!SOCIAL_ID_PATTERN.test(id)) {
    throw new Error(`invalid ${field}`);
  }
  return id;
}

function newSocialId(_prefix: string): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  const suffix = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${Date.now()}-${suffix}`;
}

function socialConversationId(peerHandle: string, threadId: string): string {
  return `social:${peerHandle}:${threadId}`;
}

function normalizeThreadStatus(value: unknown, field: string): SocialThreadStatus {
  if (
    value !== "active" &&
    value !== "waiting-on-human" &&
    value !== "completed" &&
    value !== "expired" &&
    value !== "closed"
  ) {
    throw new Error(`invalid ${field}`);
  }
  return value;
}

function normalizeMessageDirection(value: unknown, field: string): SocialMessageDirection {
  if (value !== "inbound" && value !== "outbound") {
    throw new Error(`${field} must be inbound or outbound`);
  }
  return value;
}

function normalizeMessageStatusState(value: unknown, field: string): SocialMessageStatusState {
  if (
    value !== "received" &&
    value !== "triaged" &&
    value !== "in_progress" &&
    value !== "needs_human" &&
    value !== "completed" &&
    value !== "declined" &&
    value !== "failed"
  ) {
    throw new Error(`invalid ${field}`);
  }
  return value;
}

function normalizeSocialBody(value: unknown, field: string): unknown {
  assertCanonicalJsonValue(value, field);
  const encoded = canonicalJson(value);
  if (byteLength(encoded) > MAX_SOCIAL_BODY_BYTES) {
    throw new Error(`${field} exceeds ${MAX_SOCIAL_BODY_BYTES} bytes`);
  }
  return value;
}

function normalizeLimit(value: unknown, defaultValue: number): number {
  if (value === undefined) {
    return defaultValue;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 100) {
    throw new Error("limit must be an integer from 1 to 100");
  }
  return value;
}

function normalizeOptionalText(value: unknown, field: string, maxBytes: number): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string`);
  }
  const text = value.trim();
  if (!text) {
    return undefined;
  }
  if (byteLength(text) > maxBytes) {
    throw new Error(`${field} exceeds ${maxBytes} bytes`);
  }
  return text;
}

function normalizeMessageText(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string`);
  }
  const text = value.trim();
  if (!text) {
    throw new Error(`${field} must not be empty`);
  }
  if (byteLength(text) > MAX_SOCIAL_TEXT_BYTES) {
    throw new Error(`${field} exceeds ${MAX_SOCIAL_TEXT_BYTES} bytes`);
  }
  return text;
}

function normalizeFriendNote(value: unknown): string {
  const note = normalizeMessageText(value, "note");
  if (byteLength(note) > 1024) {
    throw new Error("note exceeds 1024 bytes");
  }
  return note;
}

function normalizeSocialMessageSender(value: unknown, field: string): SocialMessageSender {
  const object = requireObject(value, field);
  const kind = requireString(object.kind, `${field}.kind`);
  if (kind === "gsv") {
    return compactRecord({
      kind,
      displayName: normalizeOptionalText(object.displayName, `${field}.displayName`, 256),
    }) as SocialMessageSender;
  }
  if (kind === "mind") {
    return compactRecord({
      kind,
      username: object.username === undefined
        ? undefined
        : socialUserRkey(requireString(object.username, `${field}.username`)),
      displayName: normalizeOptionalText(object.displayName, `${field}.displayName`, 256),
      publicHandle: object.publicHandle === undefined
        ? undefined
        : normalizeHandle(object.publicHandle, `${field}.publicHandle`),
      processId: normalizeOptionalText(object.processId, `${field}.processId`, 240),
    }) as SocialMessageSender;
  }
  if (kind === "user") {
    return compactRecord({
      kind,
      username: socialUserRkey(requireString(object.username, `${field}.username`)),
      displayName: normalizeOptionalText(object.displayName, `${field}.displayName`, 256),
      publicHandle: object.publicHandle === undefined
        ? undefined
        : normalizeHandle(object.publicHandle, `${field}.publicHandle`),
    }) as SocialMessageSender;
  }
  if (kind === "process") {
    return compactRecord({
      kind,
      username: socialUserRkey(requireString(object.username, `${field}.username`)),
      displayName: normalizeOptionalText(object.displayName, `${field}.displayName`, 256),
      publicHandle: object.publicHandle === undefined
        ? undefined
        : normalizeHandle(object.publicHandle, `${field}.publicHandle`),
      processId: normalizeOptionalText(object.processId, `${field}.processId`, 240),
      processLabel: normalizeOptionalText(object.processLabel, `${field}.processLabel`, 256),
      profile: normalizeOptionalText(object.profile, `${field}.profile`, 128),
    }) as SocialMessageSender;
  }
  throw new Error(`${field}.kind must be gsv, mind, user, or process`);
}

function normalizeMessagePayload(value: {
  text?: unknown;
  body?: unknown;
}, field: string): NormalizedMessagePayload {
  const text = value.text === undefined ? undefined : normalizeMessageText(value.text, `${field}.text`);
  let body: unknown = undefined;
  if (value.body !== undefined) {
    assertCanonicalJsonValue(value.body, `${field}.body`);
    const encoded = canonicalJson(value.body);
    if (byteLength(encoded) > MAX_SOCIAL_BODY_BYTES) {
      throw new Error(`${field}.body exceeds ${MAX_SOCIAL_BODY_BYTES} bytes`);
    }
    body = value.body;
  }
  if (text === undefined && body === undefined) {
    throw new Error(`${field} must include text or body`);
  }
  return { text, body };
}

function normalizeInboundMessageBody(value: unknown): InboundMessageBody {
  const object = requireObject(value, "envelope.body");
  const payload = normalizeMessagePayload(object, "envelope.body");
  const threadId = object.threadId === undefined
    ? undefined
    : normalizeSocialId(object.threadId, "envelope.body.threadId");
  const messageId = object.messageId === undefined
    ? undefined
    : normalizeSocialId(object.messageId, "envelope.body.messageId");
  const sender = object.sender === undefined
    ? undefined
    : normalizeSocialMessageSender(object.sender, "envelope.body.sender");
  const expiresAt = object.expiresAt === undefined
    ? undefined
    : requireIsoStringValue(object.expiresAt, "envelope.body.expiresAt");
  return {
    ...payload,
    threadId,
    messageId,
    sender,
    expiresAt,
  };
}

function normalizeInboundMessageStatusUpdateBody(value: unknown): InboundMessageStatusUpdateBody {
  const object = requireObject(value, "envelope.body");
  const threadId = object.threadId === undefined
    ? undefined
    : normalizeSocialId(object.threadId, "envelope.body.threadId");
  const messageId = normalizeSocialId(object.messageId, "envelope.body.messageId");
  const state = normalizeMessageStatusState(object.state, "envelope.body.state");
  const summary = object.summary === undefined
    ? undefined
    : normalizeOptionalText(object.summary, "envelope.body.summary", 2048);
  const needsHumanReason = object.needsHumanReason === undefined
    ? undefined
    : normalizeOptionalText(object.needsHumanReason, "envelope.body.needsHumanReason", 2048);
  const body = object.body === undefined
    ? undefined
    : normalizeSocialBody(object.body, "envelope.body.body");
  return {
    threadId,
    messageId,
    state,
    summary,
    needsHumanReason,
    body,
  };
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function validateGrants(value: unknown): SocialGrant[] {
  if (!Array.isArray(value)) {
    throw new Error("grants must be an array");
  }
  const seen = new Set<string>();
  return value.map((grant, index) => {
    const item = requireObject(grant, `grants[${index}]`);
    const operation = requireString(item.operation, `grants[${index}].operation`);
    if (!isSocialRemoteOperation(operation)) {
      throw new Error(`unsupported grant operation: ${operation}`);
    }
    if (seen.has(operation)) {
      throw new Error(`duplicate grant operation: ${operation}`);
    }
    seen.add(operation);
    if (item.expiresAt !== undefined) {
      requireIsoString(item.expiresAt, `grants[${index}].expiresAt`);
    }
    if (
      item.scope !== undefined &&
      (!item.scope || typeof item.scope !== "object" || Array.isArray(item.scope))
    ) {
      throw new Error(`grants[${index}].scope must be an object`);
    }
    return {
      operation,
      scope: item.scope as Record<string, unknown> | undefined,
      expiresAt: item.expiresAt as string | undefined,
    };
  });
}

function normalizePdsEndpoint(value: unknown, env: Env): string {
  if (typeof value !== "string") {
    throw new Error("pdsEndpoint is required");
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("pdsEndpoint must be a URL");
  }
  if (url.protocol !== "https:" && !isAllowedDevHttpUrl(url, env)) {
    throw new Error("pdsEndpoint must use https");
  }
  return url.origin;
}

function normalizePublicOrigin(value: unknown, env: Env): URL {
  if (typeof value !== "string") {
    throw new Error("origin is required");
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("origin must be a URL");
  }
  if (url.protocol !== "https:" && !isAllowedDevHttpUrl(url, env)) {
    throw new Error("origin must use https");
  }
  if (url.username || url.password) {
    throw new Error("origin must not include credentials");
  }
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url;
}

function isAllowedDevHttpUrl(url: URL, env: Env): boolean {
  return isGsvDevMode(env) &&
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1");
}

function validateProfileRecord(record: unknown): SpaceGsvProfileRecord {
  const value = requireRecordObject(record, SPACE_GSV_PROFILE);
  requireIsoString(value.createdAt, "createdAt");
  optionalString(value.updatedAt, "updatedAt");
  optionalString(value.displayName, "displayName");
  optionalString(value.description, "description");
  if (value.avatar !== undefined) {
    validateBlobRef(value.avatar, "avatar");
  }
  optionalString(value.avatarAlt, "avatarAlt");
  if (value.links !== undefined) {
    if (!Array.isArray(value.links)) {
      throw new Error("links must be an array");
    }
    for (const [index, link] of value.links.entries()) {
      const item = requireObject(link, `links[${index}]`);
      requireString(item.label, `links[${index}].label`);
      requireString(item.uri, `links[${index}].uri`);
    }
  }
  return value as SpaceGsvProfileRecord;
}

function validateInstanceRecord(record: unknown): SpaceGsvInstanceRecord {
  const value = requireRecordObject(record, SPACE_GSV_INSTANCE);
  requireIsoString(value.createdAt, "createdAt");
  optionalString(value.updatedAt, "updatedAt");
  requireUrlString(value.endpoint, "endpoint");
  if (value.protocolVersion !== 1) {
    throw new Error("protocolVersion must be 1");
  }
  const serviceKey = requireObject(value.serviceKey, "serviceKey");
  requireString(serviceKey.id, "serviceKey.id");
  if (serviceKey.type !== "Multikey") {
    throw new Error("serviceKey.type must be Multikey");
  }
  requireString(serviceKey.publicKeyMultibase, "serviceKey.publicKeyMultibase");
  if (!Array.isArray(value.acceptedSocialMethods)) {
    throw new Error("acceptedSocialMethods must be an array");
  }
  for (const method of value.acceptedSocialMethods) {
    if (typeof method !== "string" || !isSocialRemoteOperation(method)) {
      throw new Error(`unsupported social method: ${String(method)}`);
    }
  }
  return value as SpaceGsvInstanceRecord;
}

function validateUserRecord(record: unknown): SpaceGsvUserRecord {
  const value = requireRecordObject(record, SPACE_GSV_USER);
  requireIsoString(value.createdAt, "createdAt");
  optionalString(value.updatedAt, "updatedAt");
  socialUserRkey(requireString(value.username, "username"));
  optionalString(value.displayName, "displayName");
  optionalString(value.description, "description");
  if (value.publicHandle !== undefined) {
    normalizeHandle(value.publicHandle, "publicHandle");
  }
  if (value.acceptsContact !== undefined && typeof value.acceptsContact !== "boolean") {
    throw new Error("acceptsContact must be a boolean");
  }
  return value as SpaceGsvUserRecord;
}

function validateContactRecord(record: unknown): SpaceGsvContactRecord {
  const value = requireRecordObject(record, SPACE_GSV_CONTACT);
  requireIsoString(value.createdAt, "createdAt");
  optionalString(value.updatedAt, "updatedAt");
  const subject = requireObject(value.subject, "subject");
  normalizeDid(subject.did);
  if (subject.handle !== undefined) {
    normalizeHandle(subject.handle, "subject.handle");
  }
  if (subject.uri !== undefined) {
    requireAtUri(subject.uri, "subject.uri");
  }
  optionalBoundedString(value.label, "label", 256);
  validateStringArray(value.tags, "tags", 20, 256);
  return value as SpaceGsvContactRecord;
}

function validatePackageRecord(record: unknown): SpaceGsvPackageRecord {
  const value = requireRecordObject(record, SPACE_GSV_PACKAGE);
  requireIsoString(value.createdAt, "createdAt");
  optionalString(value.updatedAt, "updatedAt");
  requireBoundedString(value.name, "name", 256);
  optionalBoundedString(value.displayName, "displayName", 256);
  optionalBoundedString(value.description, "description", 4096);
  validatePackageSource(value.source, "source");
  if (value.homepage !== undefined) {
    requireUrlString(value.homepage, "homepage");
  }
  validateStringArray(value.tags, "tags", 20, 256);
  return value as SpaceGsvPackageRecord;
}

function validatePackageReleaseRecord(record: unknown): SpaceGsvPackageReleaseRecord {
  const value = requireRecordObject(record, SPACE_GSV_PACKAGE_RELEASE);
  requireIsoString(value.createdAt, "createdAt");
  optionalString(value.updatedAt, "updatedAt");
  validateRecordReference(value.package, "package");
  requireBoundedString(value.version, "version", 128);
  optionalBoundedString(value.title, "title", 256);
  optionalBoundedString(value.description, "description", 4096);
  validatePackageSource(value.source, "source");
  if (value.releasedAt !== undefined) {
    requireIsoString(value.releasedAt, "releasedAt");
  }
  validateStringArray(value.tags, "tags", 20, 256);
  return value as SpaceGsvPackageReleaseRecord;
}

function validateVouchRecord(record: unknown): SpaceGsvVouchRecord {
  const value = requireRecordObject(record, SPACE_GSV_VOUCH);
  requireIsoString(value.createdAt, "createdAt");
  optionalString(value.updatedAt, "updatedAt");
  validateRecordReference(value.subject, "subject");
  optionalBoundedString(value.note, "note", 1200);
  validateStringArray(value.tags, "tags", 20, 256);
  return value as SpaceGsvVouchRecord;
}

function validateNewsRecord(record: unknown): SpaceGsvNewsRecord {
  const value = requireRecordObject(record, SPACE_GSV_NEWS);
  requireIsoString(value.createdAt, "createdAt");
  optionalString(value.updatedAt, "updatedAt");
  optionalBoundedString(value.title, "title", 256);
  requireBoundedString(value.text, "text", MAX_SOCIAL_TEXT_BYTES);
  validateStringArray(value.tags, "tags", 20, 256);
  if (value.startsAt !== undefined) {
    requireIsoString(value.startsAt, "startsAt");
  }
  if (value.endsAt !== undefined) {
    requireIsoString(value.endsAt, "endsAt");
  }
  validateRecordReferenceArray(value.subjects, "subjects");
  return value as SpaceGsvNewsRecord;
}

function validatePackageSource(value: unknown, field: string): void {
  if (value === undefined) {
    return;
  }
  const source = requireObject(value, field);
  optionalBoundedString(source.repo, `${field}.repo`, 512);
  optionalBoundedString(source.ref, `${field}.ref`, 256);
  optionalBoundedString(source.subdir, `${field}.subdir`, 512);
  if (source.uri !== undefined) {
    requireUrlString(source.uri, `${field}.uri`);
  }
}

function validateRecordReference(value: unknown, field: string): void {
  const reference = requireObject(value, field);
  requireAtUri(reference.uri, `${field}.uri`);
  optionalBoundedString(reference.cid, `${field}.cid`, 256);
}

function validateRecordReferenceArray(value: unknown, field: string): void {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value) || value.length > 20) {
    throw new Error(`${field} must be an array with at most 20 items`);
  }
  value.forEach((item, index) => validateRecordReference(item, `${field}[${index}]`));
}

function validateStringArray(value: unknown, field: string, maxItems: number, maxBytes: number): void {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new Error(`${field} must be an array with at most ${maxItems} items`);
  }
  value.forEach((item, index) => requireBoundedString(item, `${field}[${index}]`, maxBytes));
}

function requireRecordObject(
  record: unknown,
  type: SpaceGsvCollection,
): Record<string, unknown> {
  const value = requireObject(record, "record");
  if (value.$type !== type) {
    throw new Error(`record.$type must be ${type}`);
  }
  return value;
}

function validateBlobRef(value: unknown, field: string): void {
  const ref = requireObject(value, field);
  if (ref.$type !== "blob") {
    throw new Error(`${field}.$type must be blob`);
  }
  const link = requireObject(ref.ref, `${field}.ref`);
  requireString(link.$link, `${field}.ref.$link`);
  requireString(ref.mimeType, `${field}.mimeType`);
  const size = ref.size;
  if (typeof size !== "number" || !Number.isInteger(size) || size < 0) {
    throw new Error(`${field}.size must be a non-negative integer`);
  }
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function requireBoundedString(value: unknown, field: string, maxBytes: number): string {
  const text = requireString(value, field).trim();
  if (byteLength(text) > maxBytes) {
    throw new Error(`${field} exceeds ${maxBytes} bytes`);
  }
  return text;
}

function optionalString(value: unknown, field: string): void {
  if (value !== undefined && typeof value !== "string") {
    throw new Error(`${field} must be a string`);
  }
}

function optionalBoundedString(value: unknown, field: string, maxBytes: number): void {
  if (value === undefined) {
    return;
  }
  requireBoundedString(value, field, maxBytes);
}

function requireIsoString(value: unknown, field: string): void {
  const text = requireString(value, field);
  if (Number.isNaN(Date.parse(text))) {
    throw new Error(`${field} must be an ISO date string`);
  }
}

function requireUrlString(value: unknown, field: string): void {
  const text = requireString(value, field);
  try {
    const url = new URL(text);
    if (url.protocol !== "https:" && url.hostname !== "localhost") {
      throw new Error("not https");
    }
  } catch {
    throw new Error(`${field} must be an https URL`);
  }
}

function requireAtUri(value: unknown, field: string): void {
  const text = requireString(value, field);
  if (!text.startsWith("at://")) {
    throw new Error(`${field} must be an at:// URI`);
  }
}

function normalizeSignedEnvelope(value: unknown): SocialSignedRequestEnvelope {
  const envelope = requireObject(value, "envelope");
  const method = requireString(envelope.method, "envelope.method");
  if (!isSocialRemoteOperation(method)) {
    throw new Error(`unsupported envelope method: ${method}`);
  }
  if (!Object.prototype.hasOwnProperty.call(envelope, "body")) {
    throw new Error("envelope.body is required");
  }
  assertCanonicalJsonValue(envelope.body, "envelope.body");
  return {
    id: requireString(envelope.id, "envelope.id"),
    method,
    fromDid: normalizeDid(envelope.fromDid),
    toDid: normalizeDid(envelope.toDid),
    createdAt: requireIsoStringValue(envelope.createdAt, "envelope.createdAt"),
    expiresAt: requireIsoStringValue(envelope.expiresAt, "envelope.expiresAt"),
    nonce: requireString(envelope.nonce, "envelope.nonce"),
    keyId: requireString(envelope.keyId, "envelope.keyId"),
    body: envelope.body,
    signature: requireString(envelope.signature, "envelope.signature"),
  };
}

function requireIsoStringValue(value: unknown, field: string): string {
  const text = requireString(value, field);
  if (Number.isNaN(Date.parse(text))) {
    throw new Error(`${field} must be an ISO date string`);
  }
  return text;
}

function rejectInbound(error: string): SocialInboundResult {
  return { ok: false, status: "rejected", error };
}

async function resolveFriendServiceIdentity(handle: string, env: Env): Promise<{
  did: SocialDid;
  instance: SpaceGsvInstanceRecord;
}> {
  const origin = socialOriginForHandle(env, handle);
  const did = normalizeDid((await fetchRequiredText(
    `${origin}/.well-known/atproto-did`,
    `${handle} handle DID`,
  )).trim());
  const instance = await fetchRequiredRecord<SpaceGsvInstanceRecord>(
    handle,
    did,
    SPACE_GSV_INSTANCE,
    env,
  );
  return {
    did,
    instance: validateInstanceRecord(instance),
  };
}

async function resolveFriendPublicIdentity(handle: string, env: Env): Promise<{
  did: SocialDid;
  profile?: SpaceGsvProfileRecord;
  instance: SpaceGsvInstanceRecord;
}> {
  const origin = socialOriginForHandle(env, handle);
  const did = normalizeDid((await fetchRequiredText(
    `${origin}/.well-known/atproto-did`,
    `${handle} handle DID`,
  )).trim());

  const [profile, instance] = await Promise.all([
    fetchOptionalRecord<SpaceGsvProfileRecord>(handle, did, SPACE_GSV_PROFILE, env),
    fetchRequiredRecord<SpaceGsvInstanceRecord>(handle, did, SPACE_GSV_INSTANCE, env),
  ]);

  return {
    did,
    profile: profile ? validateProfileRecord(profile) : undefined,
    instance: validateInstanceRecord(instance),
  };
}

async function fetchRequiredRecord<TRecord extends SpaceGsvRecord>(
  handle: string,
  did: SocialDid,
  collection: SpaceGsvCollection,
  env: Env,
): Promise<TRecord> {
  const record = await fetchOptionalRecord<TRecord>(handle, did, collection, env);
  if (!record) {
    throw new Error(`${handle} did not publish ${collection}/${FRIEND_SELF_RKEY}`);
  }
  return record;
}

async function fetchOptionalRecord<TRecord extends SpaceGsvRecord>(
  handle: string,
  did: SocialDid,
  collection: SpaceGsvCollection,
  env: Env,
): Promise<TRecord | null> {
  const url = new URL(`${socialOriginForHandle(env, handle)}/xrpc/com.atproto.repo.getRecord`);
  url.searchParams.set("repo", did);
  url.searchParams.set("collection", collection);
  url.searchParams.set("rkey", FRIEND_SELF_RKEY);
  const response = await fetch(url.toString());
  const body = await parseFetchBody(response);
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`${handle} ${collection} fetch failed status=${response.status}: ${formatFetchBody(body)}`);
  }
  const object = requireObject(body, `${collection} response`);
  return object.value as TRecord;
}

async function syncFriendPublicRecords<TRecord extends SpaceGsvRecord>(input: {
  ctx: KernelContext;
  store: SocialStore;
  uid: number;
  friend: SocialFriendRecord;
  collection: SpaceGsvCollection;
  limit: number;
  validate: (record: unknown) => TRecord;
}): Promise<SocialFriendPublicRecord<TRecord>[]> {
  const listed = await fetchListRecords<TRecord>(
    input.friend.handle,
    input.friend.did,
    input.collection,
    input.ctx.env,
    input.limit,
  );
  const records = listed.map((entry) => {
    const record = input.validate(entry.record);
    return {
      rkey: entry.rkey,
      uri: entry.uri,
      cid: entry.cid,
      record,
      createdAt: Date.parse(record.createdAt),
      updatedAt: Date.parse(record.updatedAt ?? record.createdAt),
    };
  });
  return input.store.replaceFriendPublicRecords<TRecord>({
    uid: input.uid,
    friendHandle: input.friend.handle,
    collection: input.collection,
    records,
  });
}

async function fetchListRecords<TRecord extends SpaceGsvRecord>(
  handle: string,
  did: SocialDid,
  collection: SpaceGsvCollection,
  env: Env,
  limit: number,
): Promise<Array<{ uri?: string; cid?: string; rkey: string; record: TRecord }>> {
  const url = new URL(`${socialOriginForHandle(env, handle)}/xrpc/com.atproto.repo.listRecords`);
  url.searchParams.set("repo", did);
  url.searchParams.set("collection", collection);
  url.searchParams.set("limit", String(limit));
  const response = await fetch(url.toString());
  const body = await parseFetchBody(response);
  if (!response.ok) {
    throw new Error(`${handle} ${collection} list failed status=${response.status}: ${formatFetchBody(body)}`);
  }
  const object = requireObject(body, `${collection} list response`);
  if (!Array.isArray(object.records)) {
    throw new Error(`${collection} list response records must be an array`);
  }
  return object.records.map((item, index) => {
    const entry = requireObject(item, `${collection} list response.records[${index}]`);
    const uri = entry.uri === undefined ? undefined : requireString(entry.uri, `${collection}.records[${index}].uri`);
    return {
      uri,
      cid: entry.cid === undefined ? undefined : requireString(entry.cid, `${collection}.records[${index}].cid`),
      rkey: uri ? rkeyFromAtUri(uri, collection) : normalizeSocialId(entry.rkey, `${collection}.records[${index}].rkey`),
      record: (entry.value ?? entry.record) as TRecord,
    };
  });
}

function rkeyFromAtUri(uri: string, collection: SpaceGsvCollection): string {
  const parts = uri.split("/");
  const collectionIndex = parts.findIndex((part) => part === collection);
  const rkey = collectionIndex >= 0 ? parts[collectionIndex + 1] : parts.at(-1);
  return normalizeSocialId(rkey, "uri rkey");
}

function parseSocialAtUri(uri: unknown, collection: SpaceGsvCollection): { did: SocialDid; rkey: string } {
  const text = requireString(uri, "uri");
  const prefix = "at://";
  if (!text.startsWith(prefix)) {
    throw new Error("uri must be an at:// URI");
  }
  const parts = text.slice(prefix.length).split("/");
  if (parts.length !== 3 || parts[1] !== collection) {
    throw new Error(`uri must point to ${collection}`);
  }
  return {
    did: normalizeDid(parts[0]),
    rkey: normalizeSocialId(parts[2], "uri rkey"),
  };
}

async function fetchRequiredText(url: string, label: string): Promise<string> {
  const response = await fetch(url);
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`${label} fetch failed status=${response.status}: ${body}`);
  }
  return body;
}

async function parseFetchBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function formatFetchBody(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function toIdentityRecord(row: IdentityRow): SocialIdentityRecord {
  return {
    uid: row.uid,
    did: row.did as SocialDid,
    handle: row.handle ?? undefined,
    pdsEndpoint: row.pds_endpoint,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toServiceSettings(row: SettingsRow): SocialServiceSettings {
  const servicePrivateJwk = JSON.parse(row.service_private_jwk_json) as JsonWebKey;
  return {
    uid: row.uid,
    servicePrivateJwk,
    servicePublicKeyMultibase: row.service_public_key_multibase,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toFriendRecord(row: FriendRow): SocialFriendRecord {
  return {
    uid: row.uid,
    handle: row.handle,
    did: row.did as SocialDid,
    pdsEndpoint: row.pds_endpoint,
    note: row.note ?? "",
    displayName: row.display_name ?? undefined,
    profile: row.profile_json ? JSON.parse(row.profile_json) as SpaceGsvProfileRecord : undefined,
    instance: JSON.parse(row.instance_json) as SpaceGsvInstanceRecord,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    syncedAt: row.synced_at ?? undefined,
  };
}

function toFriendPublicRecord<TRecord extends SpaceGsvRecord>(row: FriendRecordRow): SocialFriendPublicRecord<TRecord> {
  return {
    uid: row.uid,
    friendHandle: row.friend_handle,
    collection: row.collection as SpaceGsvCollection,
    rkey: row.rkey,
    uri: row.uri ?? undefined,
    cid: row.cid ?? undefined,
    record: JSON.parse(row.record_json) as TRecord,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    syncedAt: row.synced_at,
  };
}

function toGrantRecord(row: FriendGrantRow): SocialGrant {
  return {
    operation: row.operation as SocialGrant["operation"],
    scope: row.scope_json ? JSON.parse(row.scope_json) as Record<string, unknown> : undefined,
    expiresAt: row.expires_at ?? undefined,
  };
}

function toFriendSummary(friend: SocialFriendRecord, grants: SocialGrant[]): SocialContactSummary {
  return {
    handle: friend.handle,
    note: friend.note,
    displayName: friend.displayName,
    description: friend.profile?.description,
    acceptsContact: true,
    acceptedSocialMethods: friend.instance.acceptedSocialMethods,
    grants,
    createdAt: new Date(friend.createdAt).toISOString(),
    updatedAt: new Date(friend.updatedAt).toISOString(),
    syncedAt: friend.syncedAt ? new Date(friend.syncedAt).toISOString() : undefined,
  };
}

function toThreadRecord(row: ThreadRow): SocialThreadRecord {
  return {
    uid: row.uid,
    threadId: row.thread_id,
    peerHandle: row.peer_handle,
    conversationId: row.conversation_id,
    status: row.status as SocialThreadStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at ?? undefined,
  };
}

function toThreadSummary(thread: SocialThreadRecord): SocialThreadSummary {
  return {
    threadId: thread.threadId,
    peerHandle: thread.peerHandle,
    conversationId: thread.conversationId,
    status: thread.status,
    createdAt: new Date(thread.createdAt).toISOString(),
    updatedAt: new Date(thread.updatedAt).toISOString(),
    expiresAt: thread.expiresAt,
  };
}

function toMessageRecord(row: MessageRow): SocialMessageRecord {
  return {
    uid: row.uid,
    messageId: row.message_id,
    threadId: row.thread_id,
    direction: row.direction as SocialMessageDirection,
    fromHandle: row.from_handle,
    toHandle: row.to_handle,
    sender: row.sender_json ? JSON.parse(row.sender_json) as SocialMessageSender : undefined,
    text: row.text ?? undefined,
    body: row.body_json ? JSON.parse(row.body_json) as unknown : undefined,
    deliveryMethod: row.delivery_method ? row.delivery_method as SocialRemoteOperation : undefined,
    deliveryStatus: row.delivery_status as SocialMessageSummary["deliveryStatus"],
    deliveryAttemptCount: row.delivery_attempt_count ?? 0,
    nextRetryAt: row.next_retry_at ?? undefined,
    retryScheduleId: row.retry_schedule_id ?? undefined,
    lastDeliveryError: row.last_delivery_error ?? undefined,
    remoteEventId: row.remote_event_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toMessageSummary(message: SocialMessageRecord): SocialMessageSummary {
  return {
    messageId: message.messageId,
    threadId: message.threadId,
    direction: message.direction,
    fromHandle: message.fromHandle,
    toHandle: message.toHandle,
    sender: message.sender,
    text: message.text,
    body: message.body,
    deliveryStatus: message.deliveryStatus,
    createdAt: new Date(message.createdAt).toISOString(),
    updatedAt: new Date(message.updatedAt).toISOString(),
  };
}

function toMessageStatusRecord(row: MessageStatusRow): SocialMessageStatusRecord {
  return {
    uid: row.uid,
    messageId: row.message_id,
    threadId: row.thread_id,
    state: row.state as SocialMessageStatusState,
    summary: row.summary ?? undefined,
    needsHumanReason: row.needs_human_reason ?? undefined,
    body: row.body_json ? JSON.parse(row.body_json) as unknown : undefined,
    remoteEventId: row.remote_event_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toMessageStatusSummary(
  status: SocialMessageStatusRecord,
  message: SocialMessageRecord,
): SocialMessageStatusSummary {
  return {
    messageId: status.messageId,
    threadId: status.threadId,
    direction: message.direction,
    fromHandle: message.fromHandle,
    toHandle: message.toHandle,
    state: status.state,
    summary: status.summary,
    needsHumanReason: status.needsHumanReason,
    body: status.body,
    createdAt: new Date(status.createdAt).toISOString(),
    updatedAt: new Date(status.updatedAt).toISOString(),
  };
}

function summarizeMessageStatusesForThread(
  store: SocialStore,
  uid: number,
  threadId: string,
): SocialMessageStatusSummary[] {
  return store.listMessageStatusesForThread(uid, threadId).flatMap((status) => {
    const message = store.getMessage(uid, status.messageId);
    return message ? [toMessageStatusSummary(status, message)] : [];
  });
}

function toPublicRecord<TRecord extends SpaceGsvRecord>(row: RecordRow): SocialPublicRecord<TRecord> {
  return {
    uid: row.uid,
    collection: row.collection as SpaceGsvCollection,
    rkey: row.rkey,
    uri: row.uri ?? undefined,
    cid: row.cid ?? undefined,
    record: JSON.parse(row.record_json) as TRecord,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function ensureServiceSettings(store: SocialStore, uid: number): Promise<SocialServiceSettings> {
  const existing = store.getSettings(uid);
  if (existing) {
    return existing;
  }
  const generated = await generateP256ServiceKey();
  return store.upsertSettings({
    uid,
    servicePrivateJwk: generated.privateJwk,
    servicePublicKeyMultibase: generated.publicKeyMultibase,
  });
}

export async function generateP256ServiceKey(): Promise<{
  privateJwk: JsonWebKey;
  publicKeyMultibase: string;
}> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair;
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey) as JsonWebKey;
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey) as JsonWebKey;
  return {
    privateJwk,
    publicKeyMultibase: p256PublicJwkToMultibase(publicJwk),
  };
}

export type UnsignedSocialEnvelope = Omit<SocialSignedRequestEnvelope, "signature">;

export async function signSocialEnvelope(
  envelope: UnsignedSocialEnvelope,
  privateJwk: JsonWebKey,
): Promise<SocialSignedRequestEnvelope> {
  assertCanonicalJsonValue(envelope.body, "envelope.body");
  const key = await crypto.subtle.importKey(
    "jwk",
    privateJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    socialEnvelopeSigningBytes(envelope),
  ));
  return {
    ...envelope,
    signature: base64UrlEncode(signature),
  };
}

async function verifySocialEnvelopeSignature(
  envelope: SocialSignedRequestEnvelope,
  publicKeyMultibase: string,
): Promise<boolean> {
  let signature: Uint8Array;
  let publicJwk: JsonWebKey;
  try {
    signature = base64UrlDecode(envelope.signature);
    publicJwk = p256PublicMultibaseToJwk(publicKeyMultibase);
  } catch {
    return false;
  }
  const key = await crypto.subtle.importKey(
    "jwk",
    publicJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  return await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    signature,
    socialEnvelopeSigningBytes(envelope),
  );
}

function socialEnvelopeSigningBytes(envelope: UnsignedSocialEnvelope | SocialSignedRequestEnvelope): Uint8Array {
  return new TextEncoder().encode(canonicalJson({
    id: envelope.id,
    method: envelope.method,
    fromDid: envelope.fromDid,
    toDid: envelope.toDid,
    createdAt: envelope.createdAt,
    expiresAt: envelope.expiresAt,
    nonce: envelope.nonce,
    keyId: envelope.keyId,
    body: envelope.body,
  }));
}

function canonicalJson(value: unknown): string {
  assertCanonicalJsonValue(value, "value");
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(object[key])}`
  ).join(",")}}`;
}

function assertCanonicalJsonValue(value: unknown, field: string): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertCanonicalJsonValue(item, `${field}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      assertCanonicalJsonValue(item, `${field}.${key}`);
    }
    return;
  }
  throw new Error(`${field} must be JSON-serializable`);
}

function p256PublicJwkToMultibase(jwk: JsonWebKey): string {
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.x || !jwk.y) {
    throw new Error("generated service key is not a P-256 public key");
  }
  const x = leftPadBytes(base64UrlDecode(jwk.x), 32);
  const y = leftPadBytes(base64UrlDecode(jwk.y), 32);
  const compressed = new Uint8Array(35);
  compressed[0] = 0x80;
  compressed[1] = 0x24;
  compressed[2] = y[31] % 2 === 0 ? 0x02 : 0x03;
  compressed.set(x, 3);
  return `z${base58Encode(compressed)}`;
}

function p256PublicMultibaseToJwk(value: string): JsonWebKey {
  if (!value.startsWith("z")) {
    throw new Error("service key must be base58btc multibase");
  }
  const bytes = base58Decode(value.slice(1));
  if (
    bytes.length !== 35 ||
    bytes[0] !== P256_MULTICODEC_PREFIX[0] ||
    bytes[1] !== P256_MULTICODEC_PREFIX[1] ||
    (bytes[2] !== 0x02 && bytes[2] !== 0x03)
  ) {
    throw new Error("service key is not a compressed P-256 public key");
  }
  const xBytes = bytes.slice(3);
  const x = bytesToBigInt(xBytes);
  const ySquared = mod(x ** 3n - 3n * x + P256_B, P256_FIELD_PRIME);
  let y = modPow(ySquared, (P256_FIELD_PRIME + 1n) / 4n, P256_FIELD_PRIME);
  if (mod(y * y - ySquared, P256_FIELD_PRIME) !== 0n) {
    throw new Error("service key is not on the P-256 curve");
  }
  const wantsOddY = bytes[2] === 0x03;
  if ((y & 1n) !== (wantsOddY ? 1n : 0n)) {
    y = P256_FIELD_PRIME - y;
  }
  return {
    kty: "EC",
    crv: "P-256",
    x: base64UrlEncode(xBytes),
    y: base64UrlEncode(bigIntToBytes(y, 32)),
    ext: true,
  };
}

function leftPadBytes(bytes: Uint8Array, length: number): Uint8Array {
  if (bytes.length > length) {
    throw new Error("encoded key coordinate is too large");
  }
  if (bytes.length === length) {
    return bytes;
  }
  const padded = new Uint8Array(length);
  padded.set(bytes, length - bytes.length);
  return padded;
}

function base64UrlDecode(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function base58Encode(bytes: Uint8Array): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i += 1) {
      const value = digits[i] * 256 + carry;
      digits[i] = value % 58;
      carry = Math.floor(value / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }

  let output = "";
  for (const byte of bytes) {
    if (byte !== 0) break;
    output += alphabet[0];
  }
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    output += alphabet[digits[i]];
  }
  return output;
}

function base58Decode(value: string): Uint8Array {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const indexes = new Map([...alphabet].map((char, index) => [char, index]));
  const bytes = [0];
  for (const char of value) {
    const index = indexes.get(char);
    if (index === undefined) {
      throw new Error("invalid base58 character");
    }
    let carry = index;
    for (let i = 0; i < bytes.length; i += 1) {
      const next = bytes[i] * 58 + carry;
      bytes[i] = next & 0xff;
      carry = next >> 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  let leadingZeros = 0;
  for (const char of value) {
    if (char !== alphabet[0]) break;
    leadingZeros += 1;
  }
  const decoded = new Uint8Array(leadingZeros + bytes.length);
  for (let i = 0; i < bytes.length; i += 1) {
    decoded[decoded.length - 1 - i] = bytes[i];
  }
  return decoded;
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let output = 0n;
  for (const byte of bytes) {
    output = (output << 8n) + BigInt(byte);
  }
  return output;
}

function bigIntToBytes(value: bigint, length: number): Uint8Array {
  const output = new Uint8Array(length);
  let remaining = value;
  for (let index = length - 1; index >= 0; index -= 1) {
    output[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  if (remaining !== 0n) {
    throw new Error("integer is too large");
  }
  return output;
}

function mod(value: bigint, modulus: bigint): bigint {
  const result = value % modulus;
  return result >= 0n ? result : result + modulus;
}

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  let value = mod(base, modulus);
  let power = exponent;
  while (power > 0n) {
    if (power & 1n) {
      result = mod(result * value, modulus);
    }
    value = mod(value * value, modulus);
    power >>= 1n;
  }
  return result;
}

function randomSetupPassword(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function compactRecord<T extends Record<string, unknown>>(value: T): T {
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) {
      output[key] = item;
    }
  }
  return output as T;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
