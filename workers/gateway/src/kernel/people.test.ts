import { describe, expect, it, vi } from "vitest";
import { createPairingSecret } from "@humansandmachines/gsv/protocol";
import { hashPassword, makeShadowEntry } from "../auth/shadow";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import { testPeer } from "../test-support/peers";
import { AuthStore } from "./auth-store";
import { CapabilityStore } from "./capabilities";
import type { KernelContext } from "./context";
import { PeopleStore } from "./people";
import { IdentityLinkStore } from "./identity-links";
import { assertAdapterMessageDestinationAccess } from "./adapter-destinations";
import { AdapterStatusStore } from "./adapter-status";
import { handleAdapterPairConfirm, handleAdapterPairDisconnect } from "./adapter-pairing";
import type { AdapterPairingWorkerInterface, AdapterServiceDescriptor } from "../adapter-interface";
import { activateAdapterPairing, disconnectAdapterPeer, finalizeAdapterPairing, prepareAdapterPairing, type AdapterPeerLink } from "../../../adapters/shared/src/pairing-route";

async function fixture(work: (people: PeopleStore, ctx: KernelContext, sql: SqlStorage, storage: DurableObjectStorage) => Promise<void>) {
  await runWithRealKernelSql(async (sql, storage) => {
    const auth = new AuthStore(sql);
    await auth.bootstrap();
    auth.setShadow(makeShadowEntry("root", await hashPassword("root-password")));
    const people = new PeopleStore(storage, auth);
    // SAFETY: the people owner uses only the auth/capability stores, home bucket and session invalidator below.
    // Pairing additionally uses the real adapter stores, disabled responsibility sources and status callback.
    const ctx = { auth, people, caps: new CapabilityStore(sql), env: { STORAGE: { head: vi.fn(async () => null), put: vi.fn(async () => null) } },
      installationId: "installation_people", installationIdentity: { canonicalOrigin: "https://people.example.test" },
      connection: null, peer: testPeer({ account: { uid: 0, gid: 0, gids: [0], username: "root", home: "/root", cwd: "/root" }, calls: ["*"] }),
      invalidateAccountConnections: vi.fn(), broadcastToUserUid: vi.fn(),
      responsibilitySources: { isEnabled: () => false }, responsibilities: { listActiveByDedupeKeyPrefix: () => [] },
      adapters: { identityLinks: new IdentityLinkStore(sql), status: new AdapterStatusStore(sql), surfaceRoutes: { get: () => null } },
    } as KernelContext;
    await work(people, ctx, sql, storage);
  });
}

