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
  SocialInstanceGetArgs,
  SocialInstanceGetResult,
  SocialInstanceUpdateArgs,
  SocialInstanceUpdateResult,
  SocialLocalIdentity,
  SocialProfileGetArgs,
  SocialProfileGetResult,
  SocialProfileUpdateArgs,
  SocialProfileUpdateResult,
  SocialSetupArgs,
  SocialSetupResult,
  SpaceGsvAgentCardRecord,
  SpaceGsvCollection,
  SpaceGsvInstanceRecord,
  SpaceGsvProfileRecord,
  SpaceGsvRecord,
} from "@gsv/protocol/syscalls/social";
import {
  isSocialRemoteOperation,
  SPACE_GSV_AGENT_CARD,
  SPACE_GSV_INSTANCE,
  SPACE_GSV_PROFILE,
  SOCIAL_REMOTE_OPERATIONS,
} from "@gsv/protocol/syscalls/social";
import type { KernelContext } from "./context";
import { requirePdsClient } from "../pds/client";

const SELF_RKEY = "self";
const DID_PATTERN = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/;
const MAIN_SOCIAL_UID = 1000;
const FRIEND_SELF_RKEY = "self";

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
  }

  getIdentity(uid: number): SocialIdentityRecord | null {
    const rows = this.sql.exec<IdentityRow>(
      "SELECT * FROM social_identities WHERE uid = ? LIMIT 1",
      uid,
    ).toArray();
    return rows[0] ? toIdentityRecord(rows[0]) : null;
  }

  getIdentityByDid(did: string): SocialIdentityRecord | null {
    const rows = this.sql.exec<IdentityRow>(
      "SELECT * FROM social_identities WHERE did = ? LIMIT 1",
      did,
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

  toLocalIdentity(identity: SocialIdentityRecord): SocialLocalIdentity {
    return {
      uid: identity.uid,
      did: identity.did,
      handle: identity.handle,
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
    pdslsRepoUrl: `https://pdsls.dev/at://${did}`,
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
  const did = normalizeDid(args.did);
  const handle = normalizeOptionalHandle(args.handle);
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
  const resolved = resolveReadableIdentity(args.did, ctx);
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
  const resolved = resolveReadableIdentity(args.did, ctx);
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
  const resolved = resolveReadableIdentity(args.did, ctx);
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
  did: SocialDid | undefined,
  ctx: KernelContext,
): SocialIdentityRecord | null {
  const store = requireSocialStore(ctx);
  if (did) {
    return store.getIdentityByDid(normalizeDid(did));
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

function normalizeOptionalHandle(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return normalizeHandle(value, "handle");
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

async function generateP256ServiceKey(): Promise<{
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
