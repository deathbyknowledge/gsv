import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicCommit, PublicRepository, PublicTakedown } from "@humansandmachines/gsv/services/pds";
import type { BinaryBody, ProfileFields, PublicBlobRef, ShipProfileRecord } from "@humansandmachines/gsv/protocol";
import { bodyFromBytes } from "@humansandmachines/gsv/protocol";
import { makeShadowEntry } from "../auth/shadow";
import { getKernelByInstallationId } from "../installation/routing";
import * as utils from "../shared/utils";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import { testPeer } from "../test-support/peers";
import { commitAccount } from "./accounts";
import { handleAdapterInbound } from "./adapter-ingress";
import { TEST_PDS_URL, TEST_PLC_URL, TestShipNetwork, type TestDidAccount } from "../test-support/ship-network";
import type { BlueskyProfileRecord } from "./bluesky-profile";
import type { KernelContext } from "./context";
import type { Kernel } from "./do";
import { ConfigStore } from "./config";
import { ProfileStore } from "./profile-store";
import {
  ensurePublishedProfile, followHostTakedowns, handleProfileAvatarRead, handleProfileAvatarRemove, handleProfileAvatarSet, handleProfileGet,
  handleProfileResolve, handleProfileUpdate, ownerDisplayName, publicProfileAvatar, publicProfileProjection, readPublicProfile,
} from "./profiles";
import { KERNEL_V059_PUBLIC_PROFILES } from "./schema/v059_public_profiles";
import { KERNEL_V075_PROFILE_RECORDS } from "./schema/v075_profile_records";
import { KERNEL_V080_PROFILE_MIRRORS } from "./schema/v080_profile_mirrors";
import { KERNEL_V099_PUBLIC_PROFILE_RECORDS } from "./schema/v099_public_profile_records";
import { DidDocumentStore } from "./ships/did-directory";
import { ShipIdentity } from "./ships/identity";

const OWNER = { uid: 1000, gid: 1000, gids: [1000], username: "private-login", gecos: "Person", home: "/home/private-login", cwd: "/home/private-login" };
const DRAFT: ProfileFields = { displayName: "Published name", about: "Hello from my space", contactPolicy: "requests" };
/** The profile a Ship publishes until its owner changes it: named by its handle. */
const STARTING: ProfileFields = { displayName: "local", about: "", contactPolicy: "requests" };
const SHIP = { did: "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa", handle: "local.ship.test", host: TEST_PDS_URL };
const PROFILE_URL = "https://local.ship.test";
const PUBLIC_CONFIG = JSON.stringify({ primaryDomain: "ship.test", legacyDomains: ["gsv.test"] });
const ROOT = { uid: 0, gid: 0, gids: [0], username: "root", home: "/root", cwd: "/root" };
/** The WhatsApp identity the person has linked to their account. */
const MESSENGER = { adapter: "whatsapp", accountId: "primary", actorId: "wa:+123" };
const NO_PUBLIC_PROFILE = "No public profile is available at this address";
// Each picture's CID as the repository names it (CIDv1, raw, SHA-256), computed with @atcute/cid.
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const PNG_CID = "bafkreibbrlmfuiz676bjmgfgqznlnajcfnzuyywtlizlh2v5lq35rfc7qy";
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
const WEBP_CID = "bafkreib746lfdkjouocqyp6d3wkrtjt4p5yllgh2eofd7wjail3ei3teki";
const BLUESKY = "app.bsky.actor.profile";

/** The write that keeps a profile as Bluesky shows it, beside the Ship's own record. */
function blueskyPut(record: Omit<BlueskyProfileRecord, "$type" | "website">) {
  return { action: "put", collection: BLUESKY, rkey: "self", record: { $type: BLUESKY, website: PROFILE_URL, ...record } };
}

/** The migrations that brought a v074 profile table to records. */
const PROFILE_MIGRATIONS_SINCE_V074 = [
  ...KERNEL_V075_PROFILE_RECORDS.statements, ...KERNEL_V080_PROFILE_MIRRORS.statements, ...KERNEL_V099_PUBLIC_PROFILE_RECORDS.statements,
];

afterEach(() => vi.restoreAllMocks());

