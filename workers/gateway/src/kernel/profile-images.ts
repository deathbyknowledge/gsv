import { z } from "zod/mini";
import { bodyFromBytes, profileAvatarSchema, type BinaryBody, type ProfileAvatar, type ProfileAvatarReadArgs, type ProfileAvatarReadResult, type ProfileAvatarUploadResult } from "@humansandmachines/gsv/protocol";
import type { KernelContext } from "./context";
import { requireContactHuman } from "./federation/authority";
import { fetchFederation, readFederationBody } from "./federation/http";
import { MAX_PROFILE_IMAGE_BYTES, profilePngDimensions } from "./profile-png";
import { handleProfileResolve } from "./profiles";

export async function handleProfileAvatarUpload(ctx: KernelContext, body?: BinaryBody): Promise<ProfileAvatarUploadResult> {
  const ownerUid = requireContactHuman(ctx);
  if (!body) throw new Error("An image body is required");
  const bytes = await readFederationBody(body, MAX_PROFILE_IMAGE_BYTES, ctx.requestSignal);
  const dimensions = profilePngDimensions(bytes);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return ctx.coordinateFederationContact(`profile:${ownerUid}`, async () => {
    requireContactHuman(ctx);
    const origin = ctx.installationIdentity?.canonicalOrigin;
    if (!origin) throw new Error("Installation has no canonical origin");
    const account = ctx.auth.getPasswdByUid(ownerUid)!;
    const subject = ctx.federation.ensureSubject(ownerUid, account.gecos || account.username);
    const avatar: ProfileAvatar = {
      url: `${origin}/_gsv/federation/v2/avatars/${encodeURIComponent(subject.id)}/${sha256}.png`,
      sha256, ...dimensions, size: bytes.byteLength, contentType: "image/png",
    };
    const reservation = ctx.profiles.reserveImage(ownerUid, subject.id, avatar);
    // Persist cleanup before taking ownership of bytes in R2, including failed writes.
    await ctx.scheduleProfilePublication(ownerUid);
    if (reservation.state !== "ready") {
      await ctx.env.STORAGE.put(reservation.object_key, bytes, { httpMetadata: { contentType: "image/png" } });
      requireContactHuman(ctx);
      if (!ctx.profiles.imageReady(reservation)) throw new Error("Image upload was superseded");
    }
    return { avatar };
  });
}

export async function handleProfileAvatarRead(args: ProfileAvatarReadArgs, ctx: KernelContext): Promise<{ data: ProfileAvatarReadResult; body: BinaryBody }> {
  const ownerUid = requireContactHuman(ctx);
  const { sha256, profileUrl } = z.strictObject({
    sha256: z.string().check(z.regex(/^[a-f0-9]{64}$/)),
    profileUrl: z.optional(z.string().check(z.minLength(1), z.maxLength(2_048))),
  }).parse(args);
  if (profileUrl) {
    const { profile } = await handleProfileResolve({ url: profileUrl }, ctx);
    const avatar = profile.avatar;
    if (!avatar || avatar.sha256 !== sha256) throw new Error("Profile image changed; open the profile again");
    const response = await fetchFederation(avatar.url, { method: "GET", headers: { accept: "image/png" }, signal: ctx.requestSignal }, ctx);
    if (response.status !== 200 || response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "image/png") {
      await response.body?.cancel();
      throw new Error("Profile image is unavailable");
    }
    if (!response.body) throw new Error("Profile image has no content");
    const bytes = await readFederationBody({ stream: response.body }, MAX_PROFILE_IMAGE_BYTES, ctx.requestSignal);
    const dimensions = profilePngDimensions(bytes);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const actual = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    if (actual !== sha256 || bytes.byteLength !== avatar.size || dimensions.width !== avatar.width || dimensions.height !== avatar.height) {
      throw new Error("Profile image does not match the published profile");
    }
    requireContactHuman(ctx);
    return { data: { avatar }, body: bodyFromBytes(bytes) };
  }
  const image = ctx.profiles.image(ownerUid, sha256);
  if (image?.state !== "ready") throw new Error("Profile image is unavailable");
  const object = await ctx.env.STORAGE.get(image.object_key);
  if (!object) throw new Error("Profile image is unavailable");
  const bytes = await readFederationBody({ stream: object.body, length: object.size }, MAX_PROFILE_IMAGE_BYTES, ctx.requestSignal);
  requireContactHuman(ctx);
  const current = ctx.profiles.image(ownerUid, sha256);
  if (current?.reservation !== image.reservation || current.state !== "ready") throw new Error("Profile image is unavailable");
  return { data: { avatar: profileAvatarSchema.parse(JSON.parse(image.avatar_json)) }, body: bodyFromBytes(bytes) };
}
