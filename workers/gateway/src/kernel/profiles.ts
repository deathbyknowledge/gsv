import { isHandle } from "@atcute/lexicons/syntax";
import { toBase32 } from "@atcute/multibase";
import type {
  BinaryBody, ProfileAvatar, ProfileAvatarMimeType, ProfileAvatarReadArgs, ProfileAvatarReadResult,
  ProfileAvatarRemoveArgs, ProfileAvatarSetArgs, ProfileFields, ProfileGetResult, ProfilePublishArgs,
  ProfileResolveArgs, ProfileResolveResult, ProfileUnpublishArgs, ProfileUpdateArgs, PublicProfile, ShipProfileRecord,
} from "@humansandmachines/gsv/protocol";
import {
  BLUESKY_PROFILE_COLLECTION, BLUESKY_PROFILE_RKEY, PROFILE_AVATAR_MAX_BYTES, PROFILE_AVATAR_MIME_TYPES, SHIP_PROFILE_COLLECTION, SHIP_PROFILE_RKEY,
  bodyFromBytes, bodyToBytes, cancelBinaryBody, profileContactPolicy, profileFieldsSchema, shipProfileRecordSchema,
} from "@humansandmachines/gsv/protocol";
import { deploymentPresentation } from "@humansandmachines/gsv/services/deployment";
import type { PublicTakedown } from "@humansandmachines/gsv/services/pds";
import { z } from "zod/mini";
import type { KernelContext } from "./context";
import { isLocked } from "../auth/shadow";
import { shipAddress } from "../installation/identity";
import { deleteProfileRecord, publicTakedowns, putProfileMirror, putProfileRecord } from "./atproto";
import { blueskyProfile, type BlueskyProfileRecord } from "./bluesky-profile";
import { requireContactCaller, requireContactHuman } from "./federation/authority";
import { fetchFederation, readFederationJson } from "./federation/http";
import { FederationHttpError } from "./federation/errors";
import type { ProfileAvatarFile } from "./profile-store";
import { DidNotResolvedError, resolveDid, resolveHandle, type ResolvedDid } from "./ships/did-directory";

export type { ShipProfileRecord } from "@humansandmachines/gsv/protocol";

/** What the Ship's public page shows: the record its repository holds, at the profile's address. */
export type PublicProfileProjection = { url: string; handle?: string; cid: string; record: ShipProfileRecord; avatar?: ProfileAvatar };

const revisionSchema = z.int().check(z.nonnegative());
const avatarSetArgsSchema = z.object({ expectedRevision: revisionSchema, mimeType: z.enum(PROFILE_AVATAR_MIME_TYPES) });
const avatarReadArgsSchema = z.object({ cid: z.string().check(z.minLength(1), z.maxLength(128)) });
const addressSchema = z.string().check(z.minLength(1), z.maxLength(2_048));
const recordResponseSchema = z.object({
  uri: z.string(),
  cid: z.string().check(z.minLength(1), z.maxLength(128)),
  value: shipProfileRecordSchema,
});
/** Profile links name the Ship's host: its root, its profile page, or an alias page from before a Ship had one profile. */
const PROFILE_PATH = /^\/(?:profile|@[a-z][a-z0-9_-]{1,31})?$/;
const NO_PUBLIC_PROFILE = "No public profile is available at this address. A private invitation does not require a public profile.";
const UNREADABLE_ADDRESS = "Enter a handle, such as @alice, or a profile address";
const RECORD_LOOKUP_TIMEOUT_MS = 10_000;
const PROFILE_RECORD_PATH = `/${SHIP_PROFILE_COLLECTION}/${SHIP_PROFILE_RKEY}`;
const MIRROR_RECORD_PATH = `/${BLUESKY_PROFILE_COLLECTION}/${BLUESKY_PROFILE_RKEY}`;
/** Invitation codes, acceptances and message requests carry names of at most this many characters. */
const MAX_PERSON_NAME_LENGTH = 256;
/** Sign-in and using the Ship from any surface publish in the background; this bounds how long either waits on the open-network host. */
const BACKGROUND_PUBLISH_TIMEOUT_MS = 60_000;

export function handleProfileGet(ctx: KernelContext): ProfileGetResult {
  const ownerUid = requireContactHuman(ctx);
  const url = profileUrl(ctx);
  const handle = ctx.installationIdentity?.handle;
  const state = ctx.profiles.get(ownerUid, url) ?? { revision: 0, url, draft: defaultProfileDraft(ownerUid, ctx) };
  return { profile: { ...state, ...(handle ? { handle } : undefined) } };
}