describe("the public profile", () => {
  it("shows the starting profile until the first change, and publishes every change as the Ship's space.ship.profile record", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { ctx, repository } = profileContext(storage);
      expect(handleProfileGet(ctx).profile).toEqual({ revision: 0, url: PROFILE_URL, handle: "local", fields: STARTING });
      const result = await handleProfileUpdate({ expectedRevision: 0, fields: DRAFT }, ctx);
      const record: ShipProfileRecord = { $type: "space.ship.profile", displayName: DRAFT.displayName, about: DRAFT.about, contactPolicy: "requests" };
      expect(repository.applyWrites).toHaveBeenCalledExactlyOnceWith([
        { action: "put", collection: "space.ship.profile", rkey: "self", record },
        blueskyPut({ displayName: DRAFT.displayName, description: DRAFT.about }),
      ]);
      expect(repository.uploadBlob).not.toHaveBeenCalled();
      expect(result.profile).toEqual({ revision: 1, url: PROFILE_URL, handle: "local", fields: DRAFT, cid: "bafyrecord1" });
      expect(ctx.profiles.published(OWNER.uid)).toEqual({ cid: "bafyrecord1", record });
      expect(ctx.broadcastToUserUid).toHaveBeenCalledWith(OWNER.uid, "profile.changed");
      expect(ownerDisplayName(OWNER.uid, ctx)).toBe(DRAFT.displayName);
      expect(await publicProfileProjection(ctx)).toEqual({ url: PROFILE_URL, handle: "local", cid: "bafyrecord1", record });

      const closed = await handleProfileUpdate({ expectedRevision: 1, fields: { ...DRAFT, about: "", contactPolicy: "closed" } }, ctx);
      // An empty about is left out of the record.
      const next: ShipProfileRecord = { $type: "space.ship.profile", displayName: DRAFT.displayName, contactPolicy: "closed" };
      expect(repository.applyWrites).toHaveBeenLastCalledWith([
        { action: "put", collection: "space.ship.profile", rkey: "self", record: next }, blueskyPut({ displayName: DRAFT.displayName }),
      ]);
      expect(closed.profile).toMatchObject({ revision: 2, fields: { about: "", contactPolicy: "closed" }, cid: "bafyrecord2" });
      expect(await publicProfileProjection(ctx)).toEqual({ url: PROFILE_URL, handle: "local", cid: "bafyrecord2", record: next });
    });
  });

  it("keeps the profile as it was when the repository refuses a change, so the change can be retried", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { ctx, repository } = profileContext(storage);
      repository.applyWrites.mockRejectedValueOnce(new Error("The repository is unavailable"));
      await expect(handleProfileUpdate({ expectedRevision: 0, fields: DRAFT }, ctx)).rejects.toThrow("unavailable");
      expect(handleProfileGet(ctx).profile).toEqual({ revision: 0, url: PROFILE_URL, handle: "local", fields: STARTING });
      expect(ctx.broadcastToUserUid).not.toHaveBeenCalled();
      await handleProfileUpdate({ expectedRevision: 0, fields: DRAFT }, ctx);

      repository.applyWrites.mockRejectedValueOnce(new Error("The repository is unavailable"));
      await expect(handleProfileUpdate({ expectedRevision: 1, fields: { ...DRAFT, about: "Later" } }, ctx)).rejects.toThrow("unavailable");
      expect(handleProfileGet(ctx).profile).toMatchObject({ revision: 1, fields: DRAFT, cid: "bafyrecord1" });
      expect(ctx.profiles.published(OWNER.uid)?.record.about).toBe(DRAFT.about);
      const retried = await handleProfileUpdate({ expectedRevision: 1, fields: { ...DRAFT, about: "Later" } }, ctx);
      expect(retried.profile).toMatchObject({ revision: 2, fields: { about: "Later" }, cid: "bafyrecord2" });
    });
  });

  it("creates the Ship's DID with its first publish", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { ctx, repository } = profileContext(storage);
      repository.account.mockResolvedValue(null);
      await handleProfileUpdate({ expectedRevision: 0, fields: DRAFT }, ctx);
      expect(repository.ensureAccount).toHaveBeenCalledExactlyOnceWith("local.ship.test");
      expect(ctx.shipIdentity.current()).toBe(SHIP.did);
      expect(repository[Symbol.dispose]).toHaveBeenCalledOnce();
    });
  });

  it("publishes one change at a time, each from the revision it was made at", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { ctx, repository } = profileContext(storage);
      const held = holdNextCommit(repository);
      const first = handleProfileUpdate({ expectedRevision: 0, fields: DRAFT }, ctx);
      await vi.waitFor(() => expect(repository.applyWrites).toHaveBeenCalledOnce());
      // Made at the same revision, the second change waits its turn and then finds the profile changed.
      const refused = expect(handleProfileUpdate({ expectedRevision: 0, fields: { ...DRAFT, about: "Raced" } }, ctx)).rejects.toThrow("changed");
      held.release();
      expect((await first).profile).toMatchObject({ revision: 1, fields: DRAFT });
      await refused;
      expect(repository.applyWrites).toHaveBeenCalledOnce();
      expect(ctx.profiles.published(OWNER.uid)?.record.about).toBe(DRAFT.about);
    });
  });

  it("requires a current direct human decision and allows only one profile", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { ctx, repository } = profileContext(storage);
      const agent = { ...ctx, processId: "proc:ship" };
      await expect(handleProfileUpdate({ expectedRevision: 0, fields: DRAFT }, agent)).rejects.toThrow("signed-in human");
      await expect(handleProfileAvatarRemove({ expectedRevision: 0 }, agent)).rejects.toThrow("signed-in human");
      const cancel = vi.fn();
      await expect(handleProfileAvatarSet({ expectedRevision: 0, mimeType: "image/png" }, agent, { stream: new ReadableStream({ cancel }), length: 12 }))
        .rejects.toThrow("signed-in human");
      expect(cancel).toHaveBeenCalledOnce();
      const root = { ...ctx, callerOwnerUid: 0, peer: testPeer({ kind: "human", account: { ...OWNER, uid: 0 }, calls: ["*"] }) };
      await expect(handleProfileUpdate({ expectedRevision: 0, fields: DRAFT }, root)).rejects.toThrow("signed-in human");
      await expect(handleProfileUpdate({ expectedRevision: 0, fields: { ...DRAFT, displayName: " " } }, ctx)).rejects.toThrow("display name");
      expect(repository.applyWrites).not.toHaveBeenCalled();
      await handleProfileUpdate({ expectedRevision: 0, fields: DRAFT }, ctx);
      await expect(handleProfileUpdate({ expectedRevision: 0, fields: { ...DRAFT, about: "Raced" } }, ctx)).rejects.toThrow("changed");
      const other: ShipProfileRecord = { $type: "space.ship.profile", displayName: "Other", contactPolicy: "requests" };
      expect(() => ctx.profiles.publish(1001, 0, "bafyother", other, null, null)).toThrow("one public profile");
      expect(ctx.profiles.current(1001)).toBeNull();
      // A locked owner can neither publish nor keep a public page.
      const shadow = vi.spyOn(ctx.auth, "getShadowByUsername").mockReturnValue(null);
      await expect(handleProfileUpdate({ expectedRevision: 1, fields: { ...DRAFT, about: "Locked" } }, ctx)).rejects.toThrow("signed-in human");
      expect(await publicProfileProjection(ctx)).toBeNull();
      shadow.mockRestore();
      expect(repository.applyWrites).toHaveBeenCalledOnce();
    });
  });
});

