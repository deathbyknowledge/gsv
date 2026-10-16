import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type { ConnectedPeer, ConnectArgs, WireRequestFrame } from "@humansandmachines/gsv/protocol";
import { makeShadowEntry } from "../auth/shadow";
import { createInstallationStorage } from "../installation/storage";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import { AuthStore } from "./auth-store";
import { CapabilityStore } from "./capabilities";
import { handleConnect } from "./connect";
import { KernelConnection, type KernelConnectionState } from "./connection";
import { connectionCredentialIsCurrent } from "./connection-authority";
import { ConnectionRuntime } from "./connection-runtime";
import type { KernelContext } from "./context";
import { connectedPeerContext, processPeerContext } from "./peer";
import { handleSiteAuthorize } from "./site-authorization";
import { SiteStore } from "./site-store";
import { Transport } from "./transport";
import { Kernel } from "./do";

const OWNER = { uid: 1000, gid: 1000, gids: [1000, 100], username: "owner", home: "/home/owner", cwd: "/home/owner" };
const GATEWAY_ORIGIN = "https://owner.spaces.test";

type TestAttachment = { version: 1; id: string; uri: string; origin: string | null; state: KernelConnectionState };
type TestSocket = WebSocket & { send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };

function socket() {
  let attachment: TestAttachment | undefined;
  const result = {
    send: vi.fn(), close: vi.fn(),
    serializeAttachment: vi.fn((value: TestAttachment) => { attachment = value; }),
    deserializeAttachment: () => attachment,
  };
  // SAFETY: KernelConnection and rehydration only use these four socket operations.
  return result as TestSocket;
}

async function fixture(sql: SqlStorage) {
  let runtime: ConnectionRuntime;
  const auth = new AuthStore(sql, tokenId => runtime?.invalidateTokenConnections(tokenId));
  await auth.bootstrap();
  auth.addUser({ ...OWNER, gecos: "", shell: "/bin/init" });
  auth.addGroup({ gid: 1000, name: "owner", members: [] });
  auth.updateGroupMembers("users", ["owner"]);
  auth.setShadow(makeShadowEntry("owner", "test-password-hash"));
  const caps = new CapabilityStore(sql);
  caps.seed();
  const sites = new SiteStore(sql);
  const reserved = sites.reserve(OWNER.uid, "dashboard");
  const siteOrigin = `https://${reserved.id}.usercontent.test`;
  sites.bindOrigin(reserved.id, siteOrigin);
  const installationId = `inst_${crypto.randomUUID()}`;
  const peer: ConnectedPeer = { id: "owner-ui", sessionId: "owner-session", principal: { kind: "human", account: OWNER }, grant: { calls: ["*"], signals: [], implements: [] } };
  const ownerSocket = socket();
  const connection = new KernelConnection<KernelConnectionState>(ownerSocket, peer.sessionId, `${GATEWAY_ORIGIN}/ws`, {
    step: "connected", protocol: 4, peer, credentialMethod: "password", credentialEpoch: 0,
  }, GATEWAY_ORIGIN);
  const targets = { register: vi.fn(), get: vi.fn(), listOnline: () => [] };
  // SAFETY: These handlers use the real stores and the explicit connection, storage and target collaborators below.
  const ctx = {
    installationId, installationIdentity: { installationId, canonicalOrigin: GATEWAY_ORIGIN, handle: "owner" },
    auth, caps, sites, connection, peer: connectedPeerContext({ installationId, peer, credential: "password" }),
    targets, serverVersion: "test", env: { STORAGE: createInstallationStorage(env.STORAGE, installationId) },
  } as KernelContext;
  const host = {
    installationId, auth, caps, targets, connections: new Map<string, KernelConnection<KernelConnectionState>>(),
    ctx: { getWebSockets: (): TestSocket[] => [] },
    transport: {
      closeFrameBodyChannel: vi.fn(), activeRequests: new Map(), cancelRequest: vi.fn(),
      failRoutesForConnection: vi.fn(), sendOk: vi.fn(), sendError: vi.fn(),
    },
    runRoutes: { clearForConnection: vi.fn() },
    schedule: vi.fn(async () => ({})), buildContext: () => ctx,
    procs: { list: vi.fn(() => []) }, conversations: { ensureShip: vi.fn() },
    onboarding: { managedWorkGate: async () => ({ allowed: true }) },
  };
  // SAFETY: The fixture supplies each credential, connection and cleanup collaborator exercised by this runtime.
  runtime = new ConnectionRuntime(host as never);
  Object.assign(host, { connectionRuntime: runtime });
  const grant = () => handleSiteAuthorize({ siteId: reserved.id }, ctx);
  const app = (tokenId: string) => {
    const authority = auth.tokenAuthority(tokenId, OWNER.uid, { installationId, origin: siteOrigin })!;
    const appPeer: ConnectedPeer = { ...peer, id: "dashboard", sessionId: crypto.randomUUID(), grant: { calls: [...authority.ceiling!.calls], signals: [...authority.ceiling!.signals], implements: [] } };
    const appSocket = socket();
    const appConnection = new KernelConnection<KernelConnectionState>(appSocket, appPeer.sessionId, `${GATEWAY_ORIGIN}/ws`, { step: "pending" }, siteOrigin);
    runtime.onConnect(appConnection);
    runtime.activateConnection(appConnection, { step: "connected", protocol: 4, peer: appPeer, credentialMethod: "token", credentialEpoch: 0, token: authority });
    return { appConnection, appSocket };
  };
  return { ctx, auth, sites, siteId: reserved.id, siteOrigin, host, runtime, grant, app, ownerSocket };
}

