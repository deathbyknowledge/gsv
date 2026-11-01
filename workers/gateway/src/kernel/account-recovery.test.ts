import { describe, expect, it, vi } from "vitest";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import { AuthStore } from "./auth-store";
import { AccountRecoveryStore, ownerRecoveryOptions, PersonalAccountUnavailableError, sha256 } from "./account-recovery";
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
      expect(await recovery.redeem(request)).toEqual({ username: "root", uid: 0 });
      expect(await auth.authenticate("root", "old-root-password")).toMatchObject({ ok: false });
      expect(await auth.authenticateToken("root", rootToken.token)).toMatchObject({ ok: false });
      expect(await auth.authenticate("root", request.password)).toMatchObject({ ok: true });
      expect(await auth.authenticate("human", "human-password")).toMatchObject({ ok: true });
      expect(await auth.authenticateToken("human", humanToken.token)).toMatchObject({ ok: true });
      expect(auth.credentialEpoch(0)).toBe(1);
      expect(auth.credentialEpoch(1000)).toBe(0);
      auth.setShadow(makeShadowEntry("root", await hashPassword("later-root-password")));
      expect(await recovery.redeem(request)).toEqual({ username: "root", uid: 0 });
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
      expect(await recovery.redeem(request)).toEqual({ username: "root", uid: 0 });
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
      expect(await recovery.redeem(request)).toEqual({ username: "root", uid: 0 });
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

