import { describe, expect, it, vi } from "vitest";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import { AuthStore } from "./auth-store";
import { AccountRecoveryStore, sha256 } from "./account-recovery";
import { hashPassword, makeShadowEntry } from "../auth/shadow";

async function fixture(work: (recovery: AccountRecoveryStore, auth: AuthStore, sql: SqlStorage) => Promise<void>) {
  await runWithRealKernelSql(async (sql, storage) => {
    const auth = new AuthStore(sql);
    await auth.bootstrap();
    auth.setShadow(makeShadowEntry("root", await hashPassword("old-root-password")));
    auth.addUser({ uid: 1000, gid: 1000, username: "human", home: "/home/human", gecos: "", shell: "/bin/init" });
    auth.setShadow(makeShadowEntry("human", await hashPassword("human-password")));
    await work(new AccountRecoveryStore(storage, auth, "installation_one"), auth, sql);
  });
}

async function grant(recovery: AccountRecoveryStore) {
  const secret = `${crypto.randomUUID()}${crypto.randomUUID()}`;
  const input = { installationId: "installation_one", attemptId: crypto.randomUUID(), purpose: "root-password-reset" as const,
    secretHash: await sha256(secret), expiresAt: Date.now() + 300_000 };
  recovery.authorize(input);
  return { input, request: { id: input.attemptId, secret, proof: `${crypto.randomUUID()}${crypto.randomUUID()}`, password: "new-root-password" } };
}

describe("Accounts-authorized Kernel root recovery", () => {
  it("atomically changes root, revokes root credentials, and preserves the ordinary human across replay", async () => {
    await fixture(async (recovery, auth, sql) => {
      const rootToken = await auth.issueToken({ uid: 0, kind: "human" });
      const humanToken = await auth.issueToken({ uid: 1000, kind: "human" });
      const { input, request } = await grant(recovery);
      recovery.authorize(input);
      expect(await recovery.redeem(request)).toEqual({ username: "root" });
      expect(await auth.authenticate("root", "old-root-password")).toMatchObject({ ok: false });
      expect(await auth.authenticateToken("root", rootToken.token)).toMatchObject({ ok: false });
      expect(await auth.authenticate("root", request.password)).toMatchObject({ ok: true });
      expect(await auth.authenticate("human", "human-password")).toMatchObject({ ok: true });
      expect(await auth.authenticateToken("human", humanToken.token)).toMatchObject({ ok: true });
      expect(auth.credentialEpoch(0)).toBe(1);
      expect(auth.credentialEpoch(1000)).toBe(0);
      auth.setShadow(makeShadowEntry("root", await hashPassword("later-root-password")));
      expect(await recovery.redeem(request)).toEqual({ username: "root" });
      expect(await auth.authenticate("root", "later-root-password")).toMatchObject({ ok: true });
      expect(auth.credentialEpoch(0)).toBe(1);
      expect(JSON.stringify(sql.exec("SELECT * FROM account_recovery_claims").toArray())).not.toContain(request.secret);
      expect(JSON.stringify(sql.exec("SELECT * FROM account_recovery_claims").toArray())).not.toContain(request.password);
      await expect(recovery.redeem({ ...request, proof: `${crypto.randomUUID()}${crypto.randomUUID()}` })).rejects.toThrow("already used");
    });
  });

  it("lets the verified owner recover locked root while preserving the existing human", async () => {
    await fixture(async (recovery, auth) => {
      auth.setShadow(makeShadowEntry("root", "!"));
      const { request } = await grant(recovery);
      expect(await recovery.redeem(request)).toEqual({ username: "root" });
      expect(await auth.authenticate("root", request.password)).toMatchObject({ ok: true });
      expect(await auth.authenticate("human", "human-password")).toMatchObject({ ok: true });
    });
  });

  it("allows exactly one concurrent receiver and fences every older outstanding claim", async () => {
    await fixture(async (recovery, auth) => {
      const first = await grant(recovery);
      const older = await grant(recovery);
      const results = await Promise.allSettled([recovery.redeem(first.request), recovery.redeem({ ...first.request, password: "different-password" })]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(auth.credentialEpoch(0)).toBe(1);
      await expect(recovery.redeem(older.request)).rejects.toThrow("superseded");
    });
  });

  it("rejects wrong installation, altered authorization, missing proof and expired claims", async () => {
    await fixture(async (recovery) => {
      const { input, request } = await grant(recovery);
      expect(() => recovery.authorize({ ...input, installationId: "installation_other" })).toThrow("invalid");
      expect(() => recovery.authorize({ ...input, expiresAt: input.expiresAt + 1 })).toThrow("already exists");
      await expect(recovery.redeem({ ...request, secret: `${crypto.randomUUID()}${crypto.randomUUID()}` })).rejects.toThrow("unavailable");
      const clock = vi.spyOn(Date, "now").mockReturnValue(input.expiresAt);
      try { await expect(recovery.redeem(request)).rejects.toThrow("expired"); }
      finally { clock.mockRestore(); }
    });
  });

  it("rolls back password and epoch when receipt commit fails", async () => {
    await fixture(async (recovery, auth) => {
      const { request } = await grant(recovery);
      const original = auth.invalidateCredentials.bind(auth);
      const failure = vi.spyOn(auth, "invalidateCredentials").mockImplementationOnce((...args) => { original(...args); throw new Error("injected failure"); });
      await expect(recovery.redeem(request)).rejects.toThrow("injected failure");
      failure.mockRestore();
      expect(auth.credentialEpoch(0)).toBe(0);
      expect(await auth.authenticate("root", "old-root-password")).toMatchObject({ ok: true });
      expect(await recovery.redeem(request)).toEqual({ username: "root" });
    });
  });

  it("fences root-link proofs after credential rotation and preserves existing identities without migration rewrites", async () => {
    await fixture(async (recovery, auth) => {
      const id = crypto.randomUUID();
      recovery.beginOwnerLink(id, "proof-hash", 0);
      recovery.confirmOwnerLink(id);
      auth.invalidateCredentials(0, "root password reset");
      expect(() => recovery.confirmOwnerLink(id)).toThrow("revoked");
      expect(() => recovery.beginOwnerLink(id, "proof-hash", 0)).toThrow("changed");
      expect(auth.getPasswdByUid(1000)?.username).toBe("human");
    });
  });

  it("refuses a credential prepared before recovery instead of granting it after the reset", async () => {
    await fixture(async (recovery, auth) => {
      const pending = await auth.prepareToken({ uid: 0, kind: "human" });
      const retained = await auth.prepareToken({ uid: 1000, kind: "human" });
      const { request } = await grant(recovery);
      await recovery.redeem(request);
      expect(() => auth.storePreparedToken(pending)).toThrow("revoked");
      expect(auth.storePreparedToken(retained).uid).toBe(1000);
      expect(auth.listTokens(0)).toHaveLength(0);
    });
  });
});
