import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type { ProfileFields } from "@humansandmachines/gsv/protocol";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import { testPeer } from "../test-support/peers";
import { createInstallationStorage } from "../installation/storage";
import type { KernelContext } from "./context";
import { FederationStore } from "./federation-store";
import { FederationIdentity } from "./federation-crypto";
import { CapabilityStore } from "./capabilities";
import { handleAccountUpdate } from "./agents";
import { AuthStore } from "./auth-store";
import { ProfileStore } from "./profile-store";
import { handleProfileGet, handleProfileUpdate, handleProfilePublish, handleProfileUnpublish, resolveSpacePublicProfile, verifyPublicProfile } from "./profiles";
import { KERNEL_V045_ADD_HUMAN_INVITATIONS } from "./schema/v045_add_human_invitations";
import { KERNEL_V069_SINGLE_HUMAN_SPACE } from "./schema/v069_single_human_space";
import { jsonValueSchema } from "@humansandmachines/gsv/protocol";
import { makeShadowEntry } from "../auth/shadow";

const OWNER = { uid: 1000, gid: 1000, gids: [1000], username: "private-login", gecos: "Person", home: "/home/private-login", cwd: "/home/private-login" };
const DRAFT: ProfileFields = { displayName: "Published name", about: "Hello from my space", contactPolicy: "requests", representation: "human-and-ship" };