describe("the profile picture", () => {
  it("publishes a picture with the profile, and each change of it", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { ctx, repository, uploads } = profileContext(storage);
      const set = await handleProfileAvatarSet({ expectedRevision: 0, mimeType: "image/png" }, ctx, bodyFromBytes(PNG));
      expect(set.profile).toMatchObject({ revision: 1, fields: STARTING, avatar: { cid: PNG_CID, mimeType: "image/png", size: PNG.byteLength }, cid: "bafyrecord1" });
      expect(repository.uploadBlob).toHaveBeenCalledExactlyOnceWith(expect.any(ReadableStream), PNG.byteLength, "image/png");
      expect(uploads).toEqual([PNG]);
      const png = { $type: "blob", ref: { $link: PNG_CID }, mimeType: "image/png", size: PNG.byteLength };
      expect(ctx.profiles.published(OWNER.uid)?.record.avatar).toEqual(png);
      const read = handleProfileAvatarRead({ cid: PNG_CID }, ctx);
      expect(read.data).toEqual({ cid: PNG_CID, mimeType: "image/png", size: PNG.byteLength });
      expect(await bytesOf(read.body)).toEqual(PNG);
      expect((await publicProfileProjection(ctx))?.avatar).toEqual({ cid: PNG_CID, mimeType: "image/png", size: PNG.byteLength });
      expect((await publicProfileAvatar(ctx))?.bytes).toEqual(PNG);

      // The repository keeps the picture its record shows, so other changes don't upload it again.
      await handleProfileUpdate({ expectedRevision: 1, fields: DRAFT }, ctx);
      expect(ctx.profiles.published(OWNER.uid)?.record).toMatchObject({ displayName: DRAFT.displayName, avatar: png });
      expect(repository.uploadBlob).toHaveBeenCalledOnce();

      await handleProfileAvatarSet({ expectedRevision: 2, mimeType: "image/webp" }, ctx, bodyFromBytes(WEBP));
      expect(ctx.profiles.published(OWNER.uid)?.record).toMatchObject({ displayName: DRAFT.displayName, avatar: { ref: { $link: WEBP_CID } } });
      expect(uploads).toEqual([PNG, WEBP]);
      expect(ctx.profiles.avatar(PNG_CID)).toBeNull();
      expect(() => handleProfileAvatarRead({ cid: PNG_CID }, ctx)).toThrow("isn't on your profile");

      const removed = await handleProfileAvatarRemove({ expectedRevision: 3 }, ctx);
      expect(removed.profile).toMatchObject({ revision: 4, fields: DRAFT });
      expect(removed.profile.avatar).toBeUndefined();
      expect(ctx.profiles.published(OWNER.uid)?.record).not.toHaveProperty("avatar");
      expect(ctx.profiles.avatar(WEBP_CID)).toBeNull();
      expect(await publicProfileAvatar(ctx)).toBeNull();
    });
  });

  it("publishes nothing and keeps no picture when the repository names it differently", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { ctx, repository } = profileContext(storage);
      repository.uploadBlob.mockImplementationOnce(async (body, size, mimeType) => {
        await body.cancel();
        return { $type: "blob", ref: { $link: WEBP_CID }, mimeType, size };
      });
      await expect(handleProfileAvatarSet({ expectedRevision: 0, mimeType: "image/png" }, ctx, bodyFromBytes(PNG))).rejects.toThrow("named the profile picture differently");
      expect(repository.applyWrites).not.toHaveBeenCalled();
      expect(ctx.profiles.current(OWNER.uid)).toBeNull();
      expect(ctx.profiles.avatar(PNG_CID)).toBeNull();
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
      const { ctx, repository } = profileContext(storage);
      await expect(handleProfileAvatarSet({ expectedRevision: 0, mimeType }, ctx, body())).rejects.toThrow(message);
      expect(ctx.profiles.current(OWNER.uid)).toBeNull();
      expect(repository.uploadBlob).not.toHaveBeenCalled();
    });
  });

  it("accepts only PNG, JPEG and WebP", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { ctx } = profileContext(storage);
      // SAFETY: the handler validates arguments that arrive outside the typed client.
      await expect(handleProfileAvatarSet({ expectedRevision: 0, mimeType: "image/svg+xml" } as never, ctx, bodyFromBytes(PNG))).rejects.toThrow();
      expect(ctx.profiles.current(OWNER.uid)).toBeNull();
    });
  });
});

describe("a takedown by the Ship's open-network host", () => {
  it("hides the public page while the host has taken down the account or the profile record, and only the picture for its picture", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { ctx, repository } = profileContext(storage);
      await handleProfileAvatarSet({ expectedRevision: 0, mimeType: "image/png" }, ctx, bodyFromBytes(PNG));
      const page = await publicProfileProjection(ctx);
      expect(page?.avatar).toEqual({ cid: PNG_CID, mimeType: "image/png", size: PNG.byteLength });
      const takenDown = (subject: PublicTakedown["subject"]): PublicTakedown[] => [{ subject, ref: "audit_1", reason: "Impersonation", at: 1 }];

      for (const subject of [
        { $type: "com.atproto.admin.defs#repoRef", did: SHIP.did },
        { $type: "com.atproto.repo.strongRef", uri: `at://${SHIP.did}/space.ship.profile/self`, cid: "bafyrecord1" },
      ] satisfies PublicTakedown["subject"][]) {
        repository.takedowns.mockResolvedValue(takenDown(subject));
        expect(await publicProfileProjection(ctx)).toBeNull();
        expect(await publicProfileAvatar(ctx)).toBeNull();
      }
      repository.takedowns.mockResolvedValue(takenDown({ $type: "com.atproto.repo.strongRef", uri: `at://${SHIP.did}/space.ship.note/self`, cid: "bafynote" }));
      expect(await publicProfileProjection(ctx)).toEqual(page);
      repository.takedowns.mockResolvedValue(takenDown({ $type: "com.atproto.admin.defs#repoBlobRef", did: SHIP.did, cid: PNG_CID }));
      const { avatar: _picture, ...withoutPicture } = page ?? {};
      expect(await publicProfileProjection(ctx)).toEqual(withoutPicture);
      expect(await publicProfileAvatar(ctx)).toBeNull();
      repository.takedowns.mockResolvedValue([]);
      expect(await publicProfileProjection(ctx)).toEqual(page);
      expect((await publicProfileAvatar(ctx))?.bytes).toEqual(PNG);

      // The page fails closed while the host can't say what it has taken down.
      repository.takedowns.mockRejectedValue(new Error("PDS unavailable"));
      await expect(publicProfileProjection(ctx)).rejects.toThrow("PDS unavailable");
      await expect(publicProfileAvatar(ctx)).rejects.toThrow("PDS unavailable");
    });
  });
});

