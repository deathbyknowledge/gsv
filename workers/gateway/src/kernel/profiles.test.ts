import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicCommit, PublicRepository } from "@humansandmachines/gsv/services/pds";
import type { BinaryBody, ProfileFields, ShipProfileRecord } from "@humansandmachines/gsv/protocol";
import { bodyFromBytes } from "@humansandmachines/gsv/protocol";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import { testPeer } from "../test-support/peers";
import { TEST_PDS_URL, TEST_PLC_URL, TestShipNetwork, type TestDidAccount } from "../test-support/ship-network";
import type { KernelContext } from "./context";
import type { Kernel } from "./do";
import { ConfigStore } from "./config";
import { ProfileStore } from "./profile-store";
import {
  ensureDefaultProfile, handleProfileAvatarRead, handleProfileAvatarRemove, handleProfileAvatarSet, handleProfileGet,
  handleProfilePublish, handleProfileResolve, handleProfileUnpublish, handleProfileUpdate, ownerDisplayName,
  publicProfileAvatar, publicProfileProjection, readPublicProfile,
} from "./profiles";
import { KERNEL_V059_PUBLIC_PROFILES } from "./schema/v059_public_profiles";
import { KERNEL_V074_PROFILE_RECORDS } from "./schema/v074_profile_records";
import { DidDocumentStore } from "./ships/did-directory";
import { ShipIdentity } from "./ships/identity";

const OWNER = { uid: 1000, gid: 1000, gids: [1000], username: "private-login", gecos: "Person", home: "/home/private-login", cwd: "/home/private-login" };
const DRAFT: ProfileFields = { displayName: "Published name", about: "Hello from my space", contactPolicy: "requests" };
const SHIP = { did: "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa", handle: "local.ship.test", host: TEST_PDS_URL };
const PROFILE_URL = "https://local.ship.test/profile";
const NO_PUBLIC_PROFILE = "A private invitation does not require a public profile";
// Each picture's CID as the repository names it (CIDv1, raw, SHA-256), computed with @atcute/cid.
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const PNG_CID = "bafkreibbrlmfuiz676bjmgfgqznlnajcfnzuyywtlizlh2v5lq35rfc7qy";
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
const WEBP_CID = "bafkreib746lfdkjouocqyp6d3wkrtjt4p5yllgh2eofd7wjail3ei3teki";

afterEach(() => vi.restoreAllMocks());

