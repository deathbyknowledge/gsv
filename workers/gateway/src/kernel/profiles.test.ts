import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProfileFields } from "@humansandmachines/gsv/protocol";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import { testPeer } from "../test-support/peers";
import { createInstallationStorage } from "../installation/storage";
import type { KernelContext } from "./context";
import { FederationStore } from "./federation-store";
import { FederationIdentity } from "./federation-crypto";
import { ProfileStore } from "./profile-store";
import { ConfigStore } from "./config";
import { ensureDefaultProfile, handleProfileGet, handleProfileUpdate, handleProfilePublish, handleProfileUnpublish, handleProfileResolve, resolveSpacePublicProfile, verifyPublicProfile } from "./profiles";
import { KERNEL_V045_ADD_HUMAN_INVITATIONS } from "./schema/v045_add_human_invitations";
import { KERNEL_V069_SINGLE_HUMAN_SPACE } from "./schema/v069_single_human_space";
import { jsonValueSchema } from "@humansandmachines/gsv/protocol";

const OWNER = { uid: 1000, gid: 1000, gids: [1000], username: "private-login", gecos: "Person", home: "/home/private-login", cwd: "/home/private-login" };
const DRAFT: ProfileFields = { displayName: "Published name", about: "Hello from my space", contactPolicy: "requests", representation: "human-and-ship" };

