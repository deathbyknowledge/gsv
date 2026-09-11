import { describe, expect, it, vi } from "vitest";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import { virtualPasskey } from "../test-support/virtual-passkey";
import { testPeer } from "../test-support/peers";
import { hashPassword, makeShadowEntry } from "../auth/shadow";
import { AuthStore } from "./auth-store";
import { PasskeyStore } from "./passkeys";
import type { KernelContext } from "./context";
import { AccountRecoveryStore, sha256 } from "./account-recovery";

const origin = "https://space.example.com";

async function fixture(work: (passkeys: PasskeyStore, ctx: KernelContext, storage: DurableObjectStorage) => Promise<void>) {
  await runWithRealKernelSql(async (sql, storage) => {
    const auth = new AuthStore(sql);
    await auth.bootstrap();
    auth.setShadow(makeShadowEntry("root", await hashPassword("root-password")));
    auth.addUser({ username: "person", uid: 1000, gid: 1000, gecos: "Person", home: "/home/person", shell: "/bin/init" });
    auth.setShadow(makeShadowEntry("person", await hashPassword("person-password")));
    const passkeys = new PasskeyStore(storage, auth);
    // SAFETY: passkeys read only auth, the trusted origin and the direct human principal from this context.
    const ctx = { auth, passkeys, installationId: "inst_test", installationIdentity: { installationId: "inst_test", canonicalOrigin: origin }, connection: null,
      peer: testPeer({ account: { uid: 1000, gid: 1000, gids: [1000], username: "person", home: "/home/person", cwd: "/home/person" } }),
    } as KernelContext;
    await work(passkeys, ctx, storage);
  });
}

async function register(passkeys: PasskeyStore, ctx: KernelContext) {
  const start = await passkeys.beginRegistration({ label: "Personal passkey" }, ctx);
  const authenticator = await virtualPasskey(start.options, origin);
  const request = { id: start.id, response: authenticator.registration };
  const registered = await passkeys.finishRegistration(request, ctx);
  return { authenticator, registered, request };
}