describe("publishing the profile record", () => {
  it("writes the saved draft as the Ship's space.ship.profile record and keeps its CID", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { ctx, repository } = profileContext(storage);
      expect(handleProfileGet(ctx).profile).toEqual({ revision: 0, url: PROFILE_URL, handle: "local", draft: { displayName: "local", about: "", contactPolicy: "requests" } });
      handleProfileUpdate({ expectedRevision: 0, draft: DRAFT }, ctx);
      expect(ctx.profiles.published(OWNER.uid)).toBeNull();
      const result = await handleProfilePublish({ expectedRevision: 1 }, ctx);
      const record: ShipProfileRecord = { $type: "space.ship.profile", displayName: DRAFT.displayName, about: DRAFT.about, contactPolicy: "requests" };
      expect(repository.applyWrites).toHaveBeenCalledExactlyOnceWith([{ action: "put", collection: "space.ship.profile", rkey: "self", record }]);
      expect(repository.uploadBlob).not.toHaveBeenCalled();
      expect(result.profile).toMatchObject({ revision: 1, published: { url: PROFILE_URL, cid: "bafyrecord1", contactPolicy: "requests", revision: 1 } });
      expect(ctx.profiles.published(OWNER.uid)).toEqual({ cid: "bafyrecord1", record });
      expect(ctx.broadcastToUserUid).toHaveBeenCalledWith(OWNER.uid, "profile.changed");
      expect(ownerDisplayName(OWNER.uid, ctx)).toBe(DRAFT.displayName);
      // Later edits stay private until they are published.
      handleProfileUpdate({ expectedRevision: 1, draft: { ...DRAFT, about: "Private revision", contactPolicy: "invitation" } }, ctx);
      expect(handleProfileGet(ctx).profile).toMatchObject({
        revision: 2, draft: { about: "Private revision", contactPolicy: "invitation" }, published: { revision: 1, contactPolicy: "requests" },
      });
      expect(publicProfileProjection(ctx)).toEqual({ url: PROFILE_URL, handle: "local", cid: "bafyrecord1", record });
    });
  });

  it("reports the draft revision the record holds, so unpublished changes show and a failed publish can be retried", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { ctx, repository } = profileContext(storage);
      handleProfileUpdate({ expectedRevision: 0, draft: DRAFT }, ctx);
      await handleProfilePublish({ expectedRevision: 1 }, ctx);
      const saved = handleProfileUpdate({ expectedRevision: 1, draft: { ...DRAFT, about: "Unpublished change" } }, ctx);
      expect(saved.profile).toMatchObject({ revision: 2, published: { revision: 1, cid: "bafyrecord1" } });
      repository.applyWrites.mockRejectedValueOnce(new Error("The repository is unavailable"));
      await expect(handleProfilePublish({ expectedRevision: 2 }, ctx)).rejects.toThrow("unavailable");
      expect(handleProfileGet(ctx).profile).toMatchObject({ revision: 2, published: { revision: 1, cid: "bafyrecord1" } });
      expect(ctx.profiles.published(OWNER.uid)?.record.about).toBe(DRAFT.about);
      const retried = await handleProfilePublish({ expectedRevision: 2 }, ctx);
      expect(retried.profile).toMatchObject({ revision: 2, published: { revision: 2, cid: "bafyrecord2" } });
      expect(ctx.profiles.published(OWNER.uid)?.record.about).toBe("Unpublished change");
    });
  });

  it("creates the Ship's DID with its first publish", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { ctx, repository } = profileContext(storage);
      repository.account.mockResolvedValue(null);
      handleProfileUpdate({ expectedRevision: 0, draft: { ...DRAFT, about: "" } }, ctx);
      await handleProfilePublish({ expectedRevision: 1 }, ctx);
      expect(repository.ensureAccount).toHaveBeenCalledExactlyOnceWith("local.ship.test");
      expect(ctx.shipIdentity.current()).toBe(SHIP.did);
      // An empty about is left out of the record.
      expect(repository.applyWrites.mock.calls[0]![0]).toEqual([{
        action: "put", collection: "space.ship.profile", rkey: "self",
        record: { $type: "space.ship.profile", displayName: DRAFT.displayName, contactPolicy: "requests" },
      }]);
      expect(repository[Symbol.dispose]).toHaveBeenCalledOnce();
    });
  });

  it("deletes the record to unpublish, and a record already gone stays gone", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { ctx, repository } = profileContext(storage);
      handleProfileUpdate({ expectedRevision: 0, draft: DRAFT }, ctx);
      await handleProfilePublish({ expectedRevision: 1 }, ctx);
      const result = await handleProfileUnpublish({ expectedRevision: 1 }, ctx);
      expect(repository.applyWrites).toHaveBeenLastCalledWith([{ action: "delete", collection: "space.ship.profile", rkey: "self" }]);
      expect(result.profile).toMatchObject({ revision: 2, draft: DRAFT });
      expect(result.profile.published).toBeUndefined();
      expect(ctx.profiles.published(OWNER.uid)).toBeNull();
      expect(publicProfileProjection(ctx)).toBeNull();

      await handleProfilePublish({ expectedRevision: 2 }, ctx);
      repository.applyWrites.mockRejectedValueOnce(new Error("InvalidRequest: Could not find a record with key: space.ship.profile/self"));
      await handleProfileUnpublish({ expectedRevision: 2 }, ctx);
      expect(ctx.profiles.published(OWNER.uid)).toBeNull();

      await handleProfilePublish({ expectedRevision: 3 }, ctx);
      repository.applyWrites.mockRejectedValueOnce(new Error("The repository is unavailable"));
      await expect(handleProfileUnpublish({ expectedRevision: 3 }, ctx)).rejects.toThrow("unavailable");
      expect(ctx.profiles.published(OWNER.uid)).not.toBeNull();
      // Unpublishing a private profile has nothing to delete.
      const calls = repository.applyWrites.mock.calls.length;
      handleProfileUpdate({ expectedRevision: 3, draft: DRAFT }, ctx);
      await handleProfileUnpublish({ expectedRevision: 4 }, ctx);
      await handleProfileUnpublish({ expectedRevision: 5 }, ctx);
      expect(repository.applyWrites).toHaveBeenCalledTimes(calls + 1);
    });
  });

  it("publishes exactly the saved revision, one publication at a time", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { ctx, repository } = profileContext(storage);
      handleProfileUpdate({ expectedRevision: 0, draft: DRAFT }, ctx);
      await expect(handleProfilePublish({ expectedRevision: 0 }, ctx)).rejects.toThrow("changed");
      await expect(handleProfileUnpublish({ expectedRevision: 0 }, ctx)).rejects.toThrow("changed");
      expect(repository.applyWrites).not.toHaveBeenCalled();

      const held = holdNextCommit(repository);
      const publishing = handleProfilePublish({ expectedRevision: 1 }, ctx);
      await vi.waitFor(() => expect(repository.applyWrites).toHaveBeenCalledOnce());
      handleProfileUpdate({ expectedRevision: 1, draft: { ...DRAFT, about: "Next revision" } }, ctx);
      held.release();
      // The repository holds revision 1, so that is what the profile records as published.
      expect((await publishing).profile).toMatchObject({ revision: 2, draft: { about: "Next revision" }, published: { revision: 1 } });
      expect(ctx.profiles.published(OWNER.uid)?.record.about).toBe(DRAFT.about);

      const next = holdNextCommit(repository);
      const republishing = handleProfilePublish({ expectedRevision: 2 }, ctx);
      await vi.waitFor(() => expect(repository.applyWrites).toHaveBeenCalledTimes(2));
      const unpublishing = handleProfileUnpublish({ expectedRevision: 2 }, ctx);
      next.release();
      await republishing;
      await unpublishing;
      expect(repository.applyWrites.mock.calls.map(([writes]) => writes[0]!.action)).toEqual(["put", "put", "delete"]);
      expect(ctx.profiles.published(OWNER.uid)).toBeNull();
      expect(handleProfileGet(ctx).profile).toMatchObject({ revision: 3, draft: { about: "Next revision" } });
    });
  });

  it("requires a current direct human decision and allows only one profile", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { ctx, repository } = profileContext(storage);
      const agent = { ...ctx, processId: "proc:ship" };
      expect(() => handleProfileUpdate({ expectedRevision: 0, draft: DRAFT }, agent)).toThrow("signed-in human");
      await expect(handleProfilePublish({ expectedRevision: 0 }, agent)).rejects.toThrow("signed-in human");
      const cancel = vi.fn();
      await expect(handleProfileAvatarSet({ expectedRevision: 0, mimeType: "image/png" }, agent, { stream: new ReadableStream({ cancel }), length: 12 }))
        .rejects.toThrow("signed-in human");
      expect(cancel).toHaveBeenCalledOnce();
      const root = { ...ctx, callerOwnerUid: 0, peer: testPeer({ kind: "human", account: { ...OWNER, uid: 0 }, calls: ["*"] }) };
      expect(() => handleProfileUpdate({ expectedRevision: 0, draft: DRAFT }, root)).toThrow("signed-in human");
      expect(() => handleProfileUpdate({ expectedRevision: 0, draft: { ...DRAFT, displayName: " " } }, ctx)).toThrow("display name");
      handleProfileUpdate({ expectedRevision: 0, draft: DRAFT }, ctx);
      expect(() => handleProfileUpdate({ expectedRevision: 0, draft: { ...DRAFT, about: "raced" } }, ctx)).toThrow("changed");
      expect(() => ctx.profiles.update(1001, 0, DRAFT)).toThrow("one public profile");
      expect(ctx.profiles.draft(1001)).toBeNull();
      // A locked owner can neither publish nor keep a public page.
      await handleProfilePublish({ expectedRevision: 1 }, ctx);
      const shadow = vi.spyOn(ctx.auth, "getShadowByUsername").mockReturnValue(null);
      await expect(handleProfilePublish({ expectedRevision: 1 }, ctx)).rejects.toThrow("signed-in human");
      expect(publicProfileProjection(ctx)).toBeNull();
      shadow.mockRestore();
      expect(repository.applyWrites).toHaveBeenCalledOnce();
    });
  });
});

