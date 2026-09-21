import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { bodyFromBytes, bodyToBytes, type ProfileFields } from "@humansandmachines/gsv/protocol";
import { profileImageFixture } from "../test-support/profile-image";
import { handleProfileAvatarUpload, handleProfileAvatarRead } from "./profile-images";
import { profilePngDimensions } from "./profile-png";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import { testPeer } from "../test-support/peers";
import { createInstallationStorage } from "../installation/storage";
import type { KernelContext } from "./context";
import { FederationStore } from "./federation-store";
import { FederationIdentity } from "./federation-crypto";
import { ProfileStore } from "./profile-store";
import { handleProfileGet, handleProfileUpdate, handleProfilePublish, handleProfileUnpublish, processProfilePublication, verifyPublicProfile } from "./profiles";

const OWNER = { uid: 1000, gid: 1000, gids: [1000], username: "private-login", gecos: "Person", home: "/home/private-login", cwd: "/home/private-login" };
const DRAFT: ProfileFields = { alias: "public-person", displayName: "Published name", about: "Hello from my space", contactPolicy: "requests", representation: "human-and-ship" };

describe("explicit profile publication", () => {
  it("keeps uploaded images private and collects only images outside every saved or approved snapshot", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const ctx = profileContext(storage);
      const bytes = profileImageFixture();
      const { avatar } = await handleProfileAvatarUpload(ctx, bodyFromBytes(bytes));
      const upload = ctx.profiles.image(OWNER.uid, avatar.sha256)!;
      expect(avatar).toMatchObject({ width: 2, height: 2, size: bytes.length, contentType: "image/png" });
      expect(ctx.profiles.published({ alias: DRAFT.alias })).toBeNull();
      expect(await bodyToBytes((await handleProfileAvatarRead({ sha256: avatar.sha256 }, ctx)).body)).toEqual(bytes);
      await handleProfileUpdate({ expectedRevision: 0, draft: { ...DRAFT, avatar } }, ctx);
      await handleProfilePublish({ expectedRevision: 1 }, ctx);
      await handleProfileUpdate({ expectedRevision: 1, draft: DRAFT }, ctx);
      const later = upload.created_at + 25 * 60 * 60_000;
      expect(ctx.profiles.claimImageGarbage(OWNER.uid, later)).toEqual([]);
      await processProfilePublication(OWNER.uid, ctx);
      expect(ctx.profiles.published({ alias: DRAFT.alias })?.image?.avatar).toEqual(avatar);
      expect(ctx.profiles.claimImageGarbage(OWNER.uid, later)).toEqual([]);
      await handleProfileUnpublish({ expectedRevision: 2 }, ctx);
      expect(ctx.profiles.published({ alias: DRAFT.alias })).toBeNull();
      expect(ctx.profiles.claimImageGarbage(OWNER.uid, later)).toHaveLength(1);
      await expect(handleProfileAvatarRead({ sha256: avatar.sha256 }, ctx)).rejects.toThrow("unavailable");
      expect(ctx.profiles.imageReady(upload)).toBe(false);
      await processProfilePublication(OWNER.uid, ctx);
      expect(await ctx.env.STORAGE.get(upload.object_key)).toBeNull();
      expect(ctx.profiles.image(OWNER.uid, avatar.sha256)).toBeNull();
    });
  });

  it("fences foreign images, changed image descriptors and non-human uploads", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const ctx = profileContext(storage);
      const { avatar } = await handleProfileAvatarUpload(ctx, bodyFromBytes(profileImageFixture()));
      expect(() => ctx.profiles.update(1001, "subject:other", 0, { ...DRAFT, avatar })).toThrow("unavailable");
      await expect(handleProfileUpdate({ expectedRevision: 0, draft: { ...DRAFT, avatar: { ...avatar, url: "https://tracking.example/image" } } }, ctx)).rejects.toThrow("unavailable");
      await expect(handleProfileAvatarUpload({ ...ctx, processId: "proc:ship" })).rejects.toThrow("signed-in human");
      const old = ctx.profiles.image(OWNER.uid, avatar.sha256)!;
      ctx.profiles.claimImageGarbage(OWNER.uid, old.created_at + 25 * 60 * 60_000);
      ctx.profiles.imageCollected(old);
      const subject = ctx.federation.subject(OWNER.uid)!;
      const fresh = ctx.profiles.reserveImage(OWNER.uid, subject.id, avatar);
      expect(fresh.reservation).not.toBe(old.reservation);
      expect(ctx.profiles.imageReady(old)).toBe(false);
      expect(ctx.profiles.imageReady(fresh)).toBe(true);
    });
  });

  it("rejects corrupt, incomplete, animated and oversized image envelopes", () => {
    const valid = profileImageFixture();
    expect(profilePngDimensions(valid)).toEqual({ width: 2, height: 2 });
    const corrupt = valid.slice(); corrupt[29] ^= 1;
    expect(() => profilePngDimensions(corrupt)).toThrow("integrity");
    expect(() => profilePngDimensions(valid.slice(0, -1))).toThrow();
    expect(() => profilePngDimensions(new Uint8Array(262_145))).toThrow("256 KiB");
    const animated = valid.slice(); animated.set(new TextEncoder().encode("acTL"), 37);
    expect(() => profilePngDimensions(animated)).toThrow("static PNG");
  });

  it("starts private and publishes only the exact approved snapshot across later draft edits", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const ctx = profileContext(storage);
      expect(handleProfileGet(ctx).profile).toMatchObject({ revision: 0, draft: { alias: "", contactPolicy: "closed" } });
      await handleProfileUpdate({ expectedRevision: 0, draft: DRAFT }, ctx);
      expect(ctx.profiles.published({ alias: DRAFT.alias })).toBeNull();
      await handleProfilePublish({ expectedRevision: 1 }, ctx);
      const approved = ctx.profiles.publication(OWNER.uid)!;
      await verifyPublicProfile(approved.profile, "https://local.example/@public-person");
      expect(JSON.stringify(approved.profile)).not.toContain(OWNER.username);
      expect(approved.profile).not.toHaveProperty("ownerUid");
      await handleProfileUpdate({ expectedRevision: 1, draft: { ...DRAFT, about: "Private revision" } }, ctx);
      await processProfilePublication(OWNER.uid, ctx);
      expect(handleProfileGet(ctx).profile).toMatchObject({ revision: 2, draft: { about: "Private revision" }, published: { revision: 1 }, publishing: false });
      expect(await (await ctx.env.STORAGE.get(approved.key))!.json()).toEqual(approved.profile);
      await expect(verifyPublicProfile({ ...approved.profile, displayName: "Tampered" }, approved.profile.url)).rejects.toThrow("signature");
    });
  });

  it("does not let a late publication undo unpublishing and cleans the orphan snapshot", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const ctx = profileContext(storage);
      await handleProfileUpdate({ expectedRevision: 0, draft: DRAFT }, ctx);
      await handleProfilePublish({ expectedRevision: 1 }, ctx);
      const job = ctx.profiles.publication(OWNER.uid)!;
      const put = ctx.env.STORAGE.put.bind(ctx.env.STORAGE);
      let release!: () => void;
      let started!: () => void;
      const entered = new Promise<void>((resolve) => { started = resolve; });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const write = vi.spyOn(ctx.env.STORAGE, "put").mockImplementationOnce(async (key, value, options) => {
        started();
        await gate;
        return put(key, value, options);
      });
      const publishing = processProfilePublication(OWNER.uid, ctx);
      await entered;
      await handleProfileUnpublish({ expectedRevision: 1 }, ctx);
      expect(ctx.profiles.published({ alias: DRAFT.alias })).toBeNull();
      release();
      await publishing;
      write.mockRestore();
      expect(ctx.profiles.published({ alias: DRAFT.alias })).toBeNull();
      expect(await ctx.env.STORAGE.get(job.key)).toBeNull();
      expect(ctx.profiles.hasPendingWork(OWNER.uid)).toBe(false);
    });
  });

  it("retains the previous publication on a failed write and retries the same signed revision", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const ctx = profileContext(storage);
      await handleProfileUpdate({ expectedRevision: 0, draft: DRAFT }, ctx);
      await handleProfilePublish({ expectedRevision: 1 }, ctx);
      await processProfilePublication(OWNER.uid, ctx);
      const previous = ctx.profiles.published({ alias: DRAFT.alias })!;
      await handleProfileUpdate({ expectedRevision: 1, draft: { ...DRAFT, alias: "new-alias" } }, ctx);
      await handleProfilePublish({ expectedRevision: 2 }, ctx);
      const pending = ctx.profiles.publication(OWNER.uid)!;
      const write = vi.spyOn(ctx.env.STORAGE, "put").mockRejectedValueOnce(new Error("Storage unavailable"));
      await expect(processProfilePublication(OWNER.uid, ctx)).rejects.toThrow("Storage unavailable");
      expect(ctx.profiles.published({ alias: DRAFT.alias })).toEqual(previous);
      expect(handleProfileGet(ctx).profile.publicationFailed).toBe(true);
      await handleProfilePublish({ expectedRevision: 2 }, ctx);
      expect(ctx.profiles.publication(OWNER.uid)).toEqual(pending);
      write.mockRestore();
      await processProfilePublication(OWNER.uid, ctx);
      expect(ctx.profiles.published({ alias: DRAFT.alias })).toBeNull();
      expect(ctx.profiles.published({ alias: "new-alias" })?.revision).toBe(2);
      expect(await ctx.env.STORAGE.get(previous.key)).toBeNull();
      await handleProfilePublish({ expectedRevision: 2 }, ctx);
      expect(ctx.profiles.publication(OWNER.uid)).toBeNull();
    });
  });

  it("requires a current direct human decision and never reassigns an old alias", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const ctx = profileContext(storage);
      const agent = { ...ctx, processId: "proc:ship" };
      await expect(handleProfileUpdate({ expectedRevision: 0, draft: DRAFT }, agent)).rejects.toThrow("signed-in human");
      const root = { ...ctx, callerOwnerUid: 0, peer: testPeer({ kind: "human", account: { ...OWNER, uid: 0 }, calls: ["*"] }) };
      await expect(handleProfileUpdate({ expectedRevision: 0, draft: DRAFT }, root)).rejects.toThrow("signed-in human");
      await handleProfileUpdate({ expectedRevision: 0, draft: DRAFT }, ctx);
      await expect(handleProfileUpdate({ expectedRevision: 0, draft: { ...DRAFT, alias: "raced" } }, ctx)).rejects.toThrow("changed");
      await expect(handleProfilePublish({ expectedRevision: 0 }, ctx)).rejects.toThrow("changed");
      await handleProfilePublish({ expectedRevision: 1 }, ctx);
      await processProfilePublication(OWNER.uid, ctx);
      await handleProfileUnpublish({ expectedRevision: 1 }, ctx);
      expect(() => ctx.profiles.update(1001, "subject:other", 0, DRAFT)).toThrow("unavailable");
      expect(ctx.profiles.get(1001, "https://local.example")).toBeNull();
    });
  });

  it("recovers pending publication from SQL and refuses to publish for a locked owner", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const ctx = profileContext(storage);
      await handleProfileUpdate({ expectedRevision: 0, draft: DRAFT }, ctx);
      await handleProfilePublish({ expectedRevision: 1 }, ctx);
      const restored = new ProfileStore(storage);
      expect(restored.pendingOwners()).toEqual([OWNER.uid]);
      const shadow = vi.spyOn(ctx.auth, "getShadowByUsername").mockReturnValue(null);
      await processProfilePublication(OWNER.uid, { ...ctx, profiles: restored });
      shadow.mockRestore();
      expect(restored.published({ alias: DRAFT.alias })).toBeNull();
      expect(restored.pendingOwners()).toEqual([]);
    });
  });
});

function profileContext(storage: DurableObjectStorage): KernelContext {
  const context = {
    installationIdentity: { installationId: `inst_${crypto.randomUUID()}`, canonicalOrigin: "https://local.example", handle: "local" },
    peer: testPeer({ kind: "human", account: OWNER, calls: ["profile.*"] }), callerOwnerUid: OWNER.uid, connection: {},
    profiles: new ProfileStore(storage), federation: new FederationStore(storage), federationIdentity: new FederationIdentity(storage),
    env: { STORAGE: createInstallationStorage(env.STORAGE, `inst_${crypto.randomUUID()}`) },
    auth: { getPasswdByUid: () => OWNER, getShadowByUsername: () => ({ hash: "unlocked" }), isPersonalAgentUid: () => false },
    broadcastToUserUid: vi.fn(), scheduleProfilePublication: vi.fn(async () => {}),
    coordinateFederationContact: async <T>(_key: string, work: () => T | Promise<T>) => work(),
  };
  // SAFETY: profile handlers use the real stores and the explicit account, storage and notification callbacks above.
  return context as KernelContext;
}