describe("owner email resets the personal password", () => {
  const personal = (request: Awaited<ReturnType<typeof grant>>["request"]) => ({ ...request, password: "new-personal-password", account: "personal" as const });

  it("changes only the personal password, revokes its sessions and messenger links, and survives replay", async () => {
    await fixture(async (recovery, auth, sql) => {
      const humanToken = await auth.issueToken({ uid: 1000, kind: "human" });
      const rootToken = await auth.issueToken({ uid: 0, kind: "human" });
      sql.exec(`INSERT INTO identity_links (adapter, account_id, actor_id, uid, created_at, linked_by_uid, metadata_json)
        VALUES ('telegram', 'account', 'actor', 1000, ?, 1000, '{}')`, Date.now());
      const redemption = personal((await grant(recovery)).request);
      expect(await recovery.redeem(redemption)).toEqual({ username: "human", uid: 1000 });
      expect(await auth.authenticate("human", "human-password")).toMatchObject({ ok: false });
      expect(await auth.authenticate("human", redemption.password)).toMatchObject({ ok: true });
      expect(await auth.authenticateToken("human", humanToken.token)).toMatchObject({ ok: false });
      expect(sql.exec("SELECT revoked_at FROM identity_links WHERE uid = 1000").toArray()[0].revoked_at).not.toBeNull();
      expect(auth.credentialEpoch(1000)).toBe(1);
      expect(auth.credentialEpoch(0)).toBe(0);
      expect(await auth.authenticate("root", "old-root-password")).toMatchObject({ ok: true });
      expect(await auth.authenticateToken("root", rootToken.token)).toMatchObject({ ok: true });
      auth.setShadow(makeShadowEntry("human", await hashPassword("later-personal-password")));
      expect(await recovery.redeem(redemption)).toEqual({ username: "human", uid: 1000 });
      expect(await auth.authenticate("human", "later-personal-password")).toMatchObject({ ok: true });
      expect(auth.credentialEpoch(1000)).toBe(1);
      expect(JSON.stringify(sql.exec("SELECT * FROM account_recovery_claims").toArray())).not.toContain(redemption.secret);
      expect(JSON.stringify(sql.exec("SELECT * FROM account_recovery_claims").toArray())).not.toContain(redemption.password);
    });
  });

  it("changes the administrator too while it still has the personal password signup gave both, so the old one opens nothing", async () => {
    await fixture(async (recovery, auth) => {
      const shared = await hashPassword("human-password");
      auth.setShadow(makeShadowEntry("human", shared));
      auth.setShadow(makeShadowEntry("root", shared));
      const rootToken = await auth.issueToken({ uid: 0, kind: "human" });
      const redemption = personal((await grant(recovery)).request);
      expect(await recovery.redeem(redemption)).toEqual({ username: "human", uid: 1000, administratorChanged: true });
      expect(await auth.authenticate("root", "human-password")).toMatchObject({ ok: false });
      expect(await auth.authenticate("root", redemption.password)).toMatchObject({ ok: true });
      expect(await auth.authenticateToken("root", rootToken.token)).toMatchObject({ ok: false });
    });
  });

  it("spends one claim on one account: another proof, password or account cannot reuse it", async () => {
    await fixture(async (recovery, auth) => {
      const redemption = personal((await grant(recovery)).request);
      await recovery.redeem(redemption);
      await expect(recovery.redeem({ ...redemption, proof: `${crypto.randomUUID()}${crypto.randomUUID()}` })).rejects.toThrow("already used");
      await expect(recovery.redeem({ ...redemption, password: "another-password" })).rejects.toThrow("already used");
      await expect(recovery.redeem({ ...redemption, account: "administrator" })).rejects.toThrow("already used");
      const { account: _personal, ...legacy } = redemption;
      await expect(recovery.redeem(legacy)).rejects.toThrow("already used");
      expect(await auth.authenticate("root", "old-root-password")).toMatchObject({ ok: true });
    });
  });

  it("refuses a claim once the personal credentials changed or the claim expired", async () => {
    await fixture(async (recovery, auth) => {
      const changed = personal((await grant(recovery)).request);
      const { input, request } = await grant(recovery);
      auth.replaceHumanPassword(1000, await hashPassword("changed-meanwhile"), "test");
      await expect(recovery.redeem(changed)).rejects.toThrow("superseded");
      expect(await auth.authenticate("human", "changed-meanwhile")).toMatchObject({ ok: true });
      const clock = vi.spyOn(Date, "now").mockReturnValue(input.expiresAt);
      try { await expect(recovery.redeem(personal(request))).rejects.toThrow("expired"); }
      finally { clock.mockRestore(); }
    });
  });

  it("refuses a wrong secret and an invalid account choice", async () => {
    await fixture(async (recovery, auth) => {
      const redemption = personal((await grant(recovery)).request);
      await expect(recovery.redeem({ ...redemption, secret: `${crypto.randomUUID()}${crypto.randomUUID()}` })).rejects.toThrow("unavailable");
      // SAFETY: the wire is hostile; this proves the runtime check, not the type.
      await expect(recovery.redeem({ ...redemption, account: "friend" as "personal" })).rejects.toThrow("Invalid");
      expect(await auth.authenticate("human", "human-password")).toMatchObject({ ok: true });
    });
  });

  it("names a locked, disabled or absent personal account only to the holder of the claim and leaves it unchanged", async () => {
    await fixture(async (recovery, auth, sql) => {
      const lockedAfterGrant = personal((await grant(recovery)).request);
      auth.setShadow(makeShadowEntry("human", "!"));
      await expect(recovery.redeem({ ...lockedAfterGrant, secret: `${crypto.randomUUID()}${crypto.randomUUID()}` })).rejects.not.toBeInstanceOf(PersonalAccountUnavailableError);
      await expect(recovery.redeem(lockedAfterGrant)).rejects.toBeInstanceOf(PersonalAccountUnavailableError);
      const lockedBeforeGrant = await grant(recovery);
      await expect(recovery.redeem(personal(lockedBeforeGrant.request))).rejects.toBeInstanceOf(PersonalAccountUnavailableError);
      expect(auth.getShadowByUsername("human")?.hash).toBe("!");
      // The same claim still recovers the administrator.
      expect(await recovery.redeem(lockedBeforeGrant.request)).toEqual({ username: "root", uid: 0 });
      sql.exec("INSERT INTO account_access (uid, disabled_at) VALUES (1000, 1) ON CONFLICT(uid) DO UPDATE SET disabled_at = 1");
      auth.setShadow(makeShadowEntry("human", await hashPassword("human-password")));
      await expect(recovery.redeem(personal((await grant(recovery)).request))).rejects.toBeInstanceOf(PersonalAccountUnavailableError);
    });
  });

  it("omitting the account stays an administrator reset for pages opened before this release", async () => {
    await fixture(async (recovery, auth) => {
      const { request } = await grant(recovery);
      expect(await recovery.redeem(request)).toEqual({ username: "root", uid: 0 });
      expect(await auth.authenticate("human", "human-password")).toMatchObject({ ok: true });
    });
  });
});

describe("owner recovery options", () => {
  it("offers navigation to the owner page with the Ship's own handle and no authority", () => {
    expect(ownerRecoveryOptions({ env: { GSV_OWNER_SIGNUP_URL: "https://accounts.example/owner/signup/?resume=1" }, installationIdentity: { handle: "my-ship" } }))
      .toEqual({ emailUrl: "https://accounts.example/owner/recover?handle=my-ship" });
  });

  it("offers nothing without a configured owner origin or a known handle", () => {
    expect(ownerRecoveryOptions({ env: {}, installationIdentity: { handle: "my-ship" } })).toEqual({});
    expect(ownerRecoveryOptions({ env: { GSV_OWNER_SIGNUP_URL: "https://accounts.example/owner/signup/" } })).toEqual({});
  });
});