describe("the profile picture", () => {
  it("keeps a picture with the draft and publishes it with the record", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { ctx, repository, uploads } = profileContext(storage);
      const set = await handleProfileAvatarSet({ expectedRevision: 0, mimeType: "image/png" }, ctx, bodyFromBytes(PNG));
      expect(set.profile).toMatchObject({ revision: 1, draft: { displayName: "local" }, avatar: { cid: PNG_CID, mimeType: "image/png", size: PNG.byteLength } });
      const read = handleProfileAvatarRead({ cid: PNG_CID }, ctx);
      expect(read.data).toEqual({ cid: PNG_CID, mimeType: "image/png", size: PNG.byteLength });
      expect(await bytesOf(read.body)).toEqual(PNG);
      expect(repository.uploadBlob).not.toHaveBeenCalled();
      expect(publicProfileAvatar(ctx)).toBeNull();

      await handleProfilePublish({ expectedRevision: 1 }, ctx);
      expect(repository.uploadBlob).toHaveBeenCalledExactlyOnceWith(expect.any(ReadableStream), PNG.byteLength, "image/png");
      expect(uploads).toEqual([PNG]);
      const png = { $type: "blob", ref: { $link: PNG_CID }, mimeType: "image/png", size: PNG.byteLength };
      expect(ctx.profiles.published(OWNER.uid)?.record.avatar).toEqual(png);
      expect(publicProfileProjection(ctx)?.avatar).toEqual({ cid: PNG_CID, mimeType: "image/png", size: PNG.byteLength });
      expect(publicProfileAvatar(ctx)?.bytes).toEqual(PNG);

      // A new picture stays private until it is published; the public page keeps the old one.
      await handleProfileAvatarSet({ expectedRevision: 1, mimeType: "image/webp" }, ctx, bodyFromBytes(WEBP));
      expect(publicProfileAvatar(ctx)?.cid).toBe(PNG_CID);
      expect(handleProfileAvatarRead({ cid: PNG_CID }, ctx).data.cid).toBe(PNG_CID);
      await handleProfilePublish({ expectedRevision: 2 }, ctx);
      expect(ctx.profiles.published(OWNER.uid)?.record.avatar?.ref.$link).toBe(WEBP_CID);
      expect(ctx.profiles.avatar(PNG_CID)).toBeNull();
      expect(() => handleProfileAvatarRead({ cid: PNG_CID }, ctx)).toThrow("isn't on your profile");

      const removed = handleProfileAvatarRemove({ expectedRevision: 2 }, ctx);
      expect(removed.profile.avatar).toBeUndefined();
      expect(publicProfileAvatar(ctx)?.cid).toBe(WEBP_CID);
      await handleProfilePublish({ expectedRevision: 3 }, ctx);
      expect(ctx.profiles.published(OWNER.uid)?.record).not.toHaveProperty("avatar");
      expect(ctx.profiles.avatar(WEBP_CID)).toBeNull();
      expect(publicProfileAvatar(ctx)).toBeNull();
    });
  });

  it("publishes nothing when the repository names the picture differently", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { ctx, repository } = profileContext(storage);
      await handleProfileAvatarSet({ expectedRevision: 0, mimeType: "image/png" }, ctx, bodyFromBytes(PNG));
      repository.uploadBlob.mockImplementationOnce(async (body, size, mimeType) => {
        await body.cancel();
        return { $type: "blob", ref: { $link: WEBP_CID }, mimeType, size };
      });
      await expect(handleProfilePublish({ expectedRevision: 1 }, ctx)).rejects.toThrow("named the profile picture differently");
      expect(repository.applyWrites).not.toHaveBeenCalled();
      expect(ctx.profiles.published(OWNER.uid)).toBeNull();
    });
  });

  it.each<[string, () => BinaryBody | undefined, "image/png" | "image/jpeg", string]>([
    ["no body", () => undefined, "image/png", "requires the picture"],
    ["a body of unknown length", () => ({ stream: bodyFromBytes(PNG).stream }), "image/png", "of declared length"],
    ["a picture over 1 MB", () => ({ stream: bodyFromBytes(PNG).stream, length: 1_000_001 }), "image/png", "limited to 1 MB"],
    ["bytes of another type", () => bodyFromBytes(PNG), "image/jpeg", "must be a PNG, JPEG or WebP image"],
    ["something that isn't an image", () => bodyFromBytes(new TextEncoder().encode("<svg onload=alert(1)>")), "image/png", "must be a PNG, JPEG or WebP image"],
  ])("refuses %s and keeps nothing", async (_label, body, mimeType, message) => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { ctx } = profileContext(storage);
      await expect(handleProfileAvatarSet({ expectedRevision: 0, mimeType }, ctx, body())).rejects.toThrow(message);
      expect(ctx.profiles.draft(OWNER.uid)).toBeNull();
    });
  });

  it("accepts only PNG, JPEG and WebP", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { ctx } = profileContext(storage);
      // SAFETY: the handler validates arguments that arrive outside the typed client.
      await expect(handleProfileAvatarSet({ expectedRevision: 0, mimeType: "image/svg+xml" } as never, ctx, bodyFromBytes(PNG))).rejects.toThrow();
      expect(ctx.profiles.draft(OWNER.uid)).toBeNull();
    });
  });
});

