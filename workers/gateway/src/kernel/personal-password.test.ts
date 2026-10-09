import { describe, expect, it, vi } from "vitest";
import { hashPassword, makeShadowEntry } from "../auth/shadow";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import { testPeer } from "../test-support/peers";
import { AuthStore } from "./auth-store";
import { CapabilityStore } from "./capabilities";
import type { KernelContext } from "./context";
import { AccountRecoveryStore } from "./account-recovery";
import { IdentityLinkStore } from "./identity-links";
import { assertAdapterMessageDestinationAccess } from "./adapter-destinations";
import { AdapterStatusStore } from "./adapter-status";
import { handleAdapterPairConfirm, handleAdapterPairDisconnect } from "./adapter-pairing";
import type { AdapterPairingWorkerInterface, AdapterServiceDescriptor } from "../adapter-interface";
import { activateAdapterPairing, disconnectAdapterPeer, finalizeAdapterPairing, prepareAdapterPairing, type AdapterPeerLink } from "../../../adapters/shared/src/pairing-route";

async function fixture(work: (recovery: AccountRecoveryStore, ctx: KernelContext, sql: SqlStorage, storage: DurableObjectStorage) => Promise<void>) {
  await runWithRealKernelSql(async (sql, storage) => {
    const auth = new AuthStore(sql);
    await auth.bootstrap();
    auth.setShadow(makeShadowEntry("root", await hashPassword("root-password")));
    auth.addUser({ username: "friend", uid: 1000, gid: 1000, home: "/home/friend", shell: "/bin/init", gecos: "Friend" });
    auth.addGroup({ name: "friend", gid: 1000, members: [] });
    auth.setShadow(makeShadowEntry("friend", await hashPassword("friend-password")));
    const recovery = new AccountRecoveryStore(storage, auth, "installation_people");
    // SAFETY: the people owner uses only the auth/capability stores, home bucket and session invalidator below.
    // Pairing additionally uses the real adapter stores, disabled responsibility sources and status callback.
    const ctx = { auth, accountRecovery: recovery, caps: new CapabilityStore(sql), env: { STORAGE: { head: vi.fn(async () => null), put: vi.fn(async () => null) } },
      installationId: "installation_people", installationIdentity: { canonicalOrigin: "https://people.example.test" },
      connection: null, peer: testPeer({ account: { uid: 0, gid: 0, gids: [0], username: "root", home: "/root", cwd: "/root" }, calls: ["*"] }),
      invalidateAccountConnections: vi.fn(), broadcastToUserUid: vi.fn(),
      responsibilitySources: { isEnabled: () => false }, responsibilities: { listActiveByDedupeKeyPrefix: () => [] },
      adapters: { identityLinks: new IdentityLinkStore(sql), status: new AdapterStatusStore(sql), surfaceRoutes: { get: () => null } },
    } as KernelContext;
    await work(recovery, ctx, sql);
  });
}