describe("the profile on Bluesky", () => {
  const PICTURE: PublicBlobRef = { $type: "blob", ref: { $link: PNG_CID }, mimeType: "image/png", size: PNG.byteLength };
  const takenDown = (subject: PublicTakedown["subject"]): PublicTakedown[] => [{ subject, ref: "audit_1", reason: "Impersonation", at: 1 }];

  it("keeps the published profile as Bluesky's profile record, changing both in one commit", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { ctx, repository } = profileContext(storage);
      await handleProfileAvatarSet({ expectedRevision: 0, mimeType: "image/png" }, ctx, bodyFromBytes(PNG));
      await handleProfileUpdate({ expectedRevision: 1, fields: DRAFT }, ctx);
      expect(repository.applyWrites).toHaveBeenLastCalledWith([
        { action: "put", collection: "space.ship.profile", rkey: "self", record: {
          $type: "space.ship.profile", displayName: DRAFT.displayName, about: DRAFT.about, avatar: PICTURE, contactPolicy: "requests",
        } },
        blueskyPut({ displayName: DRAFT.displayName, description: DRAFT.about, avatar: PICTURE }),
      ]);
      // One upload serves both records.
      expect(repository.uploadBlob).toHaveBeenCalledOnce();

      // Bluesky doesn't show WebP, so its profile leaves that picture out.
      await handleProfileAvatarSet({ expectedRevision: 2, mimeType: "image/webp" }, ctx, bodyFromBytes(WEBP));
      const [record, bluesky] = repository.applyWrites.mock.lastCall![0];
      expect(record).toMatchObject({ collection: "space.ship.profile", record: { avatar: { ref: { $link: WEBP_CID } } } });
      expect(bluesky).toEqual(blueskyPut({ displayName: DRAFT.displayName, description: DRAFT.about }));
    });
  });

  it("writes the record when Bluesky's copy it would delete is already gone", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { ctx, repository, records } = profileContext(storage);
      await handleProfileUpdate({ expectedRevision: 0, fields: DRAFT }, ctx);
      // An interrupted write can leave the repository without the copy.
      records.delete(`${BLUESKY}/self`);
      repository.takedowns.mockResolvedValue(takenDown({ $type: "com.atproto.repo.strongRef", uri: `at://${SHIP.did}/${BLUESKY}/self`, cid: "bafymirror" }));
      await handleProfileUpdate({ expectedRevision: 1, fields: { ...DRAFT, about: "Edited" } }, ctx);
      const put = { action: "put", collection: "space.ship.profile", rkey: "self", record: expect.objectContaining({ about: "Edited" }) };
      expect(repository.applyWrites.mock.calls.slice(1).map(([writes]) => writes)).toEqual([
        [put, { action: "delete", collection: BLUESKY, rkey: "self" }],
        [put],
      ]);
      expect([...records]).toEqual(["space.ship.profile/self"]);
      expect(ctx.profiles.published(OWNER.uid)?.record.about).toBe("Edited");
      expect(ctx.profiles.holdsMirror(OWNER.uid, null)).toBe(true);
    });
  });

  // While the whole account is down the host refuses every write, and relays already hide the account.
  it.each<[string, PublicTakedown["subject"]]>([
    ["the profile", { $type: "com.atproto.repo.strongRef", uri: `at://${SHIP.did}/space.ship.profile/self`, cid: "bafyrecord1" }],
    ["Bluesky's profile record", { $type: "com.atproto.repo.strongRef", uri: `at://${SHIP.did}/${BLUESKY}/self`, cid: "bafymirror" }],
  ])("deletes Bluesky's copy while the host has %s down, and writes it again once the host restores it", async (_label, subject) => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { ctx, repository, records } = profileContext(storage);
      await handleProfileUpdate({ expectedRevision: 0, fields: DRAFT }, ctx);
      // Bluesky reads the firehose, not the host's takedowns, so a copy written now would show what the host hid.
      repository.takedowns.mockResolvedValue(takenDown(subject));
      await handleProfileUpdate({ expectedRevision: 1, fields: { ...DRAFT, about: "Edited while down" } }, ctx);
      expect(repository.applyWrites).toHaveBeenLastCalledWith([
        expect.objectContaining({ action: "put", collection: "space.ship.profile" }),
        { action: "delete", collection: BLUESKY, rkey: "self" },
      ]);
      expect(records.has(`${BLUESKY}/self`)).toBe(false);
      // A sign-in while it is down writes nothing.
      const writes = repository.applyWrites.mock.calls.length;
      await ensurePublishedProfile(OWNER.uid, ctx);
      expect(repository.applyWrites).toHaveBeenCalledTimes(writes);

      repository.takedowns.mockResolvedValue([]);
      await ensurePublishedProfile(OWNER.uid, ctx);
      expect(repository.applyWrites).toHaveBeenLastCalledWith([blueskyPut({ displayName: DRAFT.displayName, description: "Edited while down" })]);
      expect(records.has(`${BLUESKY}/self`)).toBe(true);
    });
  });

  it("leaves out a picture whose file the host has down, and shows it again once restored", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { ctx, repository } = profileContext(storage);
      repository.takedowns.mockResolvedValue(takenDown({ $type: "com.atproto.admin.defs#repoBlobRef", did: SHIP.did, cid: PNG_CID }));
      await handleProfileAvatarSet({ expectedRevision: 0, mimeType: "image/png" }, ctx, bodyFromBytes(PNG));
      expect(repository.applyWrites.mock.lastCall![0][1]).toEqual(blueskyPut({ displayName: "local" }));
      repository.takedowns.mockResolvedValue([]);
      await ensurePublishedProfile(OWNER.uid, ctx);
      expect(repository.applyWrites).toHaveBeenLastCalledWith([blueskyPut({ displayName: "local", avatar: PICTURE })]);
    });
  });

  it("gives a profile published before Ships kept one on Bluesky its copy at the next sign-in, then asks the host nothing", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { ctx, repository, host } = profileContext(storage);
      const record: ShipProfileRecord = { $type: "space.ship.profile", displayName: DRAFT.displayName, about: DRAFT.about, contactPolicy: "requests" };
      // As an earlier release left it: the record published, with nothing beside it.
      ctx.profiles.publish(OWNER.uid, 0, "bafyrecord0", record, null, null);
      await ensurePublishedProfile(OWNER.uid, ctx);
      expect(repository.applyWrites).toHaveBeenCalledExactlyOnceWith([blueskyPut({ displayName: DRAFT.displayName, description: DRAFT.about })]);
      expect(ctx.profiles.published(OWNER.uid)).toEqual({ cid: "bafyrecord0", record });

      const asked = host.getInstallation.mock.calls.length;
      await ensurePublishedProfile(OWNER.uid, ctx);
      expect(host.getInstallation).toHaveBeenCalledTimes(asked);
      expect(repository.applyWrites).toHaveBeenCalledOnce();
    });
  });

  it("asks the host once when a sign-in and a message from elsewhere reach the Ship together", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { ctx, repository, host } = profileContext(storage);
      const record: ShipProfileRecord = { $type: "space.ship.profile", displayName: DRAFT.displayName, contactPolicy: "requests" };
      ctx.profiles.publish(OWNER.uid, 0, "bafyrecord0", record, null, null);
      await Promise.all([ensurePublishedProfile(OWNER.uid, ctx), ensurePublishedProfile(OWNER.uid, ctx)]);
      expect(repository.applyWrites).toHaveBeenCalledExactlyOnceWith([blueskyPut({ displayName: DRAFT.displayName })]);
      // One read of the takedowns, and the commit.
      expect(host.getInstallation).toHaveBeenCalledTimes(2);
    });
  });

  it("gives the copy to a person who reaches their Ship only from a messenger, after their message, then asks the host nothing", async () => {
    const installationId = `inst_messenger_${crypto.randomUUID()}`;
    const kernel = () => getKernelByInstallationId(env.KERNEL, installationId);
    const { repository, host } = profileHost();
    const record: ShipProfileRecord = { $type: "space.ship.profile", displayName: DRAFT.displayName, about: DRAFT.about, contactPolicy: "requests" };
    // The Kernel is real; the conversation and the Ship's process take each message as delivered.
    vi.spyOn(utils, "getConversationById").mockReturnValue({
      initialize: vi.fn(async () => undefined),
      append: vi.fn(async (input) => ({ created: true, message: { id: input.messageId, sequence: 1 } })),
    });
    vi.spyOn(utils, "sendFrameToProcess").mockImplementation(async (_installationId, _pid, frame) => ({
      type: "res", id: frame.id, ok: true,
      data: frame.call === "proc.adapter.deliver" ? { ok: true, status: "started", runId: frame.args.runId, queued: false } : { ok: true },
    }));
    await runInDurableObject(await kernel(), async (instance: Kernel) => {
      await instance.ensureInstallationIdentity({ installationId, handle: "local", canonicalOrigin: "https://local.example" });
      instance.auth.addUser({ username: OWNER.username, uid: OWNER.uid, gid: OWNER.gid, gecos: OWNER.gecos, home: OWNER.home, shell: "/bin/init" });
      instance.auth.addGroup({ name: "users", gid: 100, members: [OWNER.username] });
      instance.auth.addGroup({ name: OWNER.username, gid: OWNER.gid, members: [] });
      instance.auth.setShadow(makeShadowEntry(OWNER.username, "unlocked"));
      commitAccount(instance.buildKernelContext({}), {
        kind: "agent", username: "ship", gecos: "Ship", ownerUid: OWNER.uid, crossMemberOwner: true, personalAgentOf: OWNER.uid,
      });
      instance.adapters.identityLinks.link(MESSENGER.adapter, MESSENGER.accountId, MESSENGER.actorId, OWNER.uid, OWNER.uid);
      // As an earlier release left it: the record published, with nothing beside it.
      instance.profiles.publish(OWNER.uid, 0, "bafyrecord0", record, null, null);
    });

    await runInDurableObject(await kernel(), async (instance: Kernel) => {
      const { ctx, deferred } = messengerContext(instance, host);
      // The commit waits until the message is in, so a message that waited for the host would never arrive.
      const commit = holdNextCommit(repository);
      await expect(messengerMessage(ctx, "wamid-1")).resolves.toMatchObject({ ok: true, delivered: { uid: OWNER.uid } });
      commit.release();
      await Promise.all(deferred);
      expect(repository.applyWrites).toHaveBeenCalledExactlyOnceWith([blueskyPut({ displayName: DRAFT.displayName, description: DRAFT.about })]);
    });

    // A Kernel that starts again finds the Ship afresh, and the copy already matches.
    await evictDurableObject(await kernel());
    await runInDurableObject(await kernel(), async (instance: Kernel) => {
      const { ctx, deferred } = messengerContext(instance, host);
      const asked = host.getInstallation.mock.calls.length;
      await expect(messengerMessage(ctx, "wamid-2")).resolves.toMatchObject({ ok: true, delivered: { uid: OWNER.uid } });
      await Promise.all(deferred);
      expect(host.getInstallation).toHaveBeenCalledTimes(asked);
      expect(repository.applyWrites).toHaveBeenCalledOnce();
    });
  });
});