/** A profile is named by the Ship's handle, public and open to message requests unless its owner chooses otherwise. */
function defaultProfileDraft(ownerUid: number, ctx: KernelContext): ProfileFields {
  const account = ctx.auth.getPasswdByUid(ownerUid)!;
  const displayName = ctx.installationIdentity?.handle || account.gecos || account.username;
  return { displayName, about: "", contactPolicy: "requests" };
}

/** The name the owner shows to other people: their profile's display name, else their account name. */
export function ownerDisplayName(ownerUid: number, ctx: KernelContext): string | undefined {
  const account = ctx.auth.getPasswdByUid(ownerUid);
  return ctx.profiles.draft(ownerUid)?.fields.displayName ?? account?.gecos ?? account?.username;
}

/** The name this Ship's person goes by with someone new: their profile name, else their account's. */
export function personName(ownerUid: number, ctx: KernelContext): string {
  const account = ctx.auth.getPasswdByUid(ownerUid);
  if (!account) throw new Error("Contact owner account is unavailable");
  const name = ownerDisplayName(ownerUid, ctx)?.trim() || account.username;
  return name.length <= MAX_PERSON_NAME_LENGTH ? name : account.username;
}

/**
 * Publish the owner's profile once by default, and write a profile published
 * before profiles were records to the Ship's repository. Runs on every human
 * sign-in. The default applies only once, so a later unpublish stays private;
 * after that, sign-in only adds the Bluesky copy a published profile is
 * missing, once the host's takedowns allow it. Any saved profile is the
 * owner's own choice: a draft, a published profile and one they unpublished
 * before this default existed are left alone. Without an open-network host
 * nothing publishes, so the default waits for one.
 */
export async function ensureDefaultProfile(ownerUid: number, ctx: KernelContext): Promise<void> {
  if (!ctx.env.PDS || !profileOwnerActive(ownerUid, ctx)) return;
  const key = `users/${ownerUid}/profile/default_published`;
  if (!ctx.profiles.pendingPublication(ownerUid) && ctx.config.getExplicit(key) === "1" && profileMirrored(ownerUid, ctx)) return;
  await publishInBackground(ctx, async (background) => {
    await applyDefaultProfile(ownerUid, key, background);
    await mirrorPublishedProfile(ownerUid, background);
  });
}

/**
 * Writes what a published profile is missing when the owner's existing Ship is
 * used from any surface, such as a messenger: a record published before
 * profiles were records, or the Bluesky copy, once the host's takedowns allow
 * it. The default is left to sign-in. Once nothing is missing, this reads only
 * the Kernel.
 */
export async function ensurePublishedProfile(ownerUid: number, ctx: KernelContext): Promise<void> {
  if (!ctx.env.PDS || !profileOwnerActive(ownerUid, ctx)) return;
  if (!ctx.profiles.pendingPublication(ownerUid) && profileMirrored(ownerUid, ctx)) return;
  await publishInBackground(ctx, async (background) => {
    await publishPendingProfile(ownerUid, background);
    await mirrorPublishedProfile(ownerUid, background);
  });
}