describe("explicit profile publication", () => {
  afterEach(() => vi.restoreAllMocks());

  it("resolves an address alias through an HTTPS redirect while keeping the signed identity", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const ctx = profileContext(storage);
      handleProfileUpdate({ expectedRevision: 0, draft: DRAFT }, ctx);
      await handleProfilePublish({ expectedRevision: 1 }, ctx);
      const profile = ctx.profiles.published({ space: true })!.profile;
      const fetch = vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(new Response(null, { status: 308, headers: { location: profile.url } }))
        .mockResolvedValueOnce(Response.json(profile));
      await expect(handleProfileResolve({ url: "https://local.new.example" }, ctx)).resolves.toEqual({ profile });
      expect(fetch).toHaveBeenNthCalledWith(2, profile.url, expect.objectContaining({ redirect: "manual", method: "GET" }));
      fetch.mockResolvedValueOnce(Response.json(profile));
      await expect(handleProfileResolve({ url: "https://local.new.example" }, ctx)).rejects.toThrow("signed identity");
    });
  });

  it.each(["https://127.0.0.1/profile", "https://private.internal/profile", "https://other.example/private", "https://user:pass@other.example/profile"])("refuses an unsafe profile redirect to %s", async (location) => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const cancel = vi.fn();
      const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { status: 308, headers: { location } }));
      await expect(handleProfileResolve({ url: "https://local.new.example" }, profileContext(storage))).rejects.toThrow();
      expect(fetch).toHaveBeenCalledOnce();
      expect(cancel).toHaveBeenCalledOnce();
    });
  });

  it("bounds redirect loops", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(null, { status: 308, headers: { location: "/profile" } }));
      await expect(handleProfileResolve({ url: "https://local.new.example" }, profileContext(storage))).rejects.toThrow("Too many public profile redirects");
      expect(fetch).toHaveBeenCalledTimes(4);
    });
  });

  it("reports an unavailable public profile without treating it as an invitation refusal", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const cancel = vi.fn();
      const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(new ReadableStream({ cancel }), { status: 404 }),
      );
      await expect(handleProfileResolve({ url: "https://other.example/profile" }, profileContext(storage)))
        .rejects.toMatchObject({
          name: "FederationHttpError",
          status: 404,
          message: expect.stringContaining("A private invitation does not require a public profile"),
        });
      expect(fetch).toHaveBeenCalledOnce();
      expect(cancel).toHaveBeenCalledOnce();
    });
  });

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
        expect(projection?.profile).toMatchObject({ version: 3, url: "https://local.example/profile", about: DRAFT.about, revision: 1 });
        expect(projection?.profile).not.toHaveProperty("alias");
        await verifyPublicProfile(projection!.profile, legacy.url);
        await verifyPublicProfile(projection!.profile, "https://local.example/profile");
        expect(await resolveSpacePublicProfile({ space: true }, ctx)).toEqual(projection);
      }
    });
  });

  it("publishes a public, request-open profile named by the Ship handle by default once, so an unpublish stays private", async () => {
    await runWithRealKernelSql(async (sql, storage) => {
      const ctx = profileContext(storage, sql);
      await ensureDefaultProfile(OWNER.uid, ctx);
      const published = ctx.profiles.published({ space: true })!;
      expect(published.profile).toMatchObject({ displayName: "local", about: "", contactPolicy: "requests", representation: "human", revision: 1 });
      await verifyPublicProfile(published.profile, "https://local.example/profile");
      expect(handleProfileGet(ctx).profile).toMatchObject({ revision: 1, published: { revision: 1 } });
      expect(ctx.broadcastToUserUid).toHaveBeenCalledWith(OWNER.uid, "profile.changed");
      await ensureDefaultProfile(OWNER.uid, ctx);
      expect(ctx.profiles.published({ space: true })).toEqual(published);
      await handleProfileUnpublish({ expectedRevision: 1 }, ctx);
      await ensureDefaultProfile(OWNER.uid, ctx);
      expect(ctx.profiles.published({ space: true })).toBeNull();
      expect(handleProfileGet(ctx).profile).toMatchObject({ revision: 2 });
    });
  });

  it("offers the Ship handle as the default draft name", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      expect(handleProfileGet(profileContext(storage)).profile.draft).toMatchObject({ displayName: "local", contactPolicy: "requests" });
    });
  });

  it("leaves a profile its owner unpublished before the default existed private", async () => {
    await runWithRealKernelSql(async (sql, storage) => {
      const ctx = profileContext(storage, sql);
      handleProfileUpdate({ expectedRevision: 0, draft: { ...DRAFT, contactPolicy: "invitation" } }, ctx);
      await handleProfilePublish({ expectedRevision: 1 }, ctx);
      await handleProfileUnpublish({ expectedRevision: 1 }, ctx);
      await ensureDefaultProfile(OWNER.uid, ctx);
      expect(ctx.profiles.published({ space: true })).toBeNull();
      expect(handleProfileGet(ctx).profile).toMatchObject({ revision: 2, draft: { contactPolicy: "invitation" } });
    });
  });

  it("keeps a draft saved before the default private and leaves an owner-published profile alone", async () => {
    await runWithRealKernelSql(async (sql, storage) => {
      const ctx = profileContext(storage, sql);
      handleProfileUpdate({ expectedRevision: 0, draft: { ...DRAFT, contactPolicy: "closed" } }, ctx);
      await ensureDefaultProfile(OWNER.uid, ctx);
      expect(ctx.profiles.published({ space: true })).toBeNull();
      expect(handleProfileGet(ctx).profile).toMatchObject({ revision: 1, draft: { about: DRAFT.about, contactPolicy: "closed" } });
    });
    await runWithRealKernelSql(async (sql, storage) => {
      const ctx = profileContext(storage, sql);
      handleProfileUpdate({ expectedRevision: 0, draft: { ...DRAFT, contactPolicy: "invitation" } }, ctx);
      await handleProfilePublish({ expectedRevision: 1 }, ctx);
      await ensureDefaultProfile(OWNER.uid, ctx);
      expect(ctx.profiles.published({ space: true })!.profile).toMatchObject({ contactPolicy: "invitation", revision: 1 });
    });
  });

  it("offers an open default draft and publishes only the exact approved snapshot across later draft edits", async () => {
    await runWithRealKernelSql(async (_sql, storage) => {
      const ctx = profileContext(storage);
      expect(handleProfileGet(ctx).profile).toMatchObject({ revision: 0, draft: { contactPolicy: "requests" } });
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

function profileContext(storage: DurableObjectStorage, sql?: SqlStorage): KernelContext {
  const context = {
    ...(sql ? { config: new ConfigStore(sql) } : undefined),
    installationIdentity: { installationId: `inst_${crypto.randomUUID()}`, canonicalOrigin: "https://local.example", handle: "local" },
    peer: testPeer({ kind: "human", account: OWNER, calls: ["profile.*"] }), callerOwnerUid: OWNER.uid, connection: {},
    profiles: new ProfileStore(storage), federation: new FederationStore(storage), federationIdentity: new FederationIdentity(storage),
    env: { STORAGE: createInstallationStorage(env.STORAGE, `inst_${crypto.randomUUID()}`) },
    auth: { getPasswdByUid: () => OWNER, getShadowByUsername: () => ({ hash: "unlocked" }), isPersonalAgentUid: () => false },
    broadcastToUserUid: vi.fn(),
  };
  // SAFETY: profile handlers use the real stores and the explicit account, storage and notification callbacks above.
  return context as KernelContext;
}