/** Exercise the adapter's real exclusive-route transitions, with only the RPC carrier replaced. */
function pairedMessenger(ctx: KernelContext, uid: number, initiallyPaired = true) {
  const code = "ABCDEFGHJKLM";
  const candidate = { accountId: "managed", actorId: "actor", surfaceId: "actor", expiresAt: Date.now() + 60_000, linked: false };
  const oldRoute = { installationId: ctx.installationId, localUid: uid, generation: "old-generation", canonicalOrigin: "https://people.example.test", linkedAt: Date.now() };
  let state: AdapterPeerLink = { activeRoute: initiallyPaired ? oldRoute : undefined, pairing: { claimId: "claim", code, expiresAt: candidate.expiresAt, status: "pending" } };
  const service = {
    adapterDescribe: vi.fn(async (): Promise<AdapterServiceDescriptor> => ({ version: 1, id: "telegram", displayName: "Telegram", capabilities: {
      connect: false, disconnect: false, send: true, status: true, activity: true, pairing: true,
      surfaces: ["dm"], media: { inbound: [], outbound: [] },
    } })),
    adapterPairingInfo: vi.fn<AdapterPairingWorkerInterface["adapterPairingInfo"]>(async () => ({ accountId: "managed", configured: true })),
    adapterPairingInspect: vi.fn<AdapterPairingWorkerInterface["adapterPairingInspect"]>(async () => candidate),
    adapterPairingPrepare: vi.fn<AdapterPairingWorkerInterface["adapterPairingPrepare"]>(async (_installation, input) => {
      // Starting a fresh provider pairing does not replace its existing active route.
      state.pairing ??= { claimId: "claim", code, expiresAt: candidate.expiresAt, status: "pending" };
      const route = { ...oldRoute, localUid: input.localUid, generation: "new-generation" };
      state = prepareAdapterPairing(state, { claimId: "claim", expiresAt: candidate.expiresAt, operationId: input.operationId, route, now: Date.now() }, "telegram").state;
      return { candidate, route };
    }),
    adapterPairingActivate: vi.fn<AdapterPairingWorkerInterface["adapterPairingActivate"]>(async (_installation, input) => {
      const route = { ...oldRoute, ...input.route };
      state = activateAdapterPairing(state, { claimId: "claim", expiresAt: candidate.expiresAt, operationId: input.operationId, route }).state;
      return { candidate, route };
    }),
    adapterPairingFinalize: vi.fn<AdapterPairingWorkerInterface["adapterPairingFinalize"]>(async (_installation, input) => {
      const route = { ...oldRoute, ...input.route };
      state = finalizeAdapterPairing(state, { claimId: "claim", expiresAt: candidate.expiresAt, operationId: input.operationId, route }).state;
      return { candidate, route };
    }),
    adapterPairingDisconnect: vi.fn<AdapterPairingWorkerInterface["adapterPairingDisconnect"]>(async (_installation, input) => {
      const result = disconnectAdapterPeer(state, { operationId: input.operationId, route: { installationId: input.installationId, localUid: input.localUid, generation: input.generation } }, "telegram");
      state = result.state;
      return { disconnected: result.disconnected };
    }),
  };
  ctx.env.CHANNEL_TELEGRAM = service;
  if (initiallyPaired) ctx.adapters.identityLinks.link("telegram", "managed", "actor", uid, uid, { managed: true, surfaceKind: "dm", surfaceId: "actor", routeGeneration: oldRoute.generation });
  return { service, route: () => state.activeRoute, code };
}

function directMember(ctx: KernelContext, uid: number): KernelContext {
  const member = ctx.auth.getPasswdByUid(uid)!;
  // SAFETY: pairing only requires a non-null direct connection and this real account's credential peer.
  return { ...ctx, connection: {} as KernelContext["connection"], peer: testPeer({ account: { ...member, gids: [member.gid], cwd: member.home }, calls: ["adapter.*"] }) };
}

async function invitation(people: PeopleStore, ctx: KernelContext, username = "friend") {
  const input = { id: crypto.randomUUID(), secret: createPairingSecret(), username };
  await people.invite(input, ctx);
  return { id: input.id, secret: input.secret, proof: createPairingSecret(), password: "friend-password" };
}

