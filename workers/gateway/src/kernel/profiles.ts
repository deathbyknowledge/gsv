import type {
  ProfileGetResult, ProfilePublishArgs, ProfileResolveArgs, ProfileResolveResult,
  ProfileUnpublishArgs, ProfileUpdateArgs, PublicProfile,
} from "@humansandmachines/gsv/protocol";
import { jsonValueSchema, profileFieldsSchema, publicProfileSchema } from "@humansandmachines/gsv/protocol";
import { z } from "zod/mini";
import type { KernelContext } from "./context";
import { isLocked } from "../auth/shadow";
import { requireContactCaller, requireContactHuman } from "./federation/authority";
import { fetchFederationJson } from "./federation/http";
import { canonicalJson, normalizeFederationOrigin, sha256Base64Url, verifySignedValue } from "./federation-crypto";

const revisionSchema = z.int().check(z.nonnegative());

export function handleProfileGet(ctx: KernelContext): ProfileGetResult {
  const ownerUid = requireContactHuman(ctx);
  const origin = profileOrigin(ctx);
  const existing = ctx.profiles.get(ownerUid, origin);
  if (existing) return { profile: existing };
  const account = ctx.auth.getPasswdByUid(ownerUid)!;
  return { profile: { revision: 0, publishing: false, publicationFailed: false, draft: {
    alias: "", displayName: account.gecos || account.username, about: "", contactPolicy: "closed", representation: "human",
  } } };
}

export async function handleProfileUpdate(args: ProfileUpdateArgs, ctx: KernelContext): Promise<ProfileGetResult> {
  const ownerUid = requireContactHuman(ctx);
  const draft = profileFieldsSchema.parse(args.draft);
  if (!draft.displayName.trim()) throw new Error("A public display name is required");
  const revision = revisionSchema.parse(args.expectedRevision);
  const account = ctx.auth.getPasswdByUid(ownerUid)!;
  const subject = ctx.federation.ensureSubject(ownerUid, account.gecos || account.username);
  ctx.profiles.update(ownerUid, subject.id, revision, draft);
  ctx.broadcastToUserUid(ownerUid, "profile.changed");
  await ctx.scheduleProfilePublication(ownerUid);
  return handleProfileGet(ctx);
}

export async function handleProfilePublish(args: ProfilePublishArgs, ctx: KernelContext): Promise<ProfileGetResult> {
  const ownerUid = requireContactHuman(ctx);
  const revision = revisionSchema.parse(args.expectedRevision);
  const state = ctx.profiles.get(ownerUid, profileOrigin(ctx));
  if (!state || state.revision !== revision) throw new Error("Profile changed; reload before publishing");
  const identity = await ctx.federationIdentity.ensure(profileOrigin(ctx));
  const subject = ctx.federation.subject(ownerUid);
  if (!subject) throw new Error("Profile subject is unavailable");
  const unsigned: Omit<PublicProfile, "signature"> = {
    ...state.draft, version: 2, domain: "gsv-federation/2/profile",
    actor: { shipId: identity.shipId, subjectId: subject.id }, publicKey: identity.publicKey,
    origin: identity.origin, url: `${identity.origin}/@${state.draft.alias}`,
    revision, publishedAtMs: Date.now(),
  };
  const profile: PublicProfile = { ...unsigned, signature: await ctx.federationIdentity.sign(jsonValueSchema.parse(unsigned)) };
  requireContactHuman(ctx);
  const job = ctx.profiles.preparePublication(ownerUid, revision, profile);
  ctx.broadcastToUserUid(ownerUid, "profile.changed");
  if (job) await ctx.scheduleProfilePublication(ownerUid);
  return handleProfileGet(ctx);
}

export async function handleProfileUnpublish(args: ProfileUnpublishArgs, ctx: KernelContext): Promise<ProfileGetResult> {
  const ownerUid = requireContactHuman(ctx);
  ctx.profiles.unpublish(ownerUid, revisionSchema.parse(args.expectedRevision));
  ctx.broadcastToUserUid(ownerUid, "profile.changed");
  await ctx.scheduleProfilePublication(ownerUid);
  return handleProfileGet(ctx);
}