describe("explicit profile publication", () => {
  it.each([false, true])("upgrades a published alias without exposing the draft or undoing unpublish (concurrent unpublish: %s)", async (unpublish) => {
    await runWithRealKernelSql(async (sql, storage) => {
      const ctx = profileContext(storage);
      handleProfileUpdate({ expectedRevision: 0, draft: DRAFT }, ctx);
      await handleProfilePublish({ expectedRevision: 1 }, ctx);
      const { signature: _signature, ...snapshot } = ctx.profiles.published({ space: true })!.profile;
      const unsigned = { ...snapshot, version: 2 as const, domain: "gsv-federation/2/profile" as const, alias: "old-person", url: "https://local.example/@old-person" };
      const legacy = { ...unsigned, signature: await ctx.federationIdentity.sign(jsonValueSchema.parse(unsigned)) };
      sql.exec("UPDATE social_profiles SET published_alias = ?, published_json = ?, revision = 2, draft_json = ?", legacy.alias, JSON.stringify(legacy), JSON.stringify({ ...DRAFT, alias: "new-private-alias", about: "Private revision" }));
      // Recreate the removed v68 tables to exercise the upgrade against persisted state.
      for (const statement of KERNEL_V045_ADD_HUMAN_INVITATIONS.statements) sql.exec(statement);
      sql.exec("CREATE TABLE social_profile_aliases (alias TEXT PRIMARY KEY, owner_uid INTEGER NOT NULL)");
      storage.transactionSync(() => { for (const statement of KERNEL_V069_SINGLE_HUMAN_SPACE.statements) sql.exec(statement); });
      expect(sql.exec("SELECT name FROM sqlite_master WHERE name IN ('human_invitations', 'social_profile_aliases')").toArray()).toEqual([]);
      expect(ctx.profiles.get(OWNER.uid, "https://local.example")?.draft).toEqual({ ...DRAFT, about: "Private revision" });
      expect(ctx.profiles.published({ space: true })?.profile).toEqual(legacy);
      const sign = ctx.federationIdentity.sign.bind(ctx.federationIdentity);
      if (unpublish) vi.spyOn(ctx.federationIdentity, "sign").mockImplementationOnce(async (value) => {
        await handleProfileUnpublish({ expectedRevision: 2 }, ctx);
        return sign(value);
      });
      const projection = await resolveSpacePublicProfile({ alias: "old-person" }, ctx);
      if (unpublish) {
        expect(projection).toBeNull();
        expect(ctx.profiles.published({ space: true })).toBeNull();
      } else {
        expect(projection?.profile).toMatchObject({ version: 4, url: "https://local.example/profile", about: DRAFT.about, revision: 1 });
        expect(projection?.profile).not.toHaveProperty("alias");
        await verifyPublicProfile(projection!.profile, legacy.url);
        await verifyPublicProfile(projection!.profile, "https://local.example/profile");
        expect(await resolveSpacePublicProfile({ space: true }, ctx)).toEqual(projection);
      }
    });
  });

  it("saves chosen names atomically and retains the published identity until republishing", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const ctx = profileContext(storage);
      const shipBefore = ctx.auth.getPasswdByUid(1001)!;
      const draft = { ...DRAFT, ship: { displayName: "Just Another Algorithm", about: "John’s Ship." } };
      handleProfileUpdate({ expectedRevision: 0, draft }, ctx);
      expect(ctx.auth.getPasswdByUid(1001)).toEqual({ ...shipBefore, gecos: "Just Another Algorithm" });
      expect(ctx.federation.subject(OWNER.uid)?.displayName).toBe(DRAFT.displayName);
      expect(() => handleProfileUpdate({ expectedRevision: 0, draft: { ...draft, ship: { ...draft.ship, displayName: "Stale rename" } } }, ctx)).toThrow("changed");
      expect(ctx.auth.getPasswdByUid(1001)?.gecos).toBe("Just Another Algorithm");
      await handleProfilePublish({ expectedRevision: 1 }, ctx);
      const published = ctx.profiles.published({ space: true })!.profile;
      expect(published).toMatchObject({ version: 4, ship: draft.ship });
      await verifyPublicProfile(published, published.url);
      const renamed = handleAccountUpdate({ uid: 1001, expectedDisplayName: "Just Another Algorithm", displayName: "星の旅人" }, ctx);
      expect(renamed.profileRevision).toBe(2);
      expect(handleProfileGet(ctx).profile).toMatchObject({ draft: { ship: { displayName: "星の旅人" } }, shipAccount: { displayName: "星の旅人" } });
      expect(ctx.profiles.published({ space: true })!.profile).toEqual(published);
      expect(() => handleAccountUpdate({ uid: 1001, expectedDisplayName: "Just Another Algorithm", displayName: "Lost update" }, ctx)).toThrow("changed");
      handleProfileUpdate({ expectedRevision: 2, draft: { ...draft, ship: { ...draft.ship, displayName: "星の旅人" }, representation: "human" } }, ctx);
      await handleProfilePublish({ expectedRevision: 3 }, ctx);
      expect(ctx.profiles.published({ space: true })!.profile).not.toHaveProperty("ship");
      expect(new AuthStore(storage.sql).getPasswdByUid(1001)?.gecos).toBe("星の旅人");
    });
  });

  it("requires naming authority and refuses changes to unrelated accounts", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const ctx = profileContext(storage);
      const limited = { ...ctx, peer: testPeer({ kind: "human", account: OWNER, calls: ["profile.*"] }) };
      expect(() => handleProfileUpdate({ expectedRevision: 0, draft: DRAFT }, limited)).toThrow("account.update");
      expect(ctx.profiles.get(OWNER.uid, "https://local.example")).toBeNull();
      expect(() => handleAccountUpdate({ uid: 1001, displayName: "Accidental model name", expectedDisplayName: "Ship" }, { ...ctx, processId: "proc:ship" })).toThrow("signed-in human");
      expect(() => handleAccountUpdate({ uid: 0, displayName: "Renamed", expectedDisplayName: "root" }, ctx)).toThrow("not owned");
      expect(() => handleAccountUpdate({ uid: 1001, displayName: "Invalid:name", expectedDisplayName: "Ship" }, ctx)).toThrow();
      expect(ctx.auth.getPasswdByUid(1001)?.gecos).toBe("Ship");
    });
  });

  it("fences a first profile save after an administrator renames the Ship", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const ctx = profileContext(storage);
      const root = { uid: 0, gid: 0, gids: [0], username: "root", home: "/root", cwd: "/root" };
      const admin = { ...ctx, peer: testPeer({ kind: "human", account: root, calls: ["*"] }), callerOwnerUid: 0 };
      const result = handleAccountUpdate({ uid: 1001, displayName: "Just Another Algorithm", expectedDisplayName: "Ship" }, admin);
      expect(result.profileRevision).toBe(1);
      expect(handleProfileGet(ctx).profile.draft.ship?.displayName).toBe("Just Another Algorithm");
      expect(() => handleProfileUpdate({ expectedRevision: 0, draft: DRAFT }, ctx)).toThrow("changed");
      expect(ctx.broadcastToUserUid).toHaveBeenCalledWith(OWNER.uid, "profile.changed");
      expect(ctx.broadcastToUserUid).toHaveBeenCalledWith(0, "account.changed");
    });
  });

  it("starts private and publishes only the exact approved snapshot across later draft edits", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const ctx = profileContext(storage);
      expect(handleProfileGet(ctx).profile).toMatchObject({ revision: 0, draft: { contactPolicy: "closed" } });
      handleProfileUpdate({ expectedRevision: 0, draft: DRAFT }, ctx);
      expect(ctx.profiles.published({ space: true })).toBeNull();
      await handleProfilePublish({ expectedRevision: 1 }, ctx);
      const approved = ctx.profiles.published({ space: true })!;
      await verifyPublicProfile(approved.profile, "https://local.example/profile");
      expect(JSON.stringify(approved.profile)).not.toContain(OWNER.username);
      expect(approved.profile).not.toHaveProperty("ownerUid");
      handleProfileUpdate({ expectedRevision: 1, draft: { ...DRAFT, about: "Private revision" } }, ctx);
      expect(handleProfileGet(ctx).profile).toMatchObject({ revision: 2, draft: { about: "Private revision" }, published: { revision: 1 } });
      expect(ctx.profiles.published({ space: true })!.profile).toEqual(approved.profile);
      await expect(verifyPublicProfile({ ...approved.profile, displayName: "Tampered" }, approved.profile.url)).rejects.toThrow("signature");
    });
  });

  it("fences a signing operation overtaken by unpublishing", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const ctx = profileContext(storage);
      handleProfileUpdate({ expectedRevision: 0, draft: DRAFT }, ctx);
      await handleProfilePublish({ expectedRevision: 1 }, ctx);
      handleProfileUpdate({ expectedRevision: 1, draft: { ...DRAFT, about: "Next revision" } }, ctx);
      const original = ctx.federationIdentity.sign.bind(ctx.federationIdentity);
      let release!: () => void;
      let started!: () => void;
      const entered = new Promise<void>((resolve) => { started = resolve; });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const signing = vi.spyOn(ctx.federationIdentity, "sign").mockImplementationOnce(async (value) => {
        started(); await gate; return original(value);
      });
      const publishing = handleProfilePublish({ expectedRevision: 2 }, ctx);
      await entered;
      await handleProfileUnpublish({ expectedRevision: 2 }, ctx);
      release();
      await expect(publishing).rejects.toThrow("changed");
      signing.mockRestore();
      expect(ctx.profiles.published({ space: true })).toBeNull();
      expect(new ProfileStore(storage).get(OWNER.uid, "https://local.example")?.revision).toBe(3);
    });
  });

  it("requires a current direct human decision and allows only one profile", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const ctx = profileContext(storage);
      const agent = { ...ctx, processId: "proc:ship" };
      expect(() => handleProfileUpdate({ expectedRevision: 0, draft: DRAFT }, agent)).toThrow("signed-in human");
      const root = { ...ctx, callerOwnerUid: 0, peer: testPeer({ kind: "human", account: { ...OWNER, uid: 0 }, calls: ["*"] }) };
      expect(() => handleProfileUpdate({ expectedRevision: 0, draft: DRAFT }, root)).toThrow("signed-in human");
      handleProfileUpdate({ expectedRevision: 0, draft: DRAFT }, ctx);
      expect(() => handleProfileUpdate({ expectedRevision: 0, draft: { ...DRAFT, about: "raced" } }, ctx)).toThrow("changed");
      await expect(handleProfilePublish({ expectedRevision: 0 }, ctx)).rejects.toThrow("changed");
      await handleProfilePublish({ expectedRevision: 1 }, ctx);
      await handleProfileUnpublish({ expectedRevision: 1 }, ctx);
      expect(() => ctx.profiles.update(1001, "subject:other", 0, DRAFT)).toThrow("one public profile");
      expect(ctx.profiles.get(1001, "https://local.example")).toBeNull();
    });
  });

  it("retains the signed snapshot in SQL and rejects publication for a locked owner", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const ctx = profileContext(storage);
      handleProfileUpdate({ expectedRevision: 0, draft: DRAFT }, ctx);
      await handleProfilePublish({ expectedRevision: 1 }, ctx);
      const restored = new ProfileStore(storage);
      expect(restored.published({ space: true })?.revision).toBe(1);
      const shadow = vi.spyOn(ctx.auth, "getShadowByUsername").mockReturnValue(null);
      await expect(handleProfilePublish({ expectedRevision: 1 }, { ...ctx, profiles: restored })).rejects.toThrow("signed-in human");
      shadow.mockRestore();
    });
  });
});

