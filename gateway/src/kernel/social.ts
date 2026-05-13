import type {
  SocialAgentCardGetArgs,
  SocialAgentCardGetResult,
  SocialAgentCardUpdateArgs,
  SocialAgentCardUpdateResult,
  SocialAtUri,
  SocialDid,
  SocialFriendAddArgs,
  SocialFriendAddResult,
  SocialFriendGrantsSetArgs,
  SocialFriendGrantsSetResult,
  SocialFriendListArgs,
  SocialFriendListResult,
  SocialFriendRemoveArgs,
  SocialFriendRemoveResult,
  SocialFriendSummary,
  SocialGrant,
  SocialIdentityGetArgs,
  SocialIdentityGetResult,
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
  SocialMessageReplyArgs,
  SocialMessageReplyResult,
  SocialMessageSendArgs,
  SocialMessageSendResult,
  SocialMessageSummary,
  SocialProfileGetArgs,
  SocialProfileGetResult,
  SocialProfileUpdateArgs,
  SocialProfileUpdateResult,
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
  SpaceGsvAgentCardRecord,
  SpaceGsvCollection,
  SpaceGsvInstanceRecord,
  SpaceGsvProfileRecord,
  SpaceGsvRecord,
} from "@gsv/protocol/syscalls/social";
import type { ProcessIdentity } from "@gsv/protocol/syscalls/system";
import {
  isSocialRemoteOperation,
  SPACE_GSV_AGENT_CARD,
  SPACE_GSV_INSTANCE,
  SPACE_GSV_PROFILE,
  SOCIAL_REMOTE_OPERATIONS,
} from "@gsv/protocol/syscalls/social";
import type { RequestFrame } from "../protocol/frames";
import type { KernelContext } from "./context";
import { requirePdsClient } from "../pds/client";
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
  display_name: string | null;
  profile_json: string | null;
  instance_json: string;
  agent_card_json: string | null;
  created_at: number;
  updated_at: number;
  synced_at: number | null;
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
  topic: string | null;
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
  reply_to_message_id: string | null;
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