describe("an operator's change to the host's takedowns", () => {
  const PICTURE: PublicBlobRef = { $type: "blob", ref: { $link: PNG_CID }, mimeType: "image/png", size: PNG.byteLength };
  const takenDown = (subject: PublicTakedown["subject"]): PublicTakedown[] => [{ subject, ref: "audit_1", reason: "Impersonation", at: 1 }];
  const PROFILE_DOWN: PublicTakedown["subject"] = { $type: "com.atproto.repo.strongRef", uri: `at://${SHIP.did}/space.ship.profile/self`, cid: "bafyrecord1" };

  it.each<[string, PublicTakedown["subject"]]>([
    ["the profile", PROFILE_DOWN],
    ["Bluesky's profile record", { $type: "com.atproto.repo.strongRef", uri: `at://${SHIP.did}/${BLUESKY}/self`, cid: "bafymirror" }],
  ])("deletes Bluesky's copy as soon as the operator takes %s down, and writes it again as soon as they restore it", async (_label, subject) => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { ctx, repository, records } = profileContext(storage);
      await handleProfileUpdate({ expectedRevision: 0, fields: DRAFT }, ctx);
      repository.takedowns.mockResolvedValue(takenDown(subject));
      expect(await followHostTakedowns(ctx)).toBe("removed");
      expect(repository.applyWrites).toHaveBeenLastCalledWith([{ action: "delete", collection: BLUESKY, rkey: "self" }]);
      expect(records.has(`${BLUESKY}/self`)).toBe(false);
      // Told again, the copy is already as the takedowns make it.
      const writes = repository.applyWrites.mock.calls.length;
      expect(await followHostTakedowns(ctx)).toBe("unchanged");
      expect(repository.applyWrites).toHaveBeenCalledTimes(writes);

      repository.takedowns.mockResolvedValue([]);
      expect(await followHostTakedowns(ctx)).toBe("updated");
      expect(repository.applyWrites).toHaveBeenLastCalledWith([blueskyPut({ displayName: DRAFT.displayName, description: DRAFT.about })]);
      expect(records.has(`${BLUESKY}/self`)).toBe(true);
    });
  });

  it("leaves the picture out as soon as the operator takes its file down, and puts it back once they restore it", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { ctx, repository } = profileContext(storage);
      await handleProfileAvatarSet({ expectedRevision: 0, mimeType: "image/png" }, ctx, bodyFromBytes(PNG));
      repository.takedowns.mockResolvedValue(takenDown({ $type: "com.atproto.admin.defs#repoBlobRef", did: SHIP.did, cid: PNG_CID }));
      expect(await followHostTakedowns(ctx)).toBe("updated");
      expect(repository.applyWrites).toHaveBeenLastCalledWith([blueskyPut({ displayName: "local" })]);
      repository.takedowns.mockResolvedValue([]);
      expect(await followHostTakedowns(ctx)).toBe("updated");
      expect(repository.applyWrites).toHaveBeenLastCalledWith([blueskyPut({ displayName: "local", avatar: PICTURE })]);
    });
  });

  it("leaves the copy to the account's status while the whole account is down, and changes nothing for another record", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { ctx, repository, records } = profileContext(storage);
      await handleProfileUpdate({ expectedRevision: 0, fields: DRAFT }, ctx);
      const writes = repository.applyWrites.mock.calls.length;
      // The host refuses every write while the account is down, and relays hide the whole account meanwhile.
      repository.takedowns.mockResolvedValue([
        ...takenDown({ $type: "com.atproto.admin.defs#repoRef", did: SHIP.did }), ...takenDown(PROFILE_DOWN),
      ]);
      expect(await followHostTakedowns(ctx)).toBe("unchanged");
      repository.takedowns.mockResolvedValue(takenDown({ $type: "com.atproto.repo.strongRef", uri: `at://${SHIP.did}/space.ship.note/self`, cid: "bafynote" }));
      expect(await followHostTakedowns(ctx)).toBe("unchanged");
      expect(repository.applyWrites).toHaveBeenCalledTimes(writes);
      expect(records.has(`${BLUESKY}/self`)).toBe(true);
    });
  });

  it("asks the host nothing before the profile is published or without an open-network host", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { ctx, repository } = profileContext(storage);
      expect(await followHostTakedowns(ctx)).toBe("unchanged");
      expect(await followHostTakedowns(profileContext(storage, { pds: false }).ctx)).toBe("unchanged");
      expect(repository.takedowns).not.toHaveBeenCalled();
    });
  });

  it("waits for a publication under way, then follows the takedowns against the profile it published", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { ctx, repository, records } = profileContext(storage);
      await handleProfileUpdate({ expectedRevision: 0, fields: DRAFT }, ctx);
      const held = holdNextCommit(repository);
      const publishing = handleProfileUpdate({ expectedRevision: 1, fields: { ...DRAFT, about: "Edited" } }, ctx);
      // The publication read the takedowns before the operator took the profile down, and is committing its copy.
      await vi.waitFor(() => expect(repository.applyWrites).toHaveBeenCalledTimes(2));
      repository.takedowns.mockResolvedValue(takenDown({ ...PROFILE_DOWN, cid: "bafyrecord2" }));
      const following = followHostTakedowns(ctx);
      // Had it not waited its turn, the copy's deletion would land before the held publication's copy.
      await new Promise((resolve) => setTimeout(resolve, 0));
      held.release();
      await publishing;
      expect(await following).toBe("removed");
      expect(repository.applyWrites).toHaveBeenLastCalledWith([{ action: "delete", collection: BLUESKY, rkey: "self" }]);
      expect(records.has(`${BLUESKY}/self`)).toBe(false);
      expect(ctx.profiles.holdsMirror(OWNER.uid, null)).toBe(true);
    });
  });
});