function profileContext(storage: DurableObjectStorage): KernelContext {
  const auth = new AuthStore(storage.sql);
  auth.addUser({ ...OWNER, shell: "/bin/sh" });
  auth.addUser({ uid: 1001, gid: 1001, username: "ship", gecos: "Ship", home: "/home/ship", shell: "/bin/false" });
  auth.setPersonalAgent(OWNER.uid, 1001);
  auth.setShadow(makeShadowEntry(OWNER.username, "unlocked"));
  auth.setShadow(makeShadowEntry("ship", "!"));
  const context = {
    installationIdentity: { installationId: `inst_${crypto.randomUUID()}`, canonicalOrigin: "https://local.example", handle: "local" },
    peer: testPeer({ kind: "human", account: OWNER, calls: ["profile.*", "account.update"] }), callerOwnerUid: OWNER.uid, connection: {},
    profiles: new ProfileStore(storage), federation: new FederationStore(storage), federationIdentity: new FederationIdentity(storage),
    env: { STORAGE: createInstallationStorage(env.STORAGE, `inst_${crypto.randomUUID()}`) },
    auth, caps: new CapabilityStore(storage.sql),
    broadcastToUserUid: vi.fn(),
  };
  // SAFETY: profile handlers use the real stores and the explicit account, storage and notification callbacks above.
  return context as KernelContext;
}