export async function handleProfileResolve(args: ProfileResolveArgs, ctx: KernelContext): Promise<ProfileResolveResult> {
  const ownerUid = requireContactCaller(ctx, false);
  const input = z.string().check(z.maxLength(2_048)).parse(args.url);
  const url = new URL(input);
  if (!/^\/@[a-z][a-z0-9_-]{1,31}$/.test(url.pathname) || url.search || url.hash || url.username || url.password) throw new Error("Enter one public GSV profile address");
  const profile = publicProfileSchema.parse(await fetchFederationJson(url.href, { method: "GET", headers: { accept: "application/json" }, signal: ctx.requestSignal }, ctx));
  await verifyPublicProfile(profile, url.href);
  requireContactCaller(ctx, false);
  const pinned = ctx.federation.getByRemote(ownerUid, profile.actor.shipId, profile.actor.subjectId);
  if (pinned && (pinned.remoteOrigin !== profile.origin || canonicalJson(jsonValueSchema.parse(pinned.remotePublicKey)) !== canonicalJson(jsonValueSchema.parse(profile.publicKey)))) {
    throw new Error("This profile differs from the pinned contact identity");
  }
  return { profile };
}

export async function verifyPublicProfile(profile: PublicProfile, expectedUrl: string): Promise<void> {
  const { signature, ...unsigned } = profile;
  if (profile.url !== expectedUrl || profile.url !== `${profile.origin}/@${profile.alias}` || normalizeFederationOrigin(profile.origin) !== profile.origin) throw new Error("Profile address does not match its signed identity");
  if (profile.avatar && profile.avatar.url !== `${profile.origin}/_gsv/federation/v2/avatars/${encodeURIComponent(profile.actor.subjectId)}/${profile.avatar.sha256}.png`) throw new Error("Profile image address does not match its signed identity");
  if (profile.actor.shipId !== `ship:${await sha256Base64Url(canonicalJson(jsonValueSchema.parse(profile.publicKey)))}`) throw new Error("Profile identity does not match its public key");
  if (!await verifySignedValue(profile.publicKey, jsonValueSchema.parse(unsigned), signature)) throw new Error("Profile signature is invalid");
}

export async function processProfilePublication(ownerUid: number, ctx: KernelContext): Promise<void> {
  const job = ctx.profiles.publication(ownerUid);
  try {
    if (job) {
      if (!profileOwnerActive(ownerUid, ctx)) {
        ctx.profiles.unpublish(ownerUid, ctx.profiles.get(ownerUid, profileOrigin(ctx))!.revision);
      } else {
        await ctx.env.STORAGE.put(job.key, JSON.stringify(job.profile), { httpMetadata: { contentType: "application/json" } });
        if (!profileOwnerActive(ownerUid, ctx)) {
          ctx.profiles.unpublish(ownerUid, ctx.profiles.get(ownerUid, profileOrigin(ctx))!.revision);
        }
        if (ctx.profiles.finishPublication(job)) ctx.broadcastToUserUid(ownerUid, "profile.changed");
        else ctx.profiles.retireObject(ownerUid, job.key);
      }
    }
  } catch (error) {
    if (job) ctx.profiles.failPublication(job);
    ctx.broadcastToUserUid(ownerUid, "profile.changed");
    throw error;
  }
  for (const key of ctx.profiles.garbage(ownerUid)) {
    await ctx.env.STORAGE.delete(key);
    ctx.profiles.collected(key);
  }
  for (const image of ctx.profiles.claimImageGarbage(ownerUid)) {
    await ctx.env.STORAGE.delete(image.object_key);
    ctx.profiles.imageCollected(image);
  }
}

export function profileOwnerActive(ownerUid: number, ctx: KernelContext): boolean {
  const account = ctx.auth.getPasswdByUid(ownerUid);
  const shadow = account ? ctx.auth.getShadowByUsername(account.username) : null;
  return !!account && ownerUid >= 1000 && !ctx.auth.isPersonalAgentUid(ownerUid) && !!shadow && !isLocked(shadow);
}

function profileOrigin(ctx: KernelContext): string {
  const origin = ctx.installationIdentity?.canonicalOrigin;
  if (!origin) throw new Error("Installation has no canonical origin");
  return origin;
}