/** Exercise the adapter's real exclusive-route transitions, with only the RPC carrier replaced. */
function pairedMessenger(ctx: KernelContext, uid: number, initiallyPaired = true) {
  const code = "ABCDEFGHJKLM";
  const candidate = { accountId: "managed", actorId: "actor", surfaceId: "actor", expiresAt: Date.now() + 60_000, linked: false };
  const oldRoute = { installationId: ctx.installationId, localUid: uid, generation: "old-generation", canonicalOrigin: "https://people.example.test", linkedAt: Date.now() };
  let state: AdapterPeerLink = { activeRoute: initiallyPaired ? oldRoute : undefined, pairing: { claimId: "claim", code, expiresAt: candidate.expiresAt, status: "pending" } };
  let generation = 0;
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
      const route = { ...oldRoute, localUid: input.localUid, generation: ++generation === 1 ? "new-generation" : `new-generation-${generation}` };
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

describe("personal password reset and messenger recovery", () => {
  it("resets personal credentials while retaining the account, home and root access", async () => {
    await fixture(async (recovery, ctx) => {
      const human = ctx.auth.getHumanAccount()!;
      const token = await ctx.auth.issueToken({ uid: human.uid, kind: "human" });
      const prepared = await ctx.auth.prepareToken({ uid: human.uid, kind: "human" });
      ctx.adapters.identityLinks.link("telegram", "managed", "actor", human.uid, human.uid, { surfaceKind: "dm", surfaceId: "actor" });
      await recovery.resetPersonalPassword({ password: "reset-password" }, ctx);
      expect(ctx.auth.getHumanAccount()).toEqual(human);
      expect(ctx.auth.getGroupByGid(human.gid)).not.toBeNull();
      expect(await ctx.auth.authenticateToken(human.username, token.token)).toMatchObject({ ok: false });
      expect(() => ctx.auth.storePreparedToken(prepared)).toThrow("revoked");
      expect(await ctx.auth.authenticate(human.username, "reset-password")).toMatchObject({ ok: true });
      expect(await ctx.auth.authenticate("root", "root-password")).toMatchObject({ ok: true });
      expect(() => assertAdapterMessageDestinationAccess({ adapter: "telegram", accountId: "managed", actorId: "actor", surface: { kind: "dm", id: "actor" } }, human.uid, ctx)).toThrow("not authorized");
      expect(ctx.invalidateAccountConnections).toHaveBeenCalledWith(human.uid);
    });
  });

  it("requires current direct root authority before and after password hashing", async () => {
    await fixture(async (recovery, ctx) => {
      await expect(recovery.resetPersonalPassword({ password: "new-password" }, directMember(ctx, 1000))).rejects.toThrow("signed-in root human");
      await expect(recovery.resetPersonalPassword({ uid: 1001, password: "new-password" }, ctx)).rejects.toThrow("unavailable");
      const pending = recovery.resetPersonalPassword({ password: "new-password" }, ctx);
      ctx.auth.invalidateCredentials(0, "root reset during hash");
      await expect(pending).rejects.toThrow("credentials changed");
      ctx.peer!.provenance = { kind: "process-registry", processId: "proc:root-agent" };
      await expect(recovery.resetPersonalPassword({ password: "new-password" }, ctx)).rejects.toThrow("signed-in root human");
      expect(await ctx.auth.authenticate("friend", "friend-password")).toMatchObject({ ok: true });
    });
  });

  it.each(["relink", "disconnect"])("retains revoked recovery routes until %s completes exact remote cleanup", async (next) => {
    await fixture(async (recovery, ctx) => {
      const first = ctx.auth.getHumanAccount()!;
      const messenger = pairedMessenger(ctx, first.uid);
      await recovery.resetPersonalPassword({ uid: first.uid, password: "reset-password" }, ctx);
      expect(ctx.adapters.identityLinks.list(first.uid)).toEqual([]);
      expect(ctx.adapters.identityLinks.listForCleanup(first.uid)).toHaveLength(1);
      expect(messenger.route()).toMatchObject({ localUid: first.uid, generation: "old-generation" });
      if (next === "disconnect") await handleAdapterPairDisconnect({ adapter: "telegram", accountId: "managed", actorId: "actor" }, directMember(ctx, first.uid));
      if (next !== "relink") expect(ctx.adapters.identityLinks.listForCleanup(first.uid)).toEqual([]);
      expect(await handleAdapterPairConfirm({ adapter: "telegram", code: messenger.code }, directMember(ctx, first.uid))).toMatchObject({ paired: true, uid: first.uid });
      expect(messenger.service.adapterPairingDisconnect).toHaveBeenCalledExactlyOnceWith({ installationId: ctx.installationId }, expect.objectContaining({ localUid: first.uid, generation: "old-generation" }));
      expect(ctx.adapters.identityLinks.get("telegram", "managed", "actor")).toMatchObject({ uid: first.uid, metadata: { routeGeneration: "new-generation" } });
    });
  });

  it("keeps revoked cleanup identity when an authenticated successor loses the disconnect reply", async () => {
    await fixture(async (recovery, ctx, sql) => {
      const first = ctx.auth.getHumanAccount()!;
      const messenger = pairedMessenger(ctx, first.uid);
      await recovery.resetPersonalPassword({ uid: first.uid, password: "reset-password" }, ctx);
      const disconnect = messenger.service.adapterPairingDisconnect.getMockImplementation()!;
      messenger.service.adapterPairingDisconnect.mockImplementationOnce(async (...args) => { await disconnect(...args); throw new Error("lost acknowledgement"); });
      await expect(handleAdapterPairConfirm({ adapter: "telegram", code: messenger.code }, directMember(ctx, first.uid))).rejects.toThrow("lost acknowledgement");
      expect(ctx.adapters.identityLinks.get("telegram", "managed", "actor")).toBeNull();
      expect(ctx.adapters.identityLinks.listForCleanup(first.uid)).toHaveLength(1);
      const resumed = { ...ctx, adapters: { ...ctx.adapters, identityLinks: new IdentityLinkStore(sql), status: new AdapterStatusStore(sql) } };
      expect(await handleAdapterPairConfirm({ adapter: "telegram", code: messenger.code }, directMember(resumed, first.uid))).toMatchObject({ paired: true, uid: first.uid });
      expect(messenger.service.adapterPairingDisconnect.mock.calls[1]).toEqual(messenger.service.adapterPairingDisconnect.mock.calls[0]);
    });
  });

  it.each(["expired claim", "revoked caller"])("does not release a retained route with an %s", async (failure) => {
    await fixture(async (recovery, ctx) => {
      const first = ctx.auth.getHumanAccount()!;
      const messenger = pairedMessenger(ctx, first.uid);
      await recovery.resetPersonalPassword({ uid: first.uid, password: "reset-password" }, ctx);
      const inspect = messenger.service.adapterPairingInspect.getMockImplementation()!;
      messenger.service.adapterPairingInspect.mockImplementationOnce(async (...args) => {
        const candidate = await inspect(...args);
        if (failure === "revoked caller") ctx.auth.invalidateCredentials(first.uid, "caller reset during inspection");
        return failure === "expired claim" ? { ...candidate, expiresAt: 0 } : candidate;
      });
      await expect(handleAdapterPairConfirm({ adapter: "telegram", code: messenger.code }, directMember(ctx, first.uid))).rejects.toThrow(failure === "expired claim" ? "expired" : "credentials changed");
      expect(messenger.service.adapterPairingDisconnect).not.toHaveBeenCalled();
      expect(ctx.adapters.identityLinks.listForCleanup(first.uid)).toHaveLength(1);
      expect(messenger.route()).toMatchObject({ localUid: first.uid, generation: "old-generation" });
    });
  });

  it.each(["recovery", "successor"])("rejects a stale confirmation when %s commits during remote finalization", async (change) => {
    await fixture(async (recovery, ctx) => {
      const first = ctx.auth.getHumanAccount()!;
      const messenger = pairedMessenger(ctx, first.uid, false);
      const finalize = messenger.service.adapterPairingFinalize.getMockImplementation()!;
      messenger.service.adapterPairingFinalize.mockImplementationOnce(async (...args) => {
        const result = await finalize(...args);
        if (change === "recovery") await recovery.resetPersonalPassword({ uid: first.uid, password: "reset-password" }, ctx);
        if (change === "successor") {
          await handleAdapterPairDisconnect({ adapter: "telegram", accountId: "managed", actorId: "actor" }, directMember(ctx, first.uid));
          await handleAdapterPairConfirm({ adapter: "telegram", code: messenger.code }, directMember(ctx, first.uid));
        }
        return result;
      });
      await expect(handleAdapterPairConfirm({ adapter: "telegram", code: messenger.code }, directMember(ctx, first.uid))).rejects.toThrow(change === "successor" ? "changed during finalization" : "credentials changed");
      if (change === "successor") expect(ctx.adapters.status.get("telegram", "managed")).toMatchObject({ ownerUid: first.uid, authenticated: true });
      else expect(ctx.adapters.status.get("telegram", "managed")?.authenticated).not.toBe(true);
    });
  });
});