describe("the owner's profile as they use their Ship", () => {
  it("publishes the starting profile at the first use, from sign-in or any surface, then asks the host nothing", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { ctx, repository, host } = profileContext(storage);
      await ensurePublishedProfile(OWNER.uid, ctx);
      const record: ShipProfileRecord = { $type: "space.ship.profile", displayName: "local", contactPolicy: "requests" };
      expect(repository.applyWrites).toHaveBeenCalledExactlyOnceWith([
        { action: "put", collection: "space.ship.profile", rkey: "self", record },
        blueskyPut({ displayName: "local" }),
      ]);
      expect(handleProfileGet(ctx).profile).toEqual({ revision: 1, url: PROFILE_URL, handle: "local", fields: STARTING, cid: "bafyrecord1" });
      expect(ctx.broadcastToUserUid).toHaveBeenCalledWith(OWNER.uid, "profile.changed");
      const asked = host.getInstallation.mock.calls.length;
      await ensurePublishedProfile(OWNER.uid, ctx);
      expect(host.getInstallation).toHaveBeenCalledTimes(asked);
    });
  });

  it("retries the starting profile at the next use after a failed publish", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { ctx, repository } = profileContext(storage);
      repository.applyWrites.mockRejectedValueOnce(new Error("The repository is unavailable"));
      await expect(ensurePublishedProfile(OWNER.uid, ctx)).rejects.toThrow("unavailable");
      expect(ctx.profiles.current(OWNER.uid)).toBeNull();
      await ensurePublishedProfile(OWNER.uid, ctx);
      expect(ctx.profiles.published(OWNER.uid)?.record).toEqual({ $type: "space.ship.profile", displayName: "local", contactPolicy: "requests" });
    });
  });

  it("leaves the profile the owner publishes while the starting profile waits its turn", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { ctx, repository } = profileContext(storage);
      const held = holdNextCommit(repository);
      const changing = handleProfileUpdate({ expectedRevision: 0, fields: { ...DRAFT, contactPolicy: "closed" } }, ctx);
      await vi.waitFor(() => expect(repository.applyWrites).toHaveBeenCalledOnce());
      const using = ensurePublishedProfile(OWNER.uid, ctx);
      held.release();
      await changing;
      await using;
      expect(repository.applyWrites).toHaveBeenCalledOnce();
      expect(ctx.profiles.published(OWNER.uid)?.record).toMatchObject({ displayName: DRAFT.displayName, contactPolicy: "closed" });
    });
  });

  it("leaves no timer running once a use has brought a profile up to date, or had nothing to do", async () => {
    const kernel = env.KERNEL.get(env.KERNEL.idFromName(crypto.randomUUID()));
    await runInDurableObject(kernel, async (_instance: Kernel, state) => {
      const { ctx, repository } = profileContext(state.storage);
      const record: ShipProfileRecord = { $type: "space.ship.profile", displayName: DRAFT.displayName, contactPolicy: "requests" };
      // As an earlier release left it: the record published, with nothing beside it.
      ctx.profiles.publish(OWNER.uid, 0, "bafyrecord0", record, null, null);
      await ensurePublishedProfile(OWNER.uid, ctx);
      await ensurePublishedProfile(OWNER.uid, ctx);
      expect(repository.applyWrites).toHaveBeenCalledOnce();
    });
    // A Kernel with a timer pending isn't idle, so one left behind would hold it awake after every sign-in.
    const stopping = evictDurableObject(kernel).then(() => "stopped");
    expect(await Promise.race([stopping, new Promise((resolve) => setTimeout(resolve, 2_000, "held"))])).toBe("stopped");
  });

  it("publishes nothing without an open-network host", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { ctx } = profileContext(storage, { pds: false });
      await ensurePublishedProfile(OWNER.uid, ctx);
      expect(ctx.profiles.current(OWNER.uid)).toBeNull();
      await expect(handleProfileUpdate({ expectedRevision: 0, fields: DRAFT }, ctx)).rejects.toThrow("isn't available on this deployment");
      expect(handleProfileGet(ctx).profile).toEqual({ revision: 0, url: PROFILE_URL, handle: "local", fields: STARTING });
    });
  });

  it("writes a profile signed before profiles were records to the repository at the next use", async () => {
    await runWithRealKernelSql(async (sql, storage) => {
      // The profile tables as v074 left them: a published, signed profile and a draft edited since.
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
      storage.transactionSync(() => { for (const statement of PROFILE_MIGRATIONS_SINCE_V074) sql.exec(statement); });

      const { ctx, repository } = profileContext(storage);
      const record: ShipProfileRecord = { $type: "space.ship.profile", displayName: "Signed name", about: "Signed about", contactPolicy: "invitation" };
      // The profile is what was published; the draft never was, so it is gone.
      expect(ctx.profiles.unwritten(OWNER.uid)).toEqual(record);
      expect(handleProfileGet(ctx).profile).toEqual({
        revision: 3, url: PROFILE_URL, handle: "local", fields: { displayName: "Signed name", about: "Signed about", contactPolicy: "closed" },
      });
      // Until the repository holds it, the profile has no CID and no public page.
      expect(ctx.profiles.published(OWNER.uid)).toBeNull();
      expect(await publicProfileProjection(ctx)).toBeNull();

      await ensurePublishedProfile(OWNER.uid, ctx);
      expect(repository.applyWrites).toHaveBeenCalledExactlyOnceWith([
        { action: "put", collection: "space.ship.profile", rkey: "self", record },
        blueskyPut({ displayName: "Signed name", description: "Signed about" }),
      ]);
      expect(ctx.profiles.published(OWNER.uid)).toEqual({ cid: "bafyrecord1", record });
      expect(handleProfileGet(ctx).profile).toMatchObject({ revision: 3, cid: "bafyrecord1" });
      expect(ctx.profiles.unwritten(OWNER.uid)).toBeNull();
      await ensurePublishedProfile(OWNER.uid, ctx);
      expect(repository.applyWrites).toHaveBeenCalledOnce();
    });
  });

  it("keeps a signed profile with an empty about, and drops a draft never published", async () => {
    await runWithRealKernelSql(async (sql, storage) => {
      sql.exec("DROP TABLE social_profile_avatars");
      sql.exec("DROP TABLE social_profiles");
      sql.exec(KERNEL_V059_PUBLIC_PROFILES.statements[0]!);
      sql.exec("INSERT INTO social_profiles (owner_uid, subject_id, revision, draft_json, published_revision, published_json) VALUES (?, ?, ?, ?, ?, ?)",
        OWNER.uid, "subject:local", 1, JSON.stringify({ ...DRAFT, representation: "human" }), 1,
        JSON.stringify({ displayName: "Signed name", about: "", contactPolicy: "requests", representation: "human" }));
      sql.exec("INSERT INTO social_profiles (owner_uid, subject_id, revision, draft_json) VALUES (?, ?, ?, ?)",
        1001, "subject:other", 2, JSON.stringify({ ...DRAFT, representation: "ship" }));
      storage.transactionSync(() => { for (const statement of PROFILE_MIGRATIONS_SINCE_V074) sql.exec(statement); });
      const profiles = new ProfileStore(storage);
      expect(profiles.unwritten(OWNER.uid)).toEqual({ $type: "space.ship.profile", displayName: "Signed name", contactPolicy: "requests" });
      expect(profiles.current(1001)).toBeNull();
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

  const ALICE = { handle: "alice.ship.test", cid: "bafyreialice", displayName: "Alice", about: "Hello", contactPolicy: "requests", url: "https://alice.ship.test" };

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
      // Earlier Ships wrote "invitation" for a profile that took only invited people.
      record = { ...unwritten, contactPolicy: "invitation" };
      expect((await handleProfileResolve({ address: "@alice" }, ctx)).profile).toMatchObject({ about: "", contactPolicy: "closed" });
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

  it("says a host that serves no repositories can't be read now, rather than that the profile is private", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const { ctx } = profileContext(storage);
      network.hosts.set(new URL(TEST_PDS_URL).host, () => new Response("Not Found", { status: 404 }));
      const unreachable = { name: "FederationHttpError", status: 503, message: "Couldn't read @alice.ship.test's profile: its open-network host answered 404. Try again later." };
      await expect(handleProfileResolve({ address: "@alice" }, ctx)).rejects.toMatchObject(unreachable);
      await expect(readPublicProfile(alice.did, ctx)).rejects.toMatchObject(unreachable);
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
  const { repository, host, uploads, records } = profileHost();
  const context = {
    installationId: "inst_local",
    installationIdentity: { installationId: "inst_local", canonicalOrigin: "https://local.example", handle: "local" },
    env: { GSV_PUBLIC_CONFIG: PUBLIC_CONFIG, PLC_URL: TEST_PLC_URL, PDS: pds ? host : undefined },
    peer: testPeer({ kind: "human", account: OWNER, calls: ["profile.*"] }), callerOwnerUid: OWNER.uid, connection: {},
    procs: { get: () => ({ isPersonalController: true, ownerUid: OWNER.uid }), getOwnerUid: () => OWNER.uid },
    profiles: new ProfileStore(storage), config: new ConfigStore(storage.sql),
    shipIdentity: new ShipIdentity(storage), didDocuments: new DidDocumentStore(storage.sql),
    auth: { getPasswdByUid: (uid: number) => uid === OWNER.uid ? OWNER : null, getShadowByUsername: () => ({ hash: "unlocked" }), isPersonalAgentUid: () => false },
    broadcastToUserUid: vi.fn(), defer: vi.fn(),
  };
  // SAFETY: profile handlers use the real stores and the explicit account, repository, directory and notification fakes above.
  return { ctx: context as KernelContext, repository, uploads, records, host };
}

/** The Ship's open-network host: one repository, which keeps the records it holds and names pictures by their bytes. */
function profileHost() {
  let stored = 0;
  const uploads: Uint8Array[] = [];
  /** The records the repository holds, by collection and record key. */
  const records = new Set<string>();
  const repository = {
    account: vi.fn<PublicRepository["account"]>(async () => SHIP),
    ensureAccount: vi.fn<PublicRepository["ensureAccount"]>(async () => SHIP),
    serviceAuth: vi.fn<PublicRepository["serviceAuth"]>(),
    applyWrites: vi.fn<PublicRepository["applyWrites"]>(async (writes) => {
      // As the PDS does, the repository refuses a delete of a record it doesn't hold, and then commits nothing.
      const missing = writes.find((write) => write.action === "delete" && !records.has(`${write.collection}/${write.rkey}`));
      if (missing) throw new Error(`InvalidRequest: Could not find a record with key: ${missing.collection}/${missing.rkey}`);
      for (const write of writes) {
        if (write.action === "delete") records.delete(`${write.collection}/${write.rkey}`);
        else records.add(`${write.collection}/${write.rkey}`);
      }
      return {
        commit: { cid: "bafycommit", rev: "3l2" },
        results: writes.map((write) => ({
          uri: `at://${SHIP.did}/${write.collection}/${write.rkey}`,
          cid: write.action === "delete" ? null : write.collection === BLUESKY ? "bafymirror" : `bafyrecord${++stored}`,
        })),
      };
    }),
    uploadBlob: vi.fn<PublicRepository["uploadBlob"]>(async (body, size, mimeType) => {
      const bytes = new Uint8Array(await new Response(body).arrayBuffer());
      uploads.push(bytes);
      const cid = [[PNG, PNG_CID], [WEBP, WEBP_CID]].find(([known]) => equalBytes(bytes, known))?.[1] ?? "bafkreiunknown";
      return { $type: "blob", ref: { $link: cid }, mimeType, size };
    }),
    readBlob: vi.fn<PublicRepository["readBlob"]>(),
    takedowns: vi.fn<PublicRepository["takedowns"]>(async () => []),
    [Symbol.dispose]: vi.fn(),
  };
  const host = { getInstallation: vi.fn(async () => repository) };
  return { repository, host, uploads, records };
}

/** The Kernel as the messenger's adapter reaches it, at the open-network host, keeping what it defers for the test to await. */
function messengerContext(instance: Kernel, host: ReturnType<typeof profileHost>["host"]) {
  const base = instance.buildKernelContext({ peer: testPeer({ kind: "service", account: ROOT, calls: ["adapter.inbound"] }) });
  const deferred: Promise<unknown>[] = [];
  const ctx: KernelContext = {
    ...base,
    env: { ...base.env, GSV_PUBLIC_CONFIG: PUBLIC_CONFIG, PDS: host },
    defer: (promise) => { deferred.push(promise); },
  };
  return { ctx, deferred };
}

/** The person's private WhatsApp message to their Ship. */
function messengerMessage(ctx: KernelContext, messageId: string) {
  return handleAdapterInbound({
    adapter: MESSENGER.adapter, accountId: MESSENGER.accountId, deliveryId: messageId,
    message: { messageId, surface: { kind: "dm", id: "dm-1" }, actor: { id: MESSENGER.actorId }, text: "Hello Ship" },
  }, ctx);
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