describe("published-site credential ceiling", () => {
  it("issues only the fixed profile and authenticates only the exact owned site audience", async () => {
    await runWithRealKernelSql(async sql => {
      const f = await fixture(sql);
      const before = Date.now();
      const issued = await f.grant();
      expect(issued).toMatchObject({ installationId: f.ctx.installationId, siteId: f.siteId, siteOrigin: f.siteOrigin, gatewayOrigin: GATEWAY_ORIGIN, calls: ["r12y.list", "r12y.get"], signals: ["r12y.changed"] });
      expect(issued.expiresAtMs).toBeGreaterThanOrEqual(before + 3_600_000);
      expect(issued.expiresAtMs).toBeLessThanOrEqual(Date.now() + 3_600_000);
      expect(sql.exec<{ token_hash: string }>("SELECT token_hash FROM auth_tokens WHERE token_id = ?", issued.tokenId).one().token_hash).not.toContain(issued.token);
      expect(f.auth.listTokens(OWNER.uid)).toContainEqual(expect.objectContaining({ tokenId: issued.tokenId, label: expect.stringContaining(f.siteId) }));
      const audience = { installationId: f.ctx.installationId, origin: f.siteOrigin };
      expect(await f.auth.authenticatePeerToken("owner", issued.token, audience)).toMatchObject({ ok: true, kind: "human" });
      for (const invalid of [undefined, { ...audience, origin: null }, { ...audience, origin: "null" }, { ...audience, origin: GATEWAY_ORIGIN }, { ...audience, origin: `${f.siteOrigin}.evil.test` }, { ...audience, installationId: "inst_other" }]) {
        expect(await f.auth.authenticatePeerToken("owner", issued.token, invalid)).toMatchObject({ ok: false });
      }
      expect(await f.auth.authenticateToken("owner", issued.token, { kind: "human" })).toMatchObject({ ok: false });
      sql.exec("UPDATE sites SET owner_uid = 2000 WHERE id = ?", f.siteId);
      expect(await f.auth.authenticatePeerToken("owner", issued.token, audience)).toMatchObject({ ok: false });
    });
  });

  it("requires direct, unscoped owner consent on the canonical trusted origin", async () => {
    await runWithRealKernelSql(async sql => {
      const f = await fixture(sql);
      const original = f.ctx.connection!;
      const scoped = f.app((await f.grant()).tokenId).appConnection;
      const badConnection = (origin: string | null, uri = original.uri) => new KernelConnection(original.socket, original.id, uri, original.state, origin);
      const invalid: KernelContext[] = [
        { ...f.ctx, connection: null },
        { ...f.ctx, processId: "proc:worker", peer: processPeerContext({ installationId: f.ctx.installationId, processId: "proc:worker", identity: OWNER, calls: ["*"] }) },
        { ...f.ctx, connection: scoped, peer: connectedPeerContext({ installationId: f.ctx.installationId, peer: scoped.state.peer!, credential: "token" }) },
        { ...f.ctx, connection: badConnection(null) }, { ...f.ctx, connection: badConnection("null") },
        { ...f.ctx, connection: badConnection(f.siteOrigin) },
        { ...f.ctx, connection: badConnection(GATEWAY_ORIGIN, "https://alias.spaces.test/ws") },
        { ...f.ctx, peer: { ...f.ctx.peer!, provenance: { kind: "adapter-link", serviceId: "test", accountId: "a", actorId: "a", surface: { kind: "dm", id: "dm:test" } } } },
      ];
      for (const ctx of invalid) await expect(handleSiteAuthorize({ siteId: f.siteId }, ctx)).rejects.toThrow();
      original.setState({ ...original.state, peer: { ...original.state.peer!, principal: { kind: "human", account: { ...OWNER, uid: 0 } } } });
      await expect(f.grant()).rejects.toThrow("Only the publishing human");
      expect(f.auth.listTokens(OWNER.uid)).toHaveLength(1);
    });
  });

  it("rechecks the consenting credential after hashing before storing a grant", async () => {
    await runWithRealKernelSql(async sql => {
      const f = await fixture(sql);
      const issuer = await f.auth.issueToken({ uid: OWNER.uid, kind: "human", expiresAt: Date.now() + 20_000 });
      f.ctx.connection!.setState({ ...f.ctx.connection!.state, credentialMethod: "token", token: f.auth.tokenAuthority(issuer.tokenId, OWNER.uid)! });
      const prepare = f.auth.prepareToken.bind(f.auth);
      const spy = vi.spyOn(f.auth, "prepareToken").mockImplementationOnce(async input => {
        const prepared = await prepare(input);
        f.auth.revokeToken(issuer.tokenId);
        return prepared;
      });
      await expect(f.grant()).rejects.toThrow("trusted installation UI");
      expect(f.auth.listTokens(OWNER.uid)).toHaveLength(1);
      spy.mockRestore();
    });
  });

  it("connects as the owner with the ceiling and cannot register target implementations", async () => {
    await runWithRealKernelSql(async sql => {
      const f = await fixture(sql);
      const issued = await f.grant();
      const appConnection = new KernelConnection<KernelConnectionState>(socket(), "app", `${GATEWAY_ORIGIN}/ws`, { step: "pending" }, f.siteOrigin);
      f.ctx.connection = appConnection;
      const args: ConnectArgs = { protocol: 4, peer: { id: "app", platform: "web", version: "test" }, auth: { token: issued.token } };
      const outcome = await handleConnect(args, f.ctx);
      expect(outcome).toMatchObject({ ok: true, peer: { principal: { kind: "human", account: { uid: OWNER.uid } }, grant: { calls: ["r12y.list", "r12y.get"], signals: ["r12y.changed"], implements: [] } } });
      expect(await handleConnect({ ...args, peer: { ...args.peer, implements: ["shell.*"] } }, f.ctx)).toMatchObject({ ok: false, code: 403 });
      expect(f.ctx.targets.register).not.toHaveBeenCalled();
      await f.runtime.handleSysConnect(appConnection, { type: "req", id: "connect", call: "sys.connect", args });
      expect(f.host.transport.sendOk).toHaveBeenCalled();
      expect(f.host.procs.list).not.toHaveBeenCalled();
      expect(f.host.conversations.ensureShip).not.toHaveBeenCalled();
      expect(f.host.schedule).toHaveBeenCalledWith(expect.any(Date), "onCredentialExpiry", issued.tokenId, { idempotent: true });
    });
  });

  it("fences pre-authentication exceptions and ignores unsolicited provider or activity frames", async () => {
    await runWithRealKernelSql(async sql => {
      const f = await fixture(sql);
      const { appConnection } = f.app((await f.grant()).tokenId);
      // SAFETY: The scoped ingress paths use the fixture's credential, routing, and onboarding collaborators.
      const transport = new Transport(f.host as never);
      const error = vi.spyOn(transport, "sendError").mockImplementation(() => undefined);
      for (const call of ["sys.token.create", "proc.spawn", "shell.exec", "site.authorize", "sys.setup", "sys.setup.assist", "sys.pair.redeem", "account.recovery.redeem", "account.recovery.code.start"]) {
        // SAFETY: Deliberately incomplete syscall arguments prove the ceiling rejects before any handler can use them.
        await transport.handleReq(appConnection, { type: "req", id: call, call, args: {} } as WireRequestFrame);
        expect(error).toHaveBeenLastCalledWith(appConnection, call, 403, expect.stringContaining("Site credential"));
      }
      const signals = vi.spyOn(transport, "handleSig");
      const responses = vi.spyOn(transport, "handleRes");
      for (const frame of [{ type: "sig", signal: "client.activity" }, { type: "sig", signal: "exec.status", payload: {} }, { type: "res", id: "someone-else", ok: true, data: {} }]) {
        await transport.onMessage(appConnection, JSON.stringify(frame));
      }
      expect(signals).not.toHaveBeenCalled();
      expect(responses).not.toHaveBeenCalled();
      Object.assign(f.host, { routes: { get: () => null } });
      const own = transport.registerActiveRequest({ type: "connection", id: appConnection.id }, "own-read");
      const other = transport.registerActiveRequest({ type: "connection", id: "owner-session" }, "owner-request");
      for (const id of ["owner-request", "own-read"]) {
        await transport.onMessage(appConnection, JSON.stringify({ type: "sig", signal: "request.cancel", payload: { id } }));
      }
      expect(own.signal.aborted).toBe(true);
      expect(other.signal.aborted).toBe(false);
    });
  });

  it.each(["revoke", "expire"] as const)("stops live and hibernated signals when a token is %s", async mode => {
    await runWithRealKernelSql(async sql => {
      const f = await fixture(sql);
      const issued = await f.grant();
      const live = f.app(issued.tokenId);
      const sleeping = f.app(issued.tokenId);
      f.host.connections.delete(sleeping.appConnection.id);
      f.runtime.broadcastToUserUid(OWNER.uid, "r12y.changed");
      expect(live.appSocket.send).toHaveBeenCalledOnce();
      f.runtime.broadcastToUserUid(2000, "r12y.changed");
      f.runtime.broadcastToUserUid(OWNER.uid, "proc.changed");
      expect(live.appSocket.send).toHaveBeenCalledOnce();
      if (mode === "revoke") f.auth.revokeToken(issued.tokenId);
      else sql.exec("UPDATE auth_tokens SET expires_at = ? WHERE token_id = ?", Date.now() - 1, issued.tokenId);
      f.runtime.broadcastToUserUid(OWNER.uid, "r12y.changed");
      expect(live.appSocket.send).toHaveBeenCalledOnce();
      expect(live.appSocket.close).toHaveBeenCalled();
      expect(f.host.transport.closeFrameBodyChannel).toHaveBeenCalledWith(live.appConnection.id);
      f.host.ctx.getWebSockets = () => [sleeping.appSocket];
      f.runtime.rehydrateConnections();
      expect(sleeping.appSocket.close).toHaveBeenCalledWith(1008, expect.stringContaining("Credentials"));
      expect(sleeping.appSocket.send).not.toHaveBeenCalled();
    });
  });

  it("fails closed on malformed ceilings and stale or widened attachment grants", async () => {
    await runWithRealKernelSql(async sql => {
      const f = await fixture(sql);
      const issued = await f.grant();
      const { appConnection } = f.app(issued.tokenId);
      appConnection.setState({ ...appConnection.state, peer: { ...appConnection.state.peer!, grant: { ...appConnection.state.peer!.grant, calls: ["*"] } } });
      expect(connectionCredentialIsCurrent(appConnection, f.auth, f.ctx.caps, f.ctx.installationId)).toBe(false);
      sql.exec("UPDATE auth_tokens SET ceiling = ? WHERE token_id = ?", '{"kind":"site","calls":["*"]}', issued.tokenId);
      expect(await f.auth.authenticatePeerToken("owner", issued.token, { installationId: f.ctx.installationId, origin: f.siteOrigin })).toMatchObject({ ok: false });
    });
  });

  it("closes an idle app socket from the durable token-expiry task", async () => {
    await runWithRealKernelSql(async sql => {
      const f = await fixture(sql);
      const issued = await f.grant();
      const { appSocket } = f.app(issued.tokenId);
      const now = vi.spyOn(Date, "now").mockReturnValue(issued.expiresAtMs);
      try {
        // SAFETY: This callback uses only the fixture's connectionRuntime.
        await Kernel.prototype.runScheduledTask.call(f.host as never, {
          id: "expiry", callback: "onCredentialExpiry", payload: issued.tokenId, type: "scheduled", time: Math.ceil(issued.expiresAtMs / 1000),
        });
        expect(appSocket.close).toHaveBeenCalledWith(1008, expect.stringContaining("expired"));
        expect(appSocket.send).not.toHaveBeenCalled();
      } finally { now.mockRestore(); }
    });
  });

  it("restores a valid app socket with its exact origin and closes it if the owner loses read authority", async () => {
    await runWithRealKernelSql(async sql => {
      const f = await fixture(sql);
      const { appConnection, appSocket } = f.app((await f.grant()).tokenId);
      f.host.connections.clear();
      f.host.ctx.getWebSockets = () => [appSocket];
      f.runtime.rehydrateConnections();
      expect(f.host.connections.get(appConnection.id)?.origin).toBe(f.siteOrigin);
      f.runtime.broadcastToUserUid(OWNER.uid, "r12y.changed");
      expect(appSocket.send).toHaveBeenCalledOnce();
      sql.exec("DELETE FROM group_capabilities WHERE gid = 100 AND capability = 'r12y.*'");
      f.runtime.broadcastToUserUid(OWNER.uid, "r12y.changed");
      expect(appSocket.send).toHaveBeenCalledOnce();
      expect(appSocket.close).toHaveBeenCalled();
    });
  });

  it("preserves ordinary human and machine token authority while enforcing live revocation", async () => {
    await runWithRealKernelSql(async sql => {
      const f = await fixture(sql);
      const human = await f.auth.issueToken({ uid: OWNER.uid, kind: "human" });
      const machine = await f.auth.issueToken({ uid: OWNER.uid, kind: "machine", peerId: "laptop" });
      expect(await f.auth.authenticateToken("owner", human.token)).toMatchObject({ ok: true });
      expect(await f.auth.authenticateToken("owner", machine.token, { kind: "machine", peerId: "laptop" })).toMatchObject({ ok: true });
      const connection = f.ctx.connection!;
      const token = f.auth.tokenAuthority(human.tokenId, OWNER.uid)!;
      connection.setState({ ...connection.state, credentialMethod: "token", token });
      expect(connectionCredentialIsCurrent(connection, f.auth, f.ctx.caps, f.ctx.installationId)).toBe(true);
      f.auth.revokeToken(human.tokenId);
      expect(connectionCredentialIsCurrent(connection, f.auth, f.ctx.caps, f.ctx.installationId)).toBe(false);
      expect(await f.auth.authenticatePeerToken("owner", machine.token)).toMatchObject({ ok: true, peerId: "laptop" });
    });
  });
});