export type SocialFriendRecord = {
  uid: number;
  handle: string;
  did: SocialDid;
  pdsEndpoint: string;
  displayName?: string;
  profile?: SpaceGsvProfileRecord;
  instance: SpaceGsvInstanceRecord;
  agentCard?: SpaceGsvAgentCardRecord;
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
  topic?: string;
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
  text?: string;
  body?: unknown;
  replyToMessageId?: string;
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

export type SocialDeliveryRetryResult =
  | { retried: true; message: SocialMessageSummary }
  | { retried: false; reason: string };

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
        topic TEXT,
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
        reply_to_message_id TEXT,
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
    for (const statement of [
      "ALTER TABLE social_messages ADD COLUMN delivery_method TEXT",
      "ALTER TABLE social_messages ADD COLUMN delivery_attempt_count INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE social_messages ADD COLUMN next_retry_at INTEGER",
      "ALTER TABLE social_messages ADD COLUMN retry_schedule_id TEXT",
      "ALTER TABLE social_messages ADD COLUMN last_delivery_error TEXT",
    ]) {
      try {
        this.sql.exec(statement);
      } catch {}
    }
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
    displayName?: string;
    profile?: SpaceGsvProfileRecord;
    instance: SpaceGsvInstanceRecord;
    agentCard?: SpaceGsvAgentCardRecord;
  }): { friend: SocialFriendRecord; created: boolean } {
    const existing = this.getFriend(input.uid, input.handle);
    const now = Date.now();
    const createdAt = existing?.createdAt ?? now;
    this.sql.exec(
      `INSERT OR REPLACE INTO social_friends
        (uid, handle, did, pds_endpoint, display_name, profile_json, instance_json, agent_card_json, created_at, updated_at, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.uid,
      input.handle,
      input.did,
      input.pdsEndpoint,
      input.displayName ?? null,
      input.profile ? JSON.stringify(input.profile) : null,
      JSON.stringify(input.instance),
      input.agentCard ? JSON.stringify(input.agentCard) : null,
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
        displayName: input.displayName,
        profile: input.profile,
        instance: input.instance,
        agentCard: input.agentCard,
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

  toFriendSummary(friend: SocialFriendRecord): SocialFriendSummary {
    const grants = this.getFriendGrants(friend.uid, friend.handle);
    return toFriendSummary(friend, grants);
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
    topic?: string;
    expiresAt?: string;
    now?: number;
  }): SocialThreadRecord {
    const existing = this.getThread(input.uid, input.threadId);
    const now = input.now ?? Date.now();
    const createdAt = existing?.createdAt ?? now;
    const status = input.status ?? existing?.status ?? "active";
    const topic = input.topic ?? existing?.topic;
    const expiresAt = input.expiresAt ?? existing?.expiresAt;
    const conversationId = existing?.conversationId ?? socialConversationId(input.peerHandle, input.threadId);
    this.sql.exec(
      `INSERT OR REPLACE INTO social_threads
        (uid, thread_id, peer_handle, conversation_id, status, topic, created_at, updated_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.uid,
      input.threadId,
      input.peerHandle,
      conversationId,
      status,
      topic ?? null,
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
      topic,
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
    text?: string;
    body?: unknown;
    replyToMessageId?: string;
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
         reply_to_message_id, delivery_method, delivery_status, delivery_attempt_count,
         next_retry_at, retry_schedule_id, last_delivery_error, remote_event_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.uid,
      input.messageId,
      input.threadId,
      input.direction,
      input.fromHandle,
      input.toHandle,
      input.text ?? null,
      input.body === undefined ? null : JSON.stringify(input.body),
      input.replyToMessageId ?? null,
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
      text: input.text,
      body: input.body,
      replyToMessageId: input.replyToMessageId,
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
      agentCard: this.getPublicRecord<SpaceGsvAgentCardRecord>(
        identity.uid,
        SPACE_GSV_AGENT_CARD,
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
  const origin = normalizePublicOrigin(args.origin);
  const handle = origin.hostname.toLowerCase();
  const did = normalizeDid(`did:web:${handle}`);
  const existing = store.getIdentity(uid);
  if (existing && existing.did !== did) {
    throw new Error(`Social identity is already linked to ${existing.did}`);
  }

  const account = await requirePdsClient(ctx.env).ensureAccount({
    host: origin.host,
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
  const settings = await ensureServiceSettings(store, uid);
  const createdAt = new Date().toISOString();
  const username = ctx.identity?.process.username ?? "GSV";

  const profileRecord = compactRecord({
    $type: SPACE_GSV_PROFILE,
    createdAt,
    displayName: nonEmpty(args.displayName) ?? username,
    description: nonEmpty(args.description),
  }) as SpaceGsvProfileRecord;
  const instanceRecord: SpaceGsvInstanceRecord = {
    $type: SPACE_GSV_INSTANCE,
    createdAt,
    endpoint: origin.origin,
    protocolVersion: 1,
    serviceKey: {
      id: `${did}#gsv-social-key`,
      type: "Multikey",
      publicKeyMultibase: settings.servicePublicKeyMultibase,
    },
    acceptedSocialMethods: [...SOCIAL_REMOTE_OPERATIONS],
  };
  const agentCardRecord = compactRecord({
    $type: SPACE_GSV_AGENT_CARD,
    createdAt,
    displayName: nonEmpty(args.agentDisplayName) ?? `${username}'s GSV`,
    summary: nonEmpty(args.agentSummary) ?? "Can receive messages and requests from approved friends.",
    acceptsMessages: true,
    acceptsRequests: true,
    humanEscalation: "sometimes",
  }) as SpaceGsvAgentCardRecord;

  const profile = await publishSelfRecord(ctx, identity, SPACE_GSV_PROFILE, profileRecord);
  const instance = await publishSelfRecord(ctx, identity, SPACE_GSV_INSTANCE, instanceRecord);
  const agentCard = await publishSelfRecord(ctx, identity, SPACE_GSV_AGENT_CARD, agentCardRecord);

  return {
    identity: store.toLocalIdentity(identity),
    createdAccount: account.created,
    records: {
      profile: profile.uri as SocialAtUri | undefined,
      instance: instance.uri as SocialAtUri | undefined,
      agentCard: agentCard.uri as SocialAtUri | undefined,
    },
  };
}

export function handleSocialIdentityGet(
  _args: SocialIdentityGetArgs,
  ctx: KernelContext,
): SocialIdentityGetResult {
  const uid = requireUserUid(ctx);
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
  const pdsEndpoint = normalizePdsEndpoint(args.pdsEndpoint);
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

export function handleSocialAgentCardGet(
  args: SocialAgentCardGetArgs,
  ctx: KernelContext,
): SocialAgentCardGetResult {
  const resolved = resolveReadableIdentity(args.handle, ctx);
  return {
    agentCard: resolved
      ? requireSocialStore(ctx).getPublicRecord<SpaceGsvAgentCardRecord>(
          resolved.uid,
          SPACE_GSV_AGENT_CARD,
        )?.record ?? null
      : null,
  };
}

export async function handleSocialAgentCardUpdate(
  args: SocialAgentCardUpdateArgs,
  ctx: KernelContext,
): Promise<SocialAgentCardUpdateResult> {
  const identity = requireWritableSocialIdentity(ctx);
  const record = validateAgentCardRecord(args.record);
  const result = await publishSelfRecord(ctx, identity, SPACE_GSV_AGENT_CARD, record);
  return {
    record: result.record,
    uri: result.uri as SocialAtUri | undefined,
  };
}

export function handleSocialFriendList(
  _args: SocialFriendListArgs,
  ctx: KernelContext,
): SocialFriendListResult {
  const uid = requireMainSocialUserUid(ctx);
  const store = requireSocialStore(ctx);
  return {
    friends: store.listFriends(uid).map((friend) => store.toFriendSummary(friend)),
  };
}

export async function handleSocialFriendAdd(
  args: SocialFriendAddArgs,
  ctx: KernelContext,
): Promise<SocialFriendAddResult> {
  const uid = requireMainSocialUserUid(ctx);
  const identity = requireWritableSocialIdentity(ctx);
  const handle = normalizeHandle(args.handle, "handle");
  if (identity.handle === handle) {
    throw new Error("Cannot add the local GSV identity as a friend");
  }
  const grants = args.grants === undefined ? undefined : validateGrants(args.grants);
  const publicIdentity = await resolveFriendPublicIdentity(handle);
  const displayName = nonEmpty(args.displayName)
    ?? nonEmpty(publicIdentity.profile?.displayName)
    ?? nonEmpty(publicIdentity.agentCard?.displayName)
    ?? handle;
  const store = requireSocialStore(ctx);
  const { friend, created } = store.upsertFriend({
    uid,
    handle,
    did: publicIdentity.did,
    pdsEndpoint: publicIdentity.instance.endpoint,
    displayName,
    profile: publicIdentity.profile,
    instance: publicIdentity.instance,
    agentCard: publicIdentity.agentCard,
  });
  if (grants !== undefined) {
    store.replaceFriendGrants(uid, handle, grants);
  }
  return {
    friend: store.toFriendSummary(friend),
    created,
  };
}

export function handleSocialFriendRemove(
  args: SocialFriendRemoveArgs,
  ctx: KernelContext,
): SocialFriendRemoveResult {
  const uid = requireMainSocialUserUid(ctx);
  const handle = normalizeHandle(args.handle, "handle");
  return {
    removed: requireSocialStore(ctx).removeFriend(uid, handle),
  };
}

export function handleSocialFriendGrantsSet(
  args: SocialFriendGrantsSetArgs,
  ctx: KernelContext,
): SocialFriendGrantsSetResult {
  const uid = requireMainSocialUserUid(ctx);
  const handle = normalizeHandle(args.handle, "handle");
  const grants = validateGrants(args.grants);
  const store = requireSocialStore(ctx);
  const friend = store.getFriend(uid, handle);
  if (!friend) {
    throw new Error(`Friend is not known: ${handle}`);
  }
  store.replaceFriendGrants(uid, handle, grants);
  return {
    friend: store.toFriendSummary(friend),
  };
}

export async function handleSocialThreadCreate(
  args: SocialThreadCreateArgs,
  ctx: KernelContext,
): Promise<SocialThreadCreateResult> {
  const uid = requireMainSocialUserUid(ctx);
  const localIdentity = requireWritableSocialIdentity(ctx);
  const localHandle = requireLocalHandle(localIdentity);
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
    topic: normalizeOptionalText(args.topic, "topic", 512),
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
  const uid = requireMainSocialUserUid(ctx);
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
  const uid = requireMainSocialUserUid(ctx);
  const threadId = normalizeSocialId(args.threadId, "threadId");
  const store = requireSocialStore(ctx);
  const thread = store.getThread(uid, threadId);
  return {
    thread: thread ? toThreadSummary(thread) : null,
    messages: thread ? store.listMessages(uid, threadId).map(toMessageSummary) : [],
    requests: [],
  };
}

export async function handleSocialMessageSend(
  args: SocialMessageSendArgs,
  ctx: KernelContext,
): Promise<SocialMessageSendResult> {
  const uid = requireMainSocialUserUid(ctx);
  const localIdentity = requireWritableSocialIdentity(ctx);
  const localHandle = requireLocalHandle(localIdentity);
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
  const replyToMessageId = args.replyToMessageId === undefined
    ? undefined
    : normalizeSocialId(args.replyToMessageId, "replyToMessageId");
  const message = store.upsertMessage({
    uid,
    messageId: newSocialId("msg"),
    threadId: thread.threadId,
    direction: "outbound",
    fromHandle: localHandle,
    toHandle,
    text: messageInput.text,
    body: messageInput.body,
    replyToMessageId,
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

export async function handleSocialMessageReply(
  args: SocialMessageReplyArgs,
  ctx: KernelContext,
): Promise<SocialMessageReplyResult> {
  const uid = requireMainSocialUserUid(ctx);
  const localIdentity = requireWritableSocialIdentity(ctx);
  const localHandle = requireLocalHandle(localIdentity);
  const store = requireSocialStore(ctx);
  const thread = requireExistingThread(store, uid, args.threadId);
  const friend = requireFriend(store, uid, thread.peerHandle);
  requireRemoteMethod(friend, "social.message.reply");
  const messageInput = normalizeMessagePayload(args, "message");
  const replyToMessageId = args.replyToMessageId === undefined
    ? undefined
    : normalizeSocialId(args.replyToMessageId, "replyToMessageId");
  const message = store.upsertMessage({
    uid,
    messageId: newSocialId("msg"),
    threadId: thread.threadId,
    direction: "outbound",
    fromHandle: localHandle,
    toHandle: thread.peerHandle,
    text: messageInput.text,
    body: messageInput.body,
    replyToMessageId,
    deliveryMethod: "social.message.reply",
    deliveryStatus: "queued",
  });
  const delivered = await attemptOutboundDelivery({
    ctx,
    store,
    localIdentity,
    friend,
    thread,
    message,
    method: "social.message.reply",
  });

  return {
    message: toMessageSummary(delivered),
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
    publicIdentity = await resolveFriendServiceIdentity(friend.handle);
  } catch (error) {
    return rejectInbound(error instanceof Error ? error.message : String(error));
  }
  if (publicIdentity.did !== envelope.fromDid) {
    return rejectInbound("Sender handle no longer resolves to envelope DID");
  }
  if (publicIdentity.instance.serviceKey.id !== envelope.keyId) {
    return rejectInbound("Envelope key does not match sender service key");
  }
  if (!publicIdentity.instance.acceptedSocialMethods.includes(envelope.method)) {
    return rejectInbound(`Sender does not accept ${envelope.method}`);
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
    return { retried: false, reason: "friend not found" };
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
  replyToMessageId?: string;
  topic?: string;
  expiresAt?: string;
};

async function attemptOutboundDelivery(input: {
  ctx: KernelContext;
  store: SocialStore;
  localIdentity: SocialIdentityRecord;
  friend: SocialFriendRecord;
  thread: SocialThreadRecord;
  message: SocialMessageRecord;
  method: SocialRemoteOperation;
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
    body: compactRecord({
      threadId: input.thread.threadId,
      messageId: input.message.messageId,
      topic: input.thread.topic,
      text: input.message.text,
      body: input.message.body,
      replyToMessageId: input.message.replyToMessageId,
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
  if (
    input.envelope.method !== "social.thread.create" &&
    input.envelope.method !== "social.message.send" &&
    input.envelope.method !== "social.message.reply"
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

  const body = normalizeInboundMessageBody(input.envelope.body, input.envelope.method);
  const threadId = body.threadId ?? newSocialId("thread");
  const thread = input.store.upsertThread({
    uid: MAIN_SOCIAL_UID,
    threadId,
    peerHandle: input.friend.handle,
    topic: body.topic,
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
    text: body.text,
    body: body.body,
    replyToMessageId: body.replyToMessageId,
    deliveryMethod: input.envelope.method,
    deliveryStatus: "delivered",
    remoteEventId: input.envelope.id,
    now: input.now,
  });

  try {
    await deliverInboundMessageToInit(input.ctx, thread, message);
  } catch (error) {
    console.error("[social.inbound] failed to deliver message to init process", error);
  }

  return {
    ok: true,
    status: "accepted",
    threadId: thread.threadId,
    messageId: message.messageId,
  };
}

async function deliverInboundMessageToInit(
  ctx: KernelContext,
  thread: SocialThreadRecord,
  message: SocialMessageRecord,
): Promise<void> {
  const identity = identityForUid(MAIN_SOCIAL_UID, ctx);
  const pid = await ensureUserInitProcess(identity, ctx);
  const frame: RequestFrame<"proc.send"> = {
    type: "req",
    id: crypto.randomUUID(),
    call: "proc.send",
    args: {
      pid,
      conversationId: thread.conversationId,
      message: renderInboundSocialMessage(thread, message),
    },
  };
  await sendFrameToProcess(pid, frame);
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

async function ensureUserInitProcess(identity: ProcessIdentity, ctx: KernelContext): Promise<string> {
  const { pid, created } = ctx.procs.ensureInit(identity);
  if (created) {
    const frame: RequestFrame<"proc.setidentity"> = {
      type: "req",
      id: crypto.randomUUID(),
      call: "proc.setidentity",
      args: { pid, identity, profile: "init" },
    };
    const response = await sendFrameToProcess(pid, frame);
    if (!response || response.type !== "res" || !response.ok) {
      throw new Error("Failed to initialize init process");
    }
  }
  return pid;
}

function renderInboundSocialMessage(thread: SocialThreadRecord, message: SocialMessageRecord): string {
  const lines = [
    "Social message received.",
    `From: ${message.fromHandle}`,
    `Thread: ${thread.threadId}`,
    `Message: ${message.messageId}`,
  ];
  if (message.replyToMessageId) {
    lines.push(`Reply-To: ${message.replyToMessageId}`);
  }
  if (thread.topic) {
    lines.push(`Topic: ${thread.topic}`);
  }
  if (message.text) {
    lines.push("", message.text);
  }
  if (message.body !== undefined) {
    lines.push("", "Structured body:", JSON.stringify(message.body, null, 2));
  }
  return lines.join("\n");
}

async function publishSelfRecord<TRecord extends SpaceGsvRecord>(
  ctx: KernelContext,
  identity: SocialIdentityRecord,
  collection: SpaceGsvCollection,
  record: TRecord,
): Promise<SocialPublicRecord<TRecord>> {
  const host = new URL(identity.pdsEndpoint).host;
  const response = await requirePdsClient(ctx.env).putRecord({
    host,
    repo: identity.did,
    collection,
    rkey: SELF_RKEY,
    record,
    validate: true,
  });
  return requireSocialStore(ctx).upsertPublicRecord({
    uid: identity.uid,
    collection,
    rkey: SELF_RKEY,
    record,
    uri: response.uri,
    cid: response.cid,
  });
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
  return store.getIdentity(requireUserUid(ctx));
}

function requireWritableSocialIdentity(ctx: KernelContext): SocialIdentityRecord {
  const identity = requireSocialStore(ctx).getIdentity(requireUserUid(ctx));
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
    throw new Error(`Friend is not known: ${handle}`);
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
  return message.replyToMessageId ? "social.message.reply" : "social.message.send";
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

function newSocialId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
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

function normalizeInboundMessageBody(
  value: unknown,
  method: SocialRemoteOperation,
): InboundMessageBody {
  const object = requireObject(value, "envelope.body");
  const payload = normalizeMessagePayload(object, "envelope.body");
  const threadId = object.threadId === undefined
    ? undefined
    : normalizeSocialId(object.threadId, "envelope.body.threadId");
  if (method === "social.message.reply" && !threadId) {
    throw new Error("envelope.body.threadId is required for social.message.reply");
  }
  const messageId = object.messageId === undefined
    ? undefined
    : normalizeSocialId(object.messageId, "envelope.body.messageId");
  const replyToMessageId = object.replyToMessageId === undefined
    ? undefined
    : normalizeSocialId(object.replyToMessageId, "envelope.body.replyToMessageId");
  const topic = normalizeOptionalText(object.topic, "envelope.body.topic", 512);
  const expiresAt = object.expiresAt === undefined
    ? undefined
    : requireIsoStringValue(object.expiresAt, "envelope.body.expiresAt");
  return {
    ...payload,
    threadId,
    messageId,
    replyToMessageId,
    topic,
    expiresAt,
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

function normalizePdsEndpoint(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("pdsEndpoint is required");
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("pdsEndpoint must be a URL");
  }
  if (url.protocol !== "https:" && url.hostname !== "localhost") {
    throw new Error("pdsEndpoint must use https");
  }
  return url.origin;
}

function normalizePublicOrigin(value: unknown): URL {
  if (typeof value !== "string") {
    throw new Error("origin is required");
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("origin must be a URL");
  }
  if (url.protocol !== "https:" && url.hostname !== "localhost") {
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

function validateAgentCardRecord(record: unknown): SpaceGsvAgentCardRecord {
  const value = requireRecordObject(record, SPACE_GSV_AGENT_CARD);
  requireIsoString(value.createdAt, "createdAt");
  optionalString(value.updatedAt, "updatedAt");
  optionalString(value.displayName, "displayName");
  optionalString(value.summary, "summary");
  if (value.topics !== undefined) {
    if (!Array.isArray(value.topics) || !value.topics.every((item) => typeof item === "string")) {
      throw new Error("topics must be an array of strings");
    }
  }
  if (typeof value.acceptsMessages !== "boolean") {
    throw new Error("acceptsMessages must be a boolean");
  }
  if (typeof value.acceptsRequests !== "boolean") {
    throw new Error("acceptsRequests must be a boolean");
  }
  if (
    value.humanEscalation !== undefined &&
    value.humanEscalation !== "never" &&
    value.humanEscalation !== "sometimes" &&
    value.humanEscalation !== "required"
  ) {
    throw new Error("invalid humanEscalation");
  }
  return value as SpaceGsvAgentCardRecord;
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

function optionalString(value: unknown, field: string): void {
  if (value !== undefined && typeof value !== "string") {
    throw new Error(`${field} must be a string`);
  }
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

async function resolveFriendServiceIdentity(handle: string): Promise<{
  did: SocialDid;
  instance: SpaceGsvInstanceRecord;
}> {
  const did = normalizeDid((await fetchRequiredText(
    `https://${handle}/.well-known/atproto-did`,
    `${handle} handle DID`,
  )).trim());
  const instance = await fetchRequiredRecord<SpaceGsvInstanceRecord>(
    handle,
    did,
    SPACE_GSV_INSTANCE,
  );
  return {
    did,
    instance: validateInstanceRecord(instance),
  };
}

async function resolveFriendPublicIdentity(handle: string): Promise<{
  did: SocialDid;
  profile?: SpaceGsvProfileRecord;
  instance: SpaceGsvInstanceRecord;
  agentCard?: SpaceGsvAgentCardRecord;
}> {
  const did = normalizeDid((await fetchRequiredText(
    `https://${handle}/.well-known/atproto-did`,
    `${handle} handle DID`,
  )).trim());

  const [profile, instance, agentCard] = await Promise.all([
    fetchOptionalRecord<SpaceGsvProfileRecord>(handle, did, SPACE_GSV_PROFILE),
    fetchRequiredRecord<SpaceGsvInstanceRecord>(handle, did, SPACE_GSV_INSTANCE),
    fetchOptionalRecord<SpaceGsvAgentCardRecord>(handle, did, SPACE_GSV_AGENT_CARD),
  ]);

  return {
    did,
    profile: profile ? validateProfileRecord(profile) : undefined,
    instance: validateInstanceRecord(instance),
    agentCard: agentCard ? validateAgentCardRecord(agentCard) : undefined,
  };
}

async function fetchRequiredRecord<TRecord extends SpaceGsvRecord>(
  handle: string,
  did: SocialDid,
  collection: SpaceGsvCollection,
): Promise<TRecord> {
  const record = await fetchOptionalRecord<TRecord>(handle, did, collection);
  if (!record) {
    throw new Error(`${handle} did not publish ${collection}/${FRIEND_SELF_RKEY}`);
  }
  return record;
}

async function fetchOptionalRecord<TRecord extends SpaceGsvRecord>(
  handle: string,
  did: SocialDid,
  collection: SpaceGsvCollection,
): Promise<TRecord | null> {
  const url = new URL(`https://${handle}/xrpc/com.atproto.repo.getRecord`);
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
    displayName: row.display_name ?? undefined,
    profile: row.profile_json ? JSON.parse(row.profile_json) as SpaceGsvProfileRecord : undefined,
    instance: JSON.parse(row.instance_json) as SpaceGsvInstanceRecord,
    agentCard: row.agent_card_json ? JSON.parse(row.agent_card_json) as SpaceGsvAgentCardRecord : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    syncedAt: row.synced_at ?? undefined,
  };
}

function toGrantRecord(row: FriendGrantRow): SocialGrant {
  return {
    operation: row.operation as SocialGrant["operation"],
    scope: row.scope_json ? JSON.parse(row.scope_json) as Record<string, unknown> : undefined,
    expiresAt: row.expires_at ?? undefined,
  };
}

function toFriendSummary(friend: SocialFriendRecord, grants: SocialGrant[]): SocialFriendSummary {
  return {
    handle: friend.handle,
    displayName: friend.displayName,
    description: friend.profile?.description,
    agentDisplayName: friend.agentCard?.displayName,
    agentSummary: friend.agentCard?.summary,
    acceptsMessages: friend.agentCard?.acceptsMessages ?? false,
    acceptsRequests: friend.agentCard?.acceptsRequests ?? false,
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
    topic: row.topic ?? undefined,
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
    topic: thread.topic,
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
    text: row.text ?? undefined,
    body: row.body_json ? JSON.parse(row.body_json) as unknown : undefined,
    replyToMessageId: row.reply_to_message_id ?? undefined,
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
    text: message.text,
    body: message.body,
    replyToMessageId: message.replyToMessageId,
    deliveryStatus: message.deliveryStatus,
    createdAt: new Date(message.createdAt).toISOString(),
    updatedAt: new Date(message.updatedAt).toISOString(),
  };
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