describe("the default profile", () => {
  it("publishes a public, request-open profile named by the Ship handle once, so an unpublish stays private", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { ctx, repository } = profileContext(storage);
      await ensureDefaultProfile(OWNER.uid, ctx);
      expect(ctx.profiles.published(OWNER.uid)?.record).toEqual({ $type: "space.ship.profile", displayName: "local", contactPolicy: "requests" });
      expect(handleProfileGet(ctx).profile).toMatchObject({ revision: 1, published: { revision: 1 } });
      expect(ctx.broadcastToUserUid).toHaveBeenCalledWith(OWNER.uid, "profile.changed");
      await ensureDefaultProfile(OWNER.uid, ctx);
      expect(repository.applyWrites).toHaveBeenCalledOnce();
      await handleProfileUnpublish({ expectedRevision: 1 }, ctx);
      await ensureDefaultProfile(OWNER.uid, ctx);
      expect(ctx.profiles.published(OWNER.uid)).toBeNull();
      expect(handleProfileGet(ctx).profile).toMatchObject({ revision: 2 });
    });
  });

  it("leaves no timer running once sign-in has published, or had nothing to publish", async () => {
    const kernel = env.KERNEL.get(env.KERNEL.idFromName(crypto.randomUUID()));
    await runInDurableObject(kernel, async (_instance: Kernel, state) => {
      const { ctx, repository } = profileContext(state.storage);
      await ensureDefaultProfile(OWNER.uid, ctx);
      await ensureDefaultProfile(OWNER.uid, ctx);
      expect(repository.applyWrites).toHaveBeenCalledOnce();
    });
    // A Kernel with a timer pending isn't idle, so one left behind would hold it awake after every sign-in.
    const stopping = evictDurableObject(kernel).then(() => "stopped");
    expect(await Promise.race([stopping, new Promise((resolve) => setTimeout(resolve, 2_000, "held"))])).toBe("stopped");
  });

  it("retries its own default after a failed publish, but never an owner's draft", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { ctx, repository } = profileContext(storage);
      repository.applyWrites.mockRejectedValueOnce(new Error("The repository is unavailable"));
      await expect(ensureDefaultProfile(OWNER.uid, ctx)).rejects.toThrow("unavailable");
      expect(ctx.profiles.published(OWNER.uid)).toBeNull();
      await ensureDefaultProfile(OWNER.uid, ctx);
      expect(ctx.profiles.published(OWNER.uid)?.record).toMatchObject({ displayName: "local", contactPolicy: "requests" });
    });
    await runWithRealKernelSql(async (_sql, storage) => {
      const { ctx, repository } = profileContext(storage);
      repository.applyWrites.mockRejectedValueOnce(new Error("The repository is unavailable"));
      await expect(ensureDefaultProfile(OWNER.uid, ctx)).rejects.toThrow("unavailable");
      handleProfileUpdate({ expectedRevision: 1, draft: { ...DRAFT, contactPolicy: "invitation" } }, ctx);
      await ensureDefaultProfile(OWNER.uid, ctx);
      expect(ctx.profiles.published(OWNER.uid)).toBeNull();
      expect(repository.applyWrites).toHaveBeenCalledOnce();
    });
  });

  it("leaves a draft or a choice the owner made alone", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { ctx } = profileContext(storage);
      handleProfileUpdate({ expectedRevision: 0, draft: { ...DRAFT, contactPolicy: "closed" } }, ctx);
      await ensureDefaultProfile(OWNER.uid, ctx);
      expect(ctx.profiles.published(OWNER.uid)).toBeNull();
    });
    await runWithRealKernelSql(async (_sql, storage) => {
      const { ctx, repository } = profileContext(storage);
      handleProfileUpdate({ expectedRevision: 0, draft: { ...DRAFT, contactPolicy: "invitation" } }, ctx);
      await handleProfilePublish({ expectedRevision: 1 }, ctx);
      await ensureDefaultProfile(OWNER.uid, ctx);
      expect(ctx.profiles.published(OWNER.uid)?.record.contactPolicy).toBe("invitation");
      expect(repository.applyWrites).toHaveBeenCalledOnce();
    });
  });

  it("waits for an open-network host before publishing anything", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { ctx } = profileContext(storage, { pds: false });
      await ensureDefaultProfile(OWNER.uid, ctx);
      expect(ctx.profiles.draft(OWNER.uid)).toBeNull();
      expect(ctx.config.getExplicit(`users/${OWNER.uid}/profile/default_published`)).toBeNull();
      handleProfileUpdate({ expectedRevision: 0, draft: DRAFT }, ctx);
      await expect(handleProfilePublish({ expectedRevision: 1 }, ctx)).rejects.toThrow("isn't available on this deployment");
      expect(ctx.profiles.published(OWNER.uid)).toBeNull();
    });
  });

  it("writes a profile signed before profiles were records to the repository at the next sign-in", async () => {
    await runWithRealKernelSql(async (sql, storage) => {
      // The profile tables as v073 left them: a published, signed profile and a draft edited since.
      sql.exec("DROP TABLE social_profile_avatars");
      sql.exec("DROP TABLE social_profiles");
      sql.exec(KERNEL_V059_PUBLIC_PROFILES.statements[0]!);
      const signed = {
        version: 3, domain: "gsv-federation/3/profile", actor: { shipId: "ship:local", subjectId: "subject:local" },
        publicKey: { kty: "EC", crv: "P-256", x: "x", y: "y" }, origin: "https://local.example", url: "https://local.example/profile",
        displayName: "Signed name", about: "Signed about", contactPolicy: "invitation", representation: "human-and-ship",
        revision: 2, publishedAtMs: 1, signature: "signature",
      };
      sql.exec("INSERT INTO social_profiles (owner_uid, subject_id, revision, draft_json, published_revision, published_json) VALUES (?, ?, ?, ?, ?, ?)",
        OWNER.uid, "subject:local", 3, JSON.stringify({ ...DRAFT, about: "Private draft", representation: "human" }), 2, JSON.stringify(signed));
      storage.transactionSync(() => { for (const statement of KERNEL_V074_PROFILE_RECORDS.statements) sql.exec(statement); });

      const { ctx, repository } = profileContext(storage);
      const record: ShipProfileRecord = { $type: "space.ship.profile", displayName: "Signed name", about: "Signed about", contactPolicy: "invitation" };
      expect(ctx.profiles.draft(OWNER.uid)).toEqual({ revision: 3, fields: { ...DRAFT, about: "Private draft" }, avatar: null });
      expect(ctx.profiles.pendingPublication(OWNER.uid)).toEqual({ revision: 2, record });
      // Until the repository holds it, the profile reads as private.
      expect(ctx.profiles.published(OWNER.uid)).toBeNull();
      expect(publicProfileProjection(ctx)).toBeNull();
      expect(handleProfileGet(ctx).profile.published).toBeUndefined();

      await ensureDefaultProfile(OWNER.uid, ctx);
      expect(repository.applyWrites).toHaveBeenCalledExactlyOnceWith([{ action: "put", collection: "space.ship.profile", rkey: "self", record }]);
      expect(ctx.profiles.published(OWNER.uid)).toEqual({ cid: "bafyrecord1", record });
      expect(handleProfileGet(ctx).profile).toMatchObject({ revision: 3, draft: { about: "Private draft" }, published: { revision: 2, contactPolicy: "invitation" } });
      expect(ctx.profiles.pendingPublication(OWNER.uid)).toBeNull();
      await ensureDefaultProfile(OWNER.uid, ctx);
      expect(repository.applyWrites).toHaveBeenCalledOnce();
    });
  });

  it("migrates a signed profile with an empty about and an unpublished draft", async () => {
    await runWithRealKernelSql(async (sql, storage) => {
      sql.exec("DROP TABLE social_profile_avatars");
      sql.exec("DROP TABLE social_profiles");
      sql.exec(KERNEL_V059_PUBLIC_PROFILES.statements[0]!);
      sql.exec("INSERT INTO social_profiles (owner_uid, subject_id, revision, draft_json, published_revision, published_json) VALUES (?, ?, ?, ?, ?, ?)",
        OWNER.uid, "subject:local", 1, JSON.stringify({ ...DRAFT, representation: "human" }), 1,
        JSON.stringify({ displayName: "Signed name", about: "", contactPolicy: "requests", representation: "human" }));
      sql.exec("INSERT INTO social_profiles (owner_uid, subject_id, revision, draft_json) VALUES (?, ?, ?, ?)",
        1001, "subject:other", 2, JSON.stringify({ ...DRAFT, representation: "ship" }));
      storage.transactionSync(() => { for (const statement of KERNEL_V074_PROFILE_RECORDS.statements) sql.exec(statement); });
      const profiles = new ProfileStore(storage);
      expect(profiles.pendingPublication(OWNER.uid)?.record).toEqual({ $type: "space.ship.profile", displayName: "Signed name", contactPolicy: "requests" });
      expect(profiles.draft(1001)).toEqual({ revision: 2, fields: DRAFT, avatar: null });
      expect(profiles.pendingPublication(1001)).toBeNull();
    });
  });
});