describe("Kernel passkeys", () => {
  it("verifies real registration and assertion, consumes one challenge and retains password fallback", async () => {
    await fixture(async (passkeys, ctx) => {
      const { authenticator, registered, request } = await register(passkeys, ctx);
      expect(await passkeys.finishRegistration(request, ctx)).toEqual(registered);
      expect(passkeys.list(ctx).passkeys).toEqual([registered]);
      const start = await passkeys.beginAuthentication({ username: "person" }, ctx);
      expect(start.options).toMatchObject({ rpId: "space.example.com", userVerification: "required", allowCredentials: [{ id: authenticator.id }] });
      const assertion = { id: start.id, response: await authenticator.authenticate(start.options) };
      const result = await passkeys.finishAuthentication(assertion, ctx);
      expect(result.username).toBe("person");
      expect(await ctx.auth.authenticateToken("person", result.token)).toMatchObject({ ok: true });
      expect(await ctx.auth.authenticateToken("root", result.token)).toMatchObject({ ok: false });
      expect(await ctx.auth.authenticate("person", "person-password")).toMatchObject({ ok: true });
      await expect(passkeys.finishAuthentication(assertion, ctx)).rejects.toThrow("already used");
      expect(passkeys.list(ctx).passkeys[0].lastUsedAt).not.toBeNull();
    });
  });

  it("rejects wrong origin, RP ID, user handle, missing verification, stale counter and invalid signature", async () => {
    await fixture(async (passkeys, ctx) => {
      const { authenticator } = await register(passkeys, ctx);
      for (const overrides of [{ origin: "https://attacker.example.com" }, { rpId: "attacker.example.com" }, { flags: 0x01 }, { userHandle: "b3RoZXI" }]) {
        const start = await passkeys.beginAuthentication({ username: "person" }, ctx);
        const response = await authenticator.authenticate(start.options, 1, overrides);
        await expect(passkeys.finishAuthentication({ id: start.id, response }, ctx)).rejects.toThrow();
      }
      const success = await passkeys.beginAuthentication({ username: "person" }, ctx);
      await passkeys.finishAuthentication({ id: success.id, response: await authenticator.authenticate(success.options, 2) }, ctx);
      const stale = await passkeys.beginAuthentication({ username: "person" }, ctx);
      await expect(passkeys.finishAuthentication({ id: stale.id, response: await authenticator.authenticate(stale.options, 2) }, ctx)).rejects.toThrow();
      const invalid = await passkeys.beginAuthentication({ username: "person" }, ctx);
      const response = await authenticator.authenticate(invalid.options, 3);
      response.response.signature = "AAAA";
      await expect(passkeys.finishAuthentication({ id: invalid.id, response }, ctx)).rejects.toThrow();
      expect(ctx.auth.listTokens(1000)).toHaveLength(1);
    });
  });

  it("allows one concurrent assertion and never mints a token after revocation during verification", async () => {
    await fixture(async (passkeys, ctx) => {
      const { authenticator } = await register(passkeys, ctx);
      const start = await passkeys.beginAuthentication({ username: "person" }, ctx);
      const request = { id: start.id, response: await authenticator.authenticate(start.options) };
      const results = await Promise.allSettled([passkeys.finishAuthentication(request, ctx), passkeys.finishAuthentication(request, ctx)]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(ctx.auth.listTokens(1000)).toHaveLength(1);
      const pending = await passkeys.beginAuthentication({ username: "person" }, ctx);
      const response = await authenticator.authenticate(pending.options, 2);
      const verification = passkeys.finishAuthentication({ id: pending.id, response }, ctx);
      expect(passkeys.revoke({ id: authenticator.id }, ctx)).toEqual({ revoked: true });
      await expect(verification).rejects.toThrow();
      expect(ctx.auth.listTokens(1000)).toHaveLength(1);
      expect(await ctx.auth.authenticate("person", "person-password")).toMatchObject({ ok: true });
    });
  });

  it("rejects registration by another human or Process and refuses an expired or wrong-space challenge", async () => {
    await fixture(async (passkeys, ctx, storage) => {
      const start = await passkeys.beginRegistration({ label: "My passkey" }, ctx);
      const authenticator = await virtualPasskey(start.options, origin);
      const request = { id: start.id, response: authenticator.registration };
      const root = { ...ctx, peer: testPeer({ account: { uid: 0, gid: 0, gids: [0], username: "root", home: "/root", cwd: "/root" } }) };
      await expect(passkeys.finishRegistration(request, root)).rejects.toThrow("another account");
      const otherSpace = { ...ctx, installationIdentity: { ...ctx.installationIdentity!, canonicalOrigin: "https://other.example.com" } };
      await expect(passkeys.finishRegistration(request, otherSpace)).rejects.toThrow("unavailable");
      ctx.peer!.provenance = { kind: "process-registry", processId: "proc:person" };
      await expect(passkeys.beginRegistration({ label: "Agent" }, ctx)).rejects.toThrow("signed-in human");
      ctx.peer!.provenance = { kind: "credential", method: "password" };
      storage.sql.exec("UPDATE account_passkey_challenges SET expires_at = 0 WHERE id = ?", start.id);
      await expect(passkeys.finishRegistration(request, ctx)).rejects.toThrow("expired");
      expect(passkeys.list(ctx).passkeys).toHaveLength(0);
    });
  });

  it("root recovery removes root passkeys and fences pending registration while preserving the human's passkey", async () => {
    await fixture(async (passkeys, ctx, storage) => {
      const human = await register(passkeys, ctx);
      const root = { ...ctx, peer: testPeer({ account: { uid: 0, gid: 0, gids: [0], username: "root", home: "/root", cwd: "/root" } }) };
      await register(passkeys, root);
      const pending = await passkeys.beginRegistration({ label: "Old root session" }, root);
      const pendingAuthenticator = await virtualPasskey(pending.options, origin);
      const recovery = new AccountRecoveryStore(storage, ctx.auth, ctx.installationId);
      const secret = crypto.randomUUID() + crypto.randomUUID();
      const id = crypto.randomUUID();
      recovery.authorize({ installationId: ctx.installationId, attemptId: id, purpose: "root-password-reset", secretHash: await sha256(secret), expiresAt: Date.now() + 300_000 });
      await recovery.redeem({ id, secret, proof: crypto.randomUUID() + crypto.randomUUID(), password: "new-root-password" });
      expect(passkeys.list(root).passkeys).toHaveLength(0);
      await expect(passkeys.finishRegistration({ id: pending.id, response: pendingAuthenticator.registration }, root)).rejects.toThrow("revoked");
      const signIn = await passkeys.beginAuthentication({ username: "person" }, ctx);
      const authenticated = await passkeys.finishAuthentication({ id: signIn.id, response: await human.authenticator.authenticate(signIn.options) }, ctx);
      expect(await ctx.auth.authenticateToken("person", authenticated.token)).toMatchObject({ ok: true });
      expect(await ctx.auth.authenticate("root", "new-root-password")).toMatchObject({ ok: true });
    });
  });

  it("rolls back challenge consumption and counter if token persistence fails", async () => {
    await fixture(async (passkeys, ctx) => {
      const { authenticator } = await register(passkeys, ctx);
      const start = await passkeys.beginAuthentication({ username: "person" }, ctx);
      const request = { id: start.id, response: await authenticator.authenticate(start.options) };
      vi.spyOn(ctx.auth, "storePreparedToken").mockImplementationOnce(() => { throw new Error("token store failed"); });
      await expect(passkeys.finishAuthentication(request, ctx)).rejects.toThrow("token store failed");
      expect(ctx.auth.listTokens(1000)).toHaveLength(0);
      const result = await passkeys.finishAuthentication(request, ctx);
      expect(await ctx.auth.authenticateToken("person", result.token)).toMatchObject({ ok: true });
    });
  });
});