describe("Kernel human invitations and removal", () => {
  it("creates one account across concurrent receivers and preserves later credentials on exact replay", async () => {
    await fixture(async (people, ctx, sql) => {
      const request = await invitation(people, ctx);
      const requests = [request, { ...request, proof: createPairingSecret() }];
      const results = await Promise.allSettled(requests.map((input) => people.redeem(input, ctx)));
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const winningIndex = results.findIndex((result) => result.status === "fulfilled");
      // Replay the persisted recipient only; the different receiver cannot claim the same receipt.
      expect(await people.redeem(requests[winningIndex], ctx)).toEqual({ uid: 1000, username: "friend" });
      expect(ctx.auth.getPasswdEntries().filter((entry) => entry.username === "friend")).toHaveLength(1);
      expect(ctx.auth.getGroupByName("users")?.members).toContain("friend");
      const stored = JSON.stringify(sql.exec("SELECT * FROM human_invitations").toArray());
      expect(stored).not.toContain(request.secret);
      expect(stored).not.toContain(request.proof);
      expect(stored).not.toContain(request.password);
      const second = await invitation(people, ctx, "another");
      const enrolled = await people.redeem(second, ctx);
      await people.setPassword({ uid: enrolled.uid, password: "later-password" }, ctx);
      expect(await people.redeem(second, ctx)).toEqual(enrolled);
      expect(await ctx.auth.authenticate("another", "later-password")).toMatchObject({ ok: true });
      await expect(people.redeem({ ...second, password: "replacement-password" }, ctx)).rejects.toThrow("already used");
    });
  });

  it("rolls back enrollment with its receipt and resumes home preparation after a lost reply", async () => {
    await fixture(async (people, ctx) => {
      const request = await invitation(people, ctx);
      const original = ctx.auth.setShadow.bind(ctx.auth);
      vi.spyOn(ctx.auth, "setShadow").mockImplementationOnce((entry) => { original(entry); throw new Error("credential write failed"); });
      await expect(people.redeem(request, ctx)).rejects.toThrow("credential write failed");
      expect(ctx.auth.getPasswdByUsername("friend")).toBeNull();
      expect(people.invitations(ctx).invitations[0].status).toBe("pending");
      vi.mocked(ctx.env.STORAGE.head).mockRejectedValueOnce(new Error("home unavailable"));
      await expect(people.redeem(request, ctx)).rejects.toThrow("home unavailable");
      expect(people.invitations(ctx).invitations[0].status).toBe("redeemed");
      expect(await people.redeem(request, ctx)).toEqual({ uid: 1000, username: "friend" });
      expect(await ctx.auth.authenticate("friend", request.password)).toMatchObject({ ok: true });
    });
  });

  it("refuses cancellation, expiry, issuer revocation, missing claims and device-purpose claims", async () => {
    await fixture(async (people, ctx, sql) => {
      const cancelled = await invitation(people, ctx, "cancelled");
      people.cancel(cancelled.id, ctx);
      await expect(people.redeem(cancelled, ctx)).rejects.toThrow("cancelled");
      const expired = await invitation(people, ctx, "expired");
      sql.exec("UPDATE human_invitations SET expires_at = 0 WHERE id = ?", expired.id);
      await expect(people.redeem(expired, ctx)).rejects.toThrow("expired");
      const revoked = await invitation(people, ctx, "revoked");
      ctx.auth.invalidateCredentials(0, "root recovered");
      await expect(people.redeem(revoked, ctx)).rejects.toThrow("cancelled");
      const deviceId = crypto.randomUUID();
      sql.exec(`INSERT INTO device_pairings (id, owner_uid, target_id, label, secret_hash, created_at, expires_at)
        VALUES (?, 0, 'device_target', 'laptop', 'secret', 0, ?)`, deviceId, Date.now() + 300_000);
      await expect(people.redeem({ ...revoked, id: deviceId }, ctx)).rejects.toThrow("unavailable");
      await expect(people.redeem({ ...revoked, id: crypto.randomUUID() }, ctx)).rejects.toThrow("unavailable");
      expect(ctx.auth.getPasswdEntries()).toHaveLength(1);
    });
  });

  it("rechecks issuer authority after password hashing and rejects Process and member administrators", async () => {
    await fixture(async (people, ctx) => {
      const request = await invitation(people, ctx);
      const pending = people.redeem(request, ctx);
      ctx.auth.invalidateCredentials(0, "root revoked during hash");
      await expect(pending).rejects.toThrow("cancelled");
      const mint = people.invite({ id: crypto.randomUUID(), secret: createPairingSecret(), username: "late" }, ctx);
      ctx.auth.invalidateCredentials(0, "root revoked during mint");
      await expect(mint).rejects.toThrow("revoked");
      ctx.peer!.provenance = { kind: "process-registry", processId: "proc:root-agent" };
      await expect(invitation(people, ctx)).rejects.toThrow("signed-in root human");
      ctx.peer = testPeer({ account: { uid: 1000, gid: 1000, gids: [1000], username: "member", home: "/home/member", cwd: "/home/member" }, calls: ["*"] });
      expect(() => people.people(ctx)).toThrow("signed-in root human");
      await expect(people.setPassword({ uid: 1001, password: "new-password" }, ctx)).rejects.toThrow("signed-in root human");
    });
  });

  it("resets and removes one member while retaining uid, group, other people and admitted work", async () => {
    await fixture(async (people, ctx) => {
      const first = await people.redeem(await invitation(people, ctx), ctx);
      const other = await people.redeem(await invitation(people, ctx, "other"), ctx);
      const firstToken = await ctx.auth.issueToken({ uid: first.uid, kind: "human" });
      const otherToken = await ctx.auth.issueToken({ uid: other.uid, kind: "human" });
      const destination = { adapter: "telegram", accountId: "managed", actorId: "actor", surface: { kind: "dm", id: "actor" } };
      ctx.adapters.identityLinks.link("telegram", "managed", "actor", first.uid, first.uid, { surfaceKind: "dm", surfaceId: "actor" });
      assertAdapterMessageDestinationAccess(destination, first.uid, ctx);
      await people.setPassword({ uid: first.uid, password: "reset-password" }, ctx);
      expect(await ctx.auth.authenticateToken("friend", firstToken.token)).toMatchObject({ ok: false });
      expect(await ctx.auth.authenticate("friend", "reset-password")).toMatchObject({ ok: true });
      expect(() => assertAdapterMessageDestinationAccess(destination, first.uid, ctx)).toThrow("not authorized");
      const prepared = await ctx.auth.prepareToken({ uid: first.uid, kind: "human" });
      await people.remove(first.uid, ctx);
      await people.remove(first.uid, ctx);
      expect(() => ctx.adapters.identityLinks.link("telegram", "managed", "actor", first.uid, 0)).toThrow("Removed accounts");
      expect(() => ctx.auth.storePreparedToken(prepared)).toThrow("revoked");
      expect(await ctx.auth.authenticate("friend", "reset-password")).toMatchObject({ ok: false });
      expect(await ctx.auth.authenticateToken("other", otherToken.token)).toMatchObject({ ok: true });
      expect(ctx.auth.getPasswdByUid(first.uid)?.username).toBe("friend");
      expect(ctx.auth.getGroupByGid(first.uid)).not.toBeNull();
      expect(ctx.auth.credentialEpoch(first.uid)).toBe(2);
      expect(ctx.invalidateAccountConnections).toHaveBeenCalledWith(first.uid);
      expect(people.people(ctx).people.find((person) => person.uid === first.uid)?.disabled).toBe(true);
      await expect(people.setPassword({ uid: 0, password: "root-overwrite" }, ctx)).rejects.toThrow();
      await expect(invitation(people, ctx)).rejects.toThrow("unavailable");
    });
  });

  it("disconnects the removed member's exclusive route before another member pairs that identity", async () => {
    await fixture(async (people, ctx) => {
      const first = await people.redeem(await invitation(people, ctx), ctx);
      const other = await people.redeem(await invitation(people, ctx, "other"), ctx);
      const messenger = pairedMessenger(ctx, first.uid);
      ctx.adapters.identityLinks.link("test", "legacy", "actor", first.uid, first.uid);
      ctx.adapters.identityLinks.link("test", "legacy", "other", other.uid, other.uid);
      const otherContext = directMember(ctx, other.uid);
      await expect(handleAdapterPairDisconnect({ adapter: "telegram", accountId: "managed", actorId: "actor" }, otherContext)).rejects.toThrow("Permission denied");
      await expect(handleAdapterPairConfirm({ adapter: "telegram", code: messenger.code }, otherContext)).rejects.toThrow("another user");
      // The adapter also rejects reassignment if only the Kernel link was removed.
      await expect(messenger.service.adapterPairingPrepare({ installationId: ctx.installationId }, { code: messenger.code, installationId: ctx.installationId, localUid: other.uid, operationId: "before-remove", canonicalOrigin: "https://people.example.test" })).rejects.toThrow("Disconnect");
      expect(await people.remove(first.uid, ctx)).toEqual({ removed: true });
      expect(messenger.route()).toBeUndefined();
      expect(ctx.adapters.identityLinks.list(first.uid)).toEqual([]);
      expect(ctx.adapters.identityLinks.list(other.uid)).toHaveLength(1);
      expect(await ctx.auth.authenticate("other", "friend-password")).toMatchObject({ ok: true });
      expect(await handleAdapterPairConfirm({ adapter: "telegram", code: messenger.code }, otherContext)).toMatchObject({ paired: true, uid: other.uid });
      expect(messenger.route()).toMatchObject({ localUid: other.uid, generation: "new-generation" });
      await people.remove(first.uid, ctx);
      expect(ctx.adapters.identityLinks.get("telegram", "managed", "actor")).toMatchObject({ uid: other.uid, metadata: { routeGeneration: "new-generation" } });
      expect(messenger.service.adapterPairingDisconnect).toHaveBeenCalledTimes(1);
    });
  });

  it.each(["before disconnect", "after committed disconnect"])("resumes removal after a failure %s without restoring access or changing the retry identity", async (failure) => {
    await fixture(async (people, ctx, sql, storage) => {
      const first = await people.redeem(await invitation(people, ctx), ctx);
      const token = await ctx.auth.issueToken({ uid: first.uid, kind: "human" });
      const messenger = pairedMessenger(ctx, first.uid);
      const disconnect = messenger.service.adapterPairingDisconnect.getMockImplementation()!;
      messenger.service.adapterPairingDisconnect.mockImplementationOnce(async (...args) => {
        expect(ctx.auth.isAccountDisabled(first.uid)).toBe(true);
        expect(ctx.invalidateAccountConnections).toHaveBeenCalledWith(first.uid);
        expect(() => assertAdapterMessageDestinationAccess({ adapter: "telegram", accountId: "managed", actorId: "actor", surface: { kind: "dm", id: "actor" } }, first.uid, ctx)).toThrow("not authorized");
        if (failure === "after committed disconnect") await disconnect(...args);
        throw new Error("adapter reply unavailable");
      });
      await expect(people.remove(first.uid, ctx)).rejects.toThrow("adapter reply unavailable");
      expect(ctx.adapters.identityLinks.list(first.uid)).toEqual([]);
      expect(ctx.adapters.identityLinks.listForCleanup(first.uid)).toHaveLength(1);
      expect(await ctx.auth.authenticateToken("friend", token.token)).toMatchObject({ ok: false });
      expect(await ctx.auth.authenticate("friend", "friend-password")).toMatchObject({ ok: false });
      const resumedAuth = new AuthStore(sql);
      const resumed = new PeopleStore(storage, resumedAuth);
      const resumedContext = { ...ctx, auth: resumedAuth, people: resumed, adapters: { ...ctx.adapters, identityLinks: new IdentityLinkStore(sql), status: new AdapterStatusStore(sql) } };
      expect(await resumed.remove(first.uid, resumedContext)).toEqual({ removed: true });
      expect(resumedContext.adapters.identityLinks.listForCleanup(first.uid)).toEqual([]);
      expect(messenger.route()).toBeUndefined();
      expect(resumedAuth.credentialEpoch(first.uid)).toBe(1);
      expect(messenger.service.adapterPairingDisconnect.mock.calls[1]).toEqual(messenger.service.adapterPairingDisconnect.mock.calls[0]);
    });
  });

  it("keeps a successor link when an older disconnect reply arrives", async () => {
    await fixture(async (people, ctx) => {
      const first = await people.redeem(await invitation(people, ctx), ctx);
      const other = await people.redeem(await invitation(people, ctx, "other"), ctx);
      const messenger = pairedMessenger(ctx, first.uid);
      const disconnect = messenger.service.adapterPairingDisconnect.getMockImplementation()!;
      messenger.service.adapterPairingDisconnect.mockImplementationOnce(async (...args) => {
        const result = await disconnect(...args);
        // A separately authorized successor was committed while the old acknowledgement was in flight.
        ctx.adapters.identityLinks.unlink("telegram", "managed", "actor");
        ctx.adapters.identityLinks.link("telegram", "managed", "actor", other.uid, other.uid, { managed: true, surfaceId: "actor", routeGeneration: "successor" });
        return result;
      });
      await people.remove(first.uid, ctx);
      expect(ctx.adapters.identityLinks.get("telegram", "managed", "actor")).toMatchObject({ uid: other.uid, metadata: { routeGeneration: "successor" } });
    });
  });

  it.each(["remove", "relink", "disconnect"])("retains revoked recovery routes until %s completes exact remote cleanup", async (next) => {
    await fixture(async (people, ctx) => {
      const first = await people.redeem(await invitation(people, ctx), ctx);
      const other = await people.redeem(await invitation(people, ctx, "other"), ctx);
      const messenger = pairedMessenger(ctx, first.uid);
      await people.setPassword({ uid: first.uid, password: "reset-password" }, ctx);
      expect(ctx.adapters.identityLinks.list(first.uid)).toEqual([]);
      expect(ctx.adapters.identityLinks.listForCleanup(first.uid)).toHaveLength(1);
      expect(messenger.route()).toMatchObject({ localUid: first.uid, generation: "old-generation" });
      if (next === "remove") await people.remove(first.uid, ctx);
      if (next === "disconnect") await handleAdapterPairDisconnect({ adapter: "telegram", accountId: "managed", actorId: "actor" }, directMember(ctx, first.uid));
      if (next !== "relink") expect(ctx.adapters.identityLinks.listForCleanup(first.uid)).toEqual([]);
      expect(await handleAdapterPairConfirm({ adapter: "telegram", code: messenger.code }, directMember(ctx, other.uid))).toMatchObject({ paired: true, uid: other.uid });
      expect(messenger.service.adapterPairingDisconnect).toHaveBeenCalledExactlyOnceWith({ installationId: ctx.installationId }, expect.objectContaining({ localUid: first.uid, generation: "old-generation" }));
      expect(ctx.adapters.identityLinks.get("telegram", "managed", "actor")).toMatchObject({ uid: other.uid, metadata: { routeGeneration: "new-generation" } });
    });
  });

  it("keeps revoked cleanup identity when an authenticated successor loses the disconnect reply", async () => {
    await fixture(async (people, ctx, sql, storage) => {
      const first = await people.redeem(await invitation(people, ctx), ctx);
      const other = await people.redeem(await invitation(people, ctx, "other"), ctx);
      const messenger = pairedMessenger(ctx, first.uid);
      await people.setPassword({ uid: first.uid, password: "reset-password" }, ctx);
      const disconnect = messenger.service.adapterPairingDisconnect.getMockImplementation()!;
      messenger.service.adapterPairingDisconnect.mockImplementationOnce(async (...args) => { await disconnect(...args); throw new Error("lost acknowledgement"); });
      await expect(handleAdapterPairConfirm({ adapter: "telegram", code: messenger.code }, directMember(ctx, other.uid))).rejects.toThrow("lost acknowledgement");
      expect(ctx.adapters.identityLinks.get("telegram", "managed", "actor")).toBeNull();
      expect(ctx.adapters.identityLinks.listForCleanup(first.uid)).toHaveLength(1);
      const resumed = { ...ctx, people: new PeopleStore(storage, ctx.auth), adapters: { ...ctx.adapters, identityLinks: new IdentityLinkStore(sql), status: new AdapterStatusStore(sql) } };
      expect(await handleAdapterPairConfirm({ adapter: "telegram", code: messenger.code }, directMember(resumed, other.uid))).toMatchObject({ paired: true, uid: other.uid });
      expect(messenger.service.adapterPairingDisconnect.mock.calls[1]).toEqual(messenger.service.adapterPairingDisconnect.mock.calls[0]);
    });
  });

  it.each(["expired claim", "revoked caller"])("does not release a retained route with an %s", async (failure) => {
    await fixture(async (people, ctx) => {
      const first = await people.redeem(await invitation(people, ctx), ctx);
      const other = await people.redeem(await invitation(people, ctx, "other"), ctx);
      const messenger = pairedMessenger(ctx, first.uid);
      await people.setPassword({ uid: first.uid, password: "reset-password" }, ctx);
      const inspect = messenger.service.adapterPairingInspect.getMockImplementation()!;
      messenger.service.adapterPairingInspect.mockImplementationOnce(async (...args) => {
        const candidate = await inspect(...args);
        if (failure === "revoked caller") ctx.auth.invalidateCredentials(other.uid, "caller reset during inspection");
        return failure === "expired claim" ? { ...candidate, expiresAt: 0 } : candidate;
      });
      await expect(handleAdapterPairConfirm({ adapter: "telegram", code: messenger.code }, directMember(ctx, other.uid))).rejects.toThrow(failure === "expired claim" ? "expired" : "credentials changed");
      expect(messenger.service.adapterPairingDisconnect).not.toHaveBeenCalled();
      expect(ctx.adapters.identityLinks.listForCleanup(first.uid)).toHaveLength(1);
      expect(messenger.route()).toMatchObject({ localUid: first.uid, generation: "old-generation" });
    });
  });

  it.each([false, true])("cancels the stored preparation when removal overtakes activation (prior active link: %s)", async (initiallyPaired) => {
    await fixture(async (people, ctx) => {
      const first = await people.redeem(await invitation(people, ctx), ctx);
      const messenger = pairedMessenger(ctx, first.uid, initiallyPaired);
      let entered!: () => void;
      let release!: () => void;
      const activating = new Promise<void>((resolve) => { entered = resolve; });
      const resume = new Promise<void>((resolve) => { release = resolve; });
      const activate = messenger.service.adapterPairingActivate.getMockImplementation()!;
      messenger.service.adapterPairingActivate.mockImplementationOnce(async (...args) => { entered(); await resume; return await activate(...args); });
      const pending = handleAdapterPairConfirm({ adapter: "telegram", code: messenger.code }, directMember(ctx, first.uid));
      await activating;
      try {
        expect(ctx.adapters.identityLinks.get("telegram", "managed", "actor")).toMatchObject({ metadata: { routeGeneration: "new-generation" } });
        await people.remove(first.uid, ctx);
      } finally { release(); }
      await expect(pending).rejects.toThrow("Pairing code is invalid");
      expect(messenger.route()).toBeUndefined();
      expect(ctx.adapters.identityLinks.listForCleanup(first.uid)).toEqual([]);
      expect(messenger.service.adapterPairingDisconnect.mock.calls.map((call) => call[1].generation)).toEqual(initiallyPaired ? ["old-generation", "new-generation"] : ["new-generation"]);
    });
  });

  it.each(["removal", "recovery", "successor"])("rejects a stale confirmation when %s commits during remote finalization", async (change) => {
    await fixture(async (people, ctx) => {
      const first = await people.redeem(await invitation(people, ctx), ctx);
      const other = await people.redeem(await invitation(people, ctx, "other"), ctx);
      const messenger = pairedMessenger(ctx, first.uid, false);
      const finalize = messenger.service.adapterPairingFinalize.getMockImplementation()!;
      messenger.service.adapterPairingFinalize.mockImplementationOnce(async (...args) => {
        const result = await finalize(...args);
        if (change === "removal") await people.remove(first.uid, ctx);
        if (change === "recovery") await people.setPassword({ uid: first.uid, password: "reset-password" }, ctx);
        if (change === "successor") {
          await handleAdapterPairDisconnect({ adapter: "telegram", accountId: "managed", actorId: "actor" }, directMember(ctx, first.uid));
          await handleAdapterPairConfirm({ adapter: "telegram", code: messenger.code }, directMember(ctx, other.uid));
        }
        return result;
      });
      await expect(handleAdapterPairConfirm({ adapter: "telegram", code: messenger.code }, directMember(ctx, first.uid))).rejects.toThrow(change === "successor" ? "changed during finalization" : "credentials changed");
      if (change === "successor") expect(ctx.adapters.status.get("telegram", "managed")).toMatchObject({ ownerUid: other.uid, authenticated: true });
      else expect(ctx.adapters.status.get("telegram", "managed")?.authenticated).not.toBe(true);
    });
  });
});