describe("reading another Ship's profile", () => {
  let network: TestShipNetwork;
  let alice: TestDidAccount;
  let record: ShipProfileRecord & { pronouns?: string };
  let lookups: URL[];

  beforeEach(async () => {
    network = new TestShipNetwork().install();
    alice = await network.account("alice.ship.test");
    record = {
      $type: "space.ship.profile", displayName: "Alice", about: "Hello", contactPolicy: "requests",
      avatar: { $type: "blob", ref: { $link: PNG_CID }, mimeType: "image/png", size: 12 }, pronouns: "a field a later version adds",
    };
    lookups = [];
    network.hosts.set("alice.ship.test", (request) => new URL(request.url).pathname === "/.well-known/atproto-did"
      ? new Response(`${alice.did}\n`)
      : new Response("Not Found", { status: 404 }));
    network.hosts.set(new URL(TEST_PDS_URL).host, (request) => {
      const url = new URL(request.url);
      lookups.push(url);
      const repo = url.searchParams.get("repo");
      if (url.pathname !== "/xrpc/com.atproto.repo.getRecord" || repo !== alice.did) return Response.json({ error: "RepoNotFound" }, { status: 400 });
      return Response.json({ uri: `at://${repo}/${url.searchParams.get("collection")}/${url.searchParams.get("rkey")}`, cid: "bafyreialice", value: record });
    });
  });

  const ALICE = { handle: "alice.ship.test", cid: "bafyreialice", displayName: "Alice", about: "Hello", contactPolicy: "requests", url: "https://alice.ship.test/profile" };

  it.each([
    "alice.ship.test", "@alice.ship.test", "@Alice.Ship.Test", "alice", "@alice",
    "https://alice.ship.test/profile", "https://alice.ship.test", "alice.ship.test/profile",
    "https://alice.ship.test/@alice", "https://alice.gsv.test/profile",
  ])("reads the record %s names, with its handle checked both ways", async (address) => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { ctx } = profileContext(storage);
      expect(await handleProfileResolve({ address }, ctx)).toEqual({ profile: { did: alice.did, ...ALICE } });
      expect(lookups).toHaveLength(1);
      expect(Object.fromEntries(lookups[0]!.searchParams)).toEqual({ repo: alice.did, collection: "space.ship.profile", rkey: "self" });
    });
  });

  it("reads a profile by DID, refusing an account that claims another Ship's handle", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { ctx } = profileContext(storage);
      expect(await readPublicProfile(alice.did, ctx)).toEqual({ did: alice.did, ...ALICE });
      const mallory = await network.account("alice.ship.test");
      await expect(readPublicProfile(mallory.did, ctx)).rejects.toThrow("@alice.ship.test names another account");
      network.hosts.set("mallory.ship.test", () => new Response(`${alice.did}\n`));
      await expect(handleProfileResolve({ address: "mallory.ship.test" }, ctx))
        .rejects.toMatchObject({ name: "FederationHttpError", status: 404, message: expect.stringContaining(NO_PUBLIC_PROFILE) });
    });
  });

  it("reads a contact policy it doesn't know as closed", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { ctx } = profileContext(storage);
      record = { ...record, contactPolicy: "everyone" };
      expect((await handleProfileResolve({ address: "@alice" }, ctx)).profile.contactPolicy).toBe("closed");
      const { about: _about, ...unwritten } = record;
      record = { ...unwritten, contactPolicy: "invitation" };
      expect((await handleProfileResolve({ address: "@alice" }, ctx)).profile).toMatchObject({ about: "", contactPolicy: "invitation" });
    });
  });

  it("answers a missing record, an unknown handle and a private profile alike", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { ctx } = profileContext(storage);
      const unavailable = { name: "FederationHttpError", status: 404, message: expect.stringContaining(NO_PUBLIC_PROFILE) };
      network.hosts.set(new URL(TEST_PDS_URL).host, () => Response.json({ error: "RecordNotFound", message: "Could not locate record" }, { status: 400 }));
      await expect(handleProfileResolve({ address: "@alice" }, ctx)).rejects.toMatchObject(unavailable);
      network.hosts.set("nobody.ship.test", () => new Response("Not Found", { status: 404 }));
      await expect(handleProfileResolve({ address: "@nobody" }, ctx)).rejects.toMatchObject(unavailable);
      const repositoryless = await network.account("ghost.ship.test", { ship: { type: "ShipService", endpoint: "https://ghost.ship.test" } });
      network.hosts.set("ghost.ship.test", () => new Response(`${repositoryless.did}\n`));
      await expect(handleProfileResolve({ address: "@ghost" }, ctx)).rejects.toMatchObject(unavailable);
    });
  });

  it("refuses a record that isn't the profile it asked for", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { ctx } = profileContext(storage);
      network.hosts.set(new URL(TEST_PDS_URL).host, () => Response.json({ uri: "at://did:plc:bbbbbbbbbbbbbbbbbbbbbbbb/space.ship.profile/self", cid: "bafyreiother", value: record }));
      await expect(handleProfileResolve({ address: "@alice" }, ctx)).rejects.toThrow("isn't one a Ship can read");
      network.hosts.set(new URL(TEST_PDS_URL).host, () => Response.json({ uri: `at://${alice.did}/space.ship.profile/self`, cid: "bafyreialice", value: { ...record, displayName: "" } }));
      await expect(handleProfileResolve({ address: "@alice" }, ctx)).rejects.toThrow("isn't one a Ship can read");
      network.hosts.set(new URL(TEST_PDS_URL).host, () => new Response("x".repeat(200 * 1024), { headers: { "content-type": "application/json" } }));
      await expect(handleProfileResolve({ address: "@alice" }, ctx)).rejects.toThrow();
    });
  });

  it.each([
    "http://alice.ship.test/profile", "https://alice.ship.test:8443/profile", "https://alice.ship.test/inbox",
    "https://user:pass@alice.ship.test/profile", "https://alice.ship.test/profile?tab=1", "https://alice.ship.test/profile#top",
    "ftp://alice.ship.test", "alice smith", "@", "https://127.0.0.1/profile",
  ])("refuses %s without a lookup", async (address) => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { ctx } = profileContext(storage);
      await expect(handleProfileResolve({ address }, ctx)).rejects.toThrow();
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });
  });

  it("asks for the full handle when this Ship has no domain for handles", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { ctx } = profileContext(storage);
      await expect(handleProfileResolve({ address: "@alice" }, { ...ctx, installationIdentity: null })).rejects.toThrow("enter the full handle");
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });
  });

  it("lets the person and their Ship look up profiles, but no one else", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { ctx } = profileContext(storage);
      const machine = { ...ctx, peer: testPeer({ kind: "machine", account: OWNER, calls: ["profile.*"] }) };
      await expect(handleProfileResolve({ address: "@alice" }, machine)).rejects.toThrow("require a user");
      expect(globalThis.fetch).not.toHaveBeenCalled();
      const ship = { ...ctx, processId: "proc:ship", connection: undefined };
      expect((await handleProfileResolve({ address: "@alice" }, ship)).profile.did).toBe(alice.did);
    });
  });
});