/** Publishes away from the caller, within the time the open-network host gets for it. */
async function publishInBackground(ctx: KernelContext, publish: (background: KernelContext) => Promise<void>): Promise<void> {
  // The timer ends with the publish; one left pending would hold the Kernel awake after the sign-in or message that started it.
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new Error("The open-network host took too long to publish the profile")), BACKGROUND_PUBLISH_TIMEOUT_MS);
  try {
    await publish({ ...ctx, requestSignal: ctx.requestSignal ? AbortSignal.any([ctx.requestSignal, timeout.signal]) : timeout.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Writes a profile published before profiles were records to the Ship's repository, as it was published. */
export async function publishPendingProfile(ownerUid: number, ctx: KernelContext): Promise<void> {
  if (!ctx.profiles.pendingPublication(ownerUid)) return;
  await ctx.profiles.exclusive(async () => {
    // The owner may have published or unpublished it meanwhile.
    const pending = ctx.profiles.pendingPublication(ownerUid);
    if (!pending) return;
    const { cid, mirror } = await putProfileRecord(ctx, pending.record, null, (takedowns) => blueskyMirror(pending.record, takedowns, ctx));
    ctx.profiles.publish(ownerUid, pending.revision, cid, pending.record, null, mirror);
  });
  ctx.broadcastToUserUid(ownerUid, "profile.changed");
}

async function applyDefaultProfile(ownerUid: number, key: string, ctx: KernelContext): Promise<void> {
  await publishPendingProfile(ownerUid, ctx);
  const applied = ctx.config.getExplicit(key);
  if (applied === "1") return;
  const existing = ctx.profiles.draft(ownerUid);
  // "pending" marks a default draft this hook wrote but has not published yet: a failure between the
  // two retries on the next sign-in, while a draft the owner saved themselves is left alone.
  const retry = applied === "pending" && existing && !ctx.profiles.published(ownerUid) && existing.revision === 1;
  if (!existing || retry) {
    if (!existing) {
      ctx.config.set(key, "pending");
      ctx.profiles.update(ownerUid, 0, defaultProfileDraft(ownerUid, ctx));
    }
    await publishProfileRevision(ownerUid, 1, ctx);
    ctx.broadcastToUserUid(ownerUid, "profile.changed");
  }
  ctx.config.set(key, "1");
}

export function handleProfileUpdate(args: ProfileUpdateArgs, ctx: KernelContext): ProfileGetResult {
  const ownerUid = requireContactHuman(ctx);
  const draft = profileFieldsSchema.parse(args.draft);
  if (!draft.displayName.trim()) throw new Error("A public display name is required");
  ctx.profiles.update(ownerUid, revisionSchema.parse(args.expectedRevision), draft);
  ctx.broadcastToUserUid(ownerUid, "profile.changed");
  return handleProfileGet(ctx);
}

/** Replaces the draft's picture with the request body: a PNG, JPEG or WebP of at most 1 MB. */
export async function handleProfileAvatarSet(args: ProfileAvatarSetArgs, ctx: KernelContext, body: BinaryBody | undefined): Promise<ProfileGetResult> {
  try {
    const ownerUid = requireContactHuman(ctx);
    const input = avatarSetArgsSchema.parse(args);
    if (!body) throw new Error("profile.avatar.set requires the picture as its request body");
    if (body.length === undefined) throw new Error("profile.avatar.set requires a request body of declared length");
    if (body.length > PROFILE_AVATAR_MAX_BYTES) throw new Error("Profile pictures are limited to 1 MB");
    const bytes = await bodyToBytes(body, PROFILE_AVATAR_MAX_BYTES, ctx.requestSignal);
    if (!isImage(bytes, input.mimeType)) throw new Error("The picture must be a PNG, JPEG or WebP image");
    const avatar: ProfileAvatarFile = { cid: await blobCid(bytes), mimeType: input.mimeType, size: bytes.byteLength, bytes };
    ctx.profiles.setAvatar(ownerUid, input.expectedRevision, avatar, defaultProfileDraft(ownerUid, ctx));
    ctx.broadcastToUserUid(ownerUid, "profile.changed");
    return handleProfileGet(ctx);
  } finally {
    await cancelBinaryBody(body, "Profile picture request finished");
  }
}

export function handleProfileAvatarRemove(args: ProfileAvatarRemoveArgs, ctx: KernelContext): ProfileGetResult {
  const ownerUid = requireContactHuman(ctx);
  ctx.profiles.setAvatar(ownerUid, revisionSchema.parse(args.expectedRevision), null, defaultProfileDraft(ownerUid, ctx));
  ctx.broadcastToUserUid(ownerUid, "profile.changed");
  return handleProfileGet(ctx);
}

/** A picture's metadata, with its bytes as the response body. */
export type ProfileAvatarResponse = { data: ProfileAvatarReadResult; body: BinaryBody };

/** The draft's or the published picture, for the owner's editor. */
export function handleProfileAvatarRead(args: ProfileAvatarReadArgs, ctx: KernelContext): ProfileAvatarResponse {
  const ownerUid = requireContactHuman(ctx);
  const { cid } = avatarReadArgsSchema.parse(args);
  const avatar = ctx.profiles.ownAvatar(ownerUid, cid);
  if (!avatar) throw new Error("This picture isn't on your profile");
  return { data: { cid: avatar.cid, mimeType: avatar.mimeType, size: avatar.size }, body: bodyFromBytes(avatar.bytes) };
}

export async function handleProfilePublish(args: ProfilePublishArgs, ctx: KernelContext): Promise<ProfileGetResult> {
  const ownerUid = requireContactHuman(ctx);
  await publishProfileRevision(ownerUid, revisionSchema.parse(args.expectedRevision), ctx);
  ctx.broadcastToUserUid(ownerUid, "profile.changed");
  return handleProfileGet(ctx);
}

/** Writes the owner's saved draft at exactly `revision` to the Ship's repository; the first publish creates the Ship's DID. */
async function publishProfileRevision(ownerUid: number, revision: number, ctx: KernelContext): Promise<void> {
  await ctx.profiles.exclusive(async () => {
    const draft = ctx.profiles.draft(ownerUid);
    if (!draft || draft.revision !== revision) throw new Error("Profile changed; reload before publishing");
    if (!profileOwnerActive(ownerUid, ctx)) throw new Error("Profile owner is unavailable");
    const avatar = draft.avatar ? ctx.profiles.avatar(draft.avatar.cid) : null;
    const record = profileRecord(draft.fields, avatar);
    const { cid, mirror } = await putProfileRecord(ctx, record, avatar, (takedowns) => blueskyMirror(record, takedowns, ctx));
    // The repository now holds this revision, so it is recorded even if the draft moved on meanwhile.
    ctx.profiles.publish(ownerUid, revision, cid, record, avatar, mirror);
  });
}

/**
 * Bluesky's copy of the profile while the host has some of the Ship's
 * repository down. Bluesky reads the repository's commits rather than the
 * host's takedowns, so a copy written while the host hides the profile, or the
 * copy itself, would show what the host hid: there is none then, and no
 * picture while the host has its file down.
 */
function blueskyMirror(record: ShipProfileRecord, takedowns: PublicTakedown[], ctx: KernelContext): BlueskyProfileRecord | null {
  const hidden = hiddenByHost(takedowns, record.avatar?.ref.$link);
  const copyDown = takedowns.some(({ subject }) => subject.$type === "com.atproto.repo.strongRef" && subject.uri.endsWith(MIRROR_RECORD_PATH));
  return hidden.page || copyDown ? null : blueskyProfile(record, profileUrl(ctx), !hidden.avatar);
}

/** Whether the repository holds the Bluesky copy the published record makes, or the profile is private and needs none. */
function profileMirrored(ownerUid: number, ctx: KernelContext): boolean {
  const published = ctx.profiles.published(ownerUid);
  return !published || ctx.profiles.holdsMirror(ownerUid, blueskyProfile(published.record, profileUrl(ctx)));
}

/**
 * Writes Bluesky's copy of the published profile where the repository holds
 * another: none from before Ships kept one, or one the host's takedowns held
 * back. It asks the host only then, so reaching the Ship after the copy is
 * written asks nothing.
 */
async function mirrorPublishedProfile(ownerUid: number, ctx: KernelContext): Promise<void> {
  if (profileMirrored(ownerUid, ctx)) return;
  await ctx.profiles.exclusive(async () => {
    // The owner may have published or unpublished it meanwhile, or a sign-in and a message both found it missing.
    const published = ctx.profiles.published(ownerUid);
    if (!published || profileMirrored(ownerUid, ctx)) return;
    const mirror = blueskyMirror(published.record, await publicTakedowns(ctx), ctx);
    if (ctx.profiles.holdsMirror(ownerUid, mirror)) return;
    await putProfileMirror(ctx, mirror);
    ctx.profiles.setMirror(ownerUid, mirror);
  });
}

function profileRecord(fields: ProfileFields, avatar: ProfileAvatar | null): ShipProfileRecord {
  const record: ShipProfileRecord = { $type: SHIP_PROFILE_COLLECTION, displayName: fields.displayName, contactPolicy: fields.contactPolicy };
  if (fields.about) record.about = fields.about;
  if (avatar) record.avatar = { $type: "blob", ref: { $link: avatar.cid }, mimeType: avatar.mimeType, size: avatar.size };
  return record;
}

export async function handleProfileUnpublish(args: ProfileUnpublishArgs, ctx: KernelContext): Promise<ProfileGetResult> {
  const ownerUid = requireContactHuman(ctx);
  const revision = revisionSchema.parse(args.expectedRevision);
  await ctx.profiles.exclusive(async () => {
    if (ctx.profiles.draft(ownerUid)?.revision !== revision) throw new Error("Profile changed; reload before unpublishing");
    if (ctx.profiles.published(ownerUid)) await deleteProfileRecord(ctx);
    // The record is gone from the repository, so the profile is private whatever the draft became meanwhile.
    ctx.profiles.unpublish(ownerUid);
  });
  ctx.broadcastToUserUid(ownerUid, "profile.changed");
  return handleProfileGet(ctx);
}

/** Reads the public profile an address names: a handle, with or without its @, or a link to a profile page. */
export async function handleProfileResolve(args: ProfileResolveArgs, ctx: KernelContext): Promise<ProfileResolveResult> {
  requireContactCaller(ctx, false);
  let resolved: ResolvedDid;
  try {
    resolved = await resolveHandle(addressedHandle(addressSchema.parse(args.address), ctx), ctx);
  } catch (error) {
    // A handle that names no account looks the same as a private profile, so neither says which it is.
    if (error instanceof DidNotResolvedError) throw new FederationHttpError(404, NO_PUBLIC_PROFILE);
    throw error;
  }
  return { profile: await readProfileRecord(resolved, ctx) };
}

/** Another Ship's public profile, read from the record its repository holds, with its handle checked both ways. */
export async function readPublicProfile(did: string, ctx: KernelContext): Promise<PublicProfile> {
  const { handle } = await resolveDid(did, ctx);
  if (!handle) throw new DidNotResolvedError(`${did} claims no handle`);
  const resolved = await resolveHandle(handle, ctx);
  if (resolved.did !== did) throw new DidNotResolvedError(`@${handle} names another account`);
  return await readProfileRecord(resolved, ctx);
}

/** The handle an address names. A bare handle is on this Ship's domain; one on the operator's older domain is on its primary domain. */
function addressedHandle(address: string, ctx: KernelContext): string {
  const value = address.trim();
  const link = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : value.includes("/") ? `https://${value}` : null;
  let host = value.replace(/^@/, "");
  if (link) {
    let url: URL;
    try {
      url = new URL(link);
    } catch {
      throw new Error(UNREADABLE_ADDRESS);
    }
    if (url.protocol !== "https:" || url.port || url.username || url.password || url.search || url.hash || !PROFILE_PATH.test(url.pathname)) {
      throw new Error(UNREADABLE_ADDRESS);
    }
    host = url.hostname;
  }
  host = host.toLowerCase().replace(/\.$/, "");
  const presentation = deploymentPresentation(ctx.env.GSV_PUBLIC_CONFIG);
  if (!host.includes(".")) {
    const domain = shipAddress(ctx.installationIdentity, presentation.primaryDomain)?.domain;
    if (!domain) throw new Error("This Ship has no domain for handles; enter the full handle, such as alice.example.com");
    host = `${host}.${domain}`;
  } else if (presentation.primaryDomain) {
    // A Ship's address on one of the operator's older domains names the same Ship on its primary domain.
    const legacy = presentation.legacyDomains.find((domain) => host.endsWith(`.${domain}`) && !host.slice(0, -domain.length - 1).includes("."));
    if (legacy) host = `${host.slice(0, -legacy.length - 1)}.${presentation.primaryDomain}`;
  }
  if (!isHandle(host)) throw new Error(UNREADABLE_ADDRESS);
  return host;
}

async function readProfileRecord(resolved: ResolvedDid, ctx: KernelContext): Promise<PublicProfile> {
  const { did, handle, pdsEndpoint } = resolved;
  if (!handle || !pdsEndpoint) throw new FederationHttpError(404, NO_PUBLIC_PROFILE);
  const url = new URL("/xrpc/com.atproto.repo.getRecord", pdsEndpoint);
  url.search = new URLSearchParams({ repo: did, collection: SHIP_PROFILE_COLLECTION, rkey: SHIP_PROFILE_RKEY }).toString();
  const response = await fetchFederation(url.href, { headers: { accept: "application/json" }, signal: ctx.requestSignal }, ctx, RECORD_LOOKUP_TIMEOUT_MS);
  // A repository answers a record it doesn't hold, and a repository it doesn't serve, with a 400.
  if (response.status === 400) {
    await response.body?.cancel().catch(() => {});
    throw new FederationHttpError(404, NO_PUBLIC_PROFILE);
  }
  // A 404 comes from a host that serves no repositories at all, which says nothing about the profile.
  if (response.status === 404) {
    await response.body?.cancel().catch(() => {});
    throw new FederationHttpError(503, `Couldn't read @${handle}'s profile: its open-network host answered 404. Try again later.`);
  }
  const found = recordResponseSchema.safeParse(await readFederationJson(response, ctx.requestSignal));
  if (!found.success || found.data.uri !== `at://${did}/${SHIP_PROFILE_COLLECTION}/${SHIP_PROFILE_RKEY}`) {
    throw new Error(`@${handle}'s profile isn't one a Ship can read`);
  }
  const record = found.data.value;
  return {
    did, handle, cid: found.data.cid, displayName: record.displayName, about: record.about ?? "",
    contactPolicy: profileContactPolicy(record.contactPolicy), url: `https://${handle}/profile`,
  };
}

/**
 * The Ship's published profile for its public page, while its owner can still
 * sign in and its open-network host serves it. The page shows what the
 * repository's readers see, so it asks the host each time rather than keeping
 * a copy of the host's takedowns that could fall behind.
 */
export async function publicProfileProjection(ctx: KernelContext): Promise<PublicProfileProjection | null> {
  const published = ctx.profiles.page();
  if (!published || !profileOwnerActive(published.ownerUid, ctx)) return null;
  const cid = published.record.avatar?.ref.$link;
  const hidden = hiddenByHost(await publicTakedowns(ctx), cid);
  if (hidden.page) return null;
  const projection: PublicProfileProjection = { url: profileUrl(ctx), cid: published.cid, record: published.record };
  const handle = ctx.installationIdentity?.handle;
  if (handle) projection.handle = handle;
  const avatar = cid && !hidden.avatar ? ctx.profiles.avatar(cid) : null;
  if (avatar) projection.avatar = { cid: avatar.cid, mimeType: avatar.mimeType, size: avatar.size };
  return projection;
}

/** The published record's picture, which the public page shows from the Ship's own host while that host serves it. */
export async function publicProfileAvatar(ctx: KernelContext): Promise<ProfileAvatarFile | null> {
  const published = ctx.profiles.page();
  const cid = published?.record.avatar?.ref.$link;
  if (!published || !cid || !profileOwnerActive(published.ownerUid, ctx)) return null;
  const hidden = hiddenByHost(await publicTakedowns(ctx), cid);
  return hidden.page || hidden.avatar ? null : ctx.profiles.avatar(cid);
}

/**
 * What the host's takedowns hide of the public page: all of it with the account
 * or the profile record, or only the picture its blob holds. Every takedown the
 * host lists is of the Ship's own repository.
 */
function hiddenByHost(takedowns: PublicTakedown[], avatarCid: string | undefined) {
  return {
    page: takedowns.some(({ subject }) => subject.$type === "com.atproto.admin.defs#repoRef"
      || (subject.$type === "com.atproto.repo.strongRef" && subject.uri.endsWith(PROFILE_RECORD_PATH))),
    avatar: avatarCid !== undefined
      && takedowns.some(({ subject }) => subject.$type === "com.atproto.admin.defs#repoBlobRef" && subject.cid === avatarCid),
  };
}

export function profileOwnerActive(ownerUid: number, ctx: KernelContext): boolean {
  const account = ctx.auth.getPasswdByUid(ownerUid);
  const shadow = account ? ctx.auth.getShadowByUsername(account.username) : null;
  return !!account && ownerUid >= 1000 && !ctx.auth.isPersonalAgentUid(ownerUid) && !!shadow && !isLocked(shadow);
}

/** The profile's address: the page on the Ship's handle host, which also names its DID. */
function profileUrl(ctx: KernelContext): string {
  const origin = ctx.installationIdentity?.canonicalOrigin;
  if (!origin) throw new Error("Installation has no canonical origin");
  const address = shipAddress(ctx.installationIdentity, deploymentPresentation(ctx.env.GSV_PUBLIC_CONFIG).primaryDomain);
  return `${address?.origin ?? origin}/profile`;
}

/** Whether the bytes begin as the declared image type does, so the Ship never serves other content as a picture. */
function isImage(bytes: Uint8Array, mimeType: ProfileAvatarMimeType): boolean {
  const starts = (signature: number[], offset = 0) => signature.every((byte, index) => bytes[offset + index] === byte);
  switch (mimeType) {
    case "image/png": return starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/jpeg": return starts([0xff, 0xd8, 0xff]);
    case "image/webp": return starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8);
  }
}

/** The CID a repository names a blob by: CIDv1, raw codec, SHA-256. */
async function blobCid(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice()));
  return `b${toBase32(new Uint8Array([0x01, 0x55, 0x12, 0x20, ...digest]))}`;
}