function profileContext(storage: DurableObjectStorage, { pds = true }: { pds?: boolean } = {}) {
  let stored = 0;
  const uploads: Uint8Array[] = [];
  const repository = {
    account: vi.fn<PublicRepository["account"]>(async () => SHIP),
    ensureAccount: vi.fn<PublicRepository["ensureAccount"]>(async () => SHIP),
    serviceAuth: vi.fn<PublicRepository["serviceAuth"]>(),
    applyWrites: vi.fn<PublicRepository["applyWrites"]>(async (writes) => ({
      commit: { cid: "bafycommit", rev: "3l2" },
      results: writes.map((write) => ({ uri: `at://${SHIP.did}/${write.collection}/${write.rkey}`, cid: write.action === "delete" ? null : `bafyrecord${++stored}` })),
    })),
    uploadBlob: vi.fn<PublicRepository["uploadBlob"]>(async (body, size, mimeType) => {
      const bytes = new Uint8Array(await new Response(body).arrayBuffer());
      uploads.push(bytes);
      const cid = [[PNG, PNG_CID], [WEBP, WEBP_CID]].find(([known]) => equalBytes(bytes, known))?.[1] ?? "bafkreiunknown";
      return { $type: "blob", ref: { $link: cid }, mimeType, size };
    }),
    readBlob: vi.fn<PublicRepository["readBlob"]>(),
    [Symbol.dispose]: vi.fn(),
  };
  const context = {
    installationId: "inst_local",
    installationIdentity: { installationId: "inst_local", canonicalOrigin: "https://local.example", handle: "local" },
    env: {
      GSV_PUBLIC_CONFIG: JSON.stringify({ primaryDomain: "ship.test", legacyDomains: ["gsv.test"] }),
      PLC_URL: TEST_PLC_URL, PDS: pds ? { getInstallation: vi.fn(async () => repository) } : undefined,
    },
    peer: testPeer({ kind: "human", account: OWNER, calls: ["profile.*"] }), callerOwnerUid: OWNER.uid, connection: {},
    procs: { get: () => ({ isPersonalController: true, ownerUid: OWNER.uid }), getOwnerUid: () => OWNER.uid },
    profiles: new ProfileStore(storage), config: new ConfigStore(storage.sql),
    shipIdentity: new ShipIdentity(storage), didDocuments: new DidDocumentStore(storage.sql),
    auth: { getPasswdByUid: (uid: number) => uid === OWNER.uid ? OWNER : null, getShadowByUsername: () => ({ hash: "unlocked" }), isPersonalAgentUid: () => false },
    broadcastToUserUid: vi.fn(), defer: vi.fn(),
  };
  // SAFETY: profile handlers use the real stores and the explicit account, repository, directory and notification fakes above.
  return { ctx: context as KernelContext, repository, uploads };
}

/** Holds the repository's next commit until the test releases it. */
function holdNextCommit(repository: { applyWrites: ReturnType<typeof vi.fn<PublicRepository["applyWrites"]>> }) {
  const commit = repository.applyWrites.getMockImplementation()!;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  repository.applyWrites.mockImplementationOnce(async (writes): Promise<PublicCommit> => {
    await held;
    return await commit(writes);
  });
  return { release };
}

async function bytesOf(body: BinaryBody): Promise<Uint8Array> {
  return new Uint8Array(await new Response(body.stream).arrayBuffer());
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}
