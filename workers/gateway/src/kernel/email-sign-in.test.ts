import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { InstallationOwnershipService, OwnerSignInVerification } from "@humansandmachines/gsv/services/ownership";
import { createSessionCredential } from "@humansandmachines/gsv/protocol/pairing";
import { hashPassword, makeShadowEntry, UNSET_PASSWORD_HASH } from "../auth/shadow";
import { runWithRealKernelSql } from "../test-support/real-kernel-sql";
import { testPeer } from "../test-support/peers";
import { AuthStore } from "./auth-store";
import { AccountRecoveryStore, EMAIL_SIGN_IN_SESSION_MS, ownerRecoveryOptions, sha256 } from "./account-recovery";
import type { KernelContext } from "./context";
import { EMAIL_SIGN_IN_FAILURE_KEY, EmailSignInError, emailSignInFailed, redeemEmailSignIn, startEmailSignIn } from "./email-sign-in";

const INSTALLATION = "installation_sign_in";
const hex = () => `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll("-", "");

/** Accounts as the Kernel sees it: a code reaches the owner, and a correct one becomes one stable claim. */
function accounts() {
  const sent = new Map<string, { secret: string; expiresAt: number }>();
  const ownership = {
    beginInstallationOwnerLink: vi.fn(),
    sendOwnerSignInCode: vi.fn<InstallationOwnershipService["sendOwnerSignInCode"]>(async (input) => {
      if (input.email === "owner@example.com") sent.set(input.attemptId, { secret: input.secret, expiresAt: Date.now() + 300_000 });
      return { accepted: true };
    }),
    verifyOwnerSignIn: vi.fn<InstallationOwnershipService["verifyOwnerSignIn"]>(async (input): Promise<OwnerSignInVerification> => {
      const attempt = sent.get(input.attemptId);
      if (!attempt || attempt.secret !== input.secret || input.code !== "135790") return { failed: "invalid" };
      return { authorized: { installationId: input.installationId, attemptId: input.attemptId, purpose: "root-password-reset",
        secretHash: await sha256(input.secret), expiresAt: attempt.expiresAt } };
    }),
  } satisfies InstallationOwnershipService;
  return ownership;
}

async function fixture(work: (f: { ctx: KernelContext; auth: AuthStore; recovery: AccountRecoveryStore; ownership: ReturnType<typeof accounts>; sql: SqlStorage;
  storage: DurableObjectStorage }) => Promise<void>,
  options: { personal?: string; root?: string } = {}) {
  await runWithRealKernelSql(async (sql, storage) => {
    const auth = new AuthStore(sql);
    await auth.bootstrap();
    auth.setShadow(makeShadowEntry("root", options.root ?? UNSET_PASSWORD_HASH));
    auth.addUser({ uid: 1000, gid: 1000, username: "person", home: "/home/person", gecos: "", shell: "/bin/init" });
    auth.setShadow(makeShadowEntry("person", options.personal ?? UNSET_PASSWORD_HASH));
    const recovery = new AccountRecoveryStore(storage, auth, INSTALLATION);
    const ownership = accounts();
    // SAFETY: email sign-in reads only these Kernel owners; the rest of the context is unused.
    const ctx = { auth, accountRecovery: recovery, installationId: INSTALLATION, installationIdentity: { handle: "person" }, connection: null,
      env: { INSTALLATION_OWNERSHIP: ownership, GSV_OWNER_SIGNUP_URL: "https://accounts.example/owner/signup/" } } as KernelContext;
    await work({ ctx, auth, recovery, ownership, sql, storage });
  });
}

/** The person themself, signed in with a credential, or a Process acting as them. */
function as(ctx: KernelContext, uid: number, provenance: "credential" | "process" = "credential"): KernelContext {
  const user = ctx.auth.getPasswdByUid(uid)!;
  const peer = testPeer({ account: { ...user, gids: [user.gid], cwd: user.home }, calls: ["*"] });
  // SAFETY: the peer is the only part of the context that changes, and testPeer builds a complete one.
  return { ...ctx, peer: provenance === "credential" ? peer : { ...peer, provenance: { kind: "process", pid: "proc_1" } } } as KernelContext;
}

async function signIn(ctx: KernelContext, credential = createSessionCredential()) {
  const attempt = { id: crypto.randomUUID(), secret: hex() };
  await startEmailSignIn({ ...attempt, email: "owner@example.com" }, ctx);
  return { ...attempt, code: "135790", credential };
}

describe("email sign-in to the personal account", () => {
  it("spends a verified code on one session from the client's credential, and gives a lost answer back", async () => {
    await fixture(async ({ ctx, auth, ownership, sql }) => {
      const request = await signIn(ctx);
      const session = await redeemEmailSignIn(request, ctx);
      expect(session).toEqual({ username: "person", tokenId: expect.any(String), expiresAt: expect.any(Number) });
      expect(session.expiresAt).toBeGreaterThan(Date.now() + EMAIL_SIGN_IN_SESSION_MS - 60_000);
      expect(await auth.authenticateToken("person", request.credential)).toMatchObject({ ok: true, identity: { uid: 1000 } });
      expect(await redeemEmailSignIn(request, ctx)).toEqual(session);
      expect(ownership.verifyOwnerSignIn).toHaveBeenCalledTimes(1);
      await expect(redeemEmailSignIn({ ...request, credential: createSessionCredential() }, ctx)).rejects.toThrow("already used");
      expect(auth.listTokens(1000).filter((token) => token.revokedAt === null)).toHaveLength(1);
      expect(auth.credentialEpoch(1000)).toBe(0);
      const stored = JSON.stringify([sql.exec("SELECT * FROM account_recovery_claims").toArray(), sql.exec("SELECT * FROM auth_tokens").toArray()]);
      expect(stored).not.toContain(request.secret);
      expect(stored).not.toContain(request.credential);
    });
  });

  it("opens nothing for a refused code and names only what the person can do about it", async () => {
    await fixture(async ({ ctx, auth }) => {
      const request = await signIn(ctx);
      await expect(redeemEmailSignIn({ ...request, code: "000000" }, ctx)).rejects.toEqual(new EmailSignInError("invalid"));
      const stranger = { id: crypto.randomUUID(), secret: hex() };
      await startEmailSignIn({ ...stranger, email: "someone@example.com" }, ctx);
      await expect(redeemEmailSignIn({ ...stranger, code: "135790", credential: createSessionCredential() }, ctx)).rejects.toEqual(new EmailSignInError("invalid"));
      expect(auth.listTokens(1000)).toHaveLength(0);
    });
  });

  it("refuses the session once the personal credentials changed after the code was verified", async () => {
    await fixture(async ({ ctx, auth, recovery, ownership }) => {
      const request = await signIn(ctx);
      const verification = await ownership.verifyOwnerSignIn({ installationId: INSTALLATION, attemptId: request.id, secret: request.secret, code: request.code });
      if (!("authorized" in verification)) throw new Error("Expected a claim");
      recovery.authorize(verification.authorized);
      auth.invalidateCredentials(1000, "reset elsewhere");
      await expect(redeemEmailSignIn(request, ctx)).rejects.toThrow("superseded");
      expect(await auth.authenticateToken("person", request.credential)).toMatchObject({ ok: false });
    });
  });

  it("rejects a credential the client did not generate as a session", async () => {
    await fixture(async ({ ctx, ownership }) => {
      const request = await signIn(ctx, "gsv_machine_" + "a".repeat(64));
      await expect(redeemEmailSignIn(request, ctx)).rejects.toThrow();
      expect(ownership.verifyOwnerSignIn).not.toHaveBeenCalled();
    });
  });

  it("asks Accounts for nothing while the Ship is still being set up", async () => {
    await fixture(async ({ ctx, auth, ownership }) => {
      auth.setShadow(makeShadowEntry("root", "!"));
      auth.removeUser("person");
      await expect(startEmailSignIn({ id: crypto.randomUUID(), secret: hex(), email: "owner@example.com" }, ctx)).resolves.toEqual({ accepted: true });
      expect(ownership.sendOwnerSignInCode).not.toHaveBeenCalled();
    });
  });

  it("keeps the cause of an unexpected failure for the operator, and answers with only its reference", async () => {
    await fixture(async ({ ctx, ownership, storage }) => {
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const kernel = { env: { ...ctx.env, GSV_TELEMETRY_ENABLED: true }, installationId: INSTALLATION };
      ownership.sendOwnerSignInCode.mockRejectedValueOnce(new TypeError("private Accounts detail"));
      const error = await startEmailSignIn({ id: crypto.randomUUID(), secret: hex(), email: "owner@example.com" }, ctx).then(() => null, (cause: Error) => cause);
      const failed = emailSignInFailed("start", error ?? new Error("started"), kernel, storage);

      const record = z.strictObject({ diagnosticId: z.uuid(), call: z.literal("start"), recordedAt: z.number(), cause: z.string().max(8192) })
        .parse(storage.kv.get(EMAIL_SIGN_IN_FAILURE_KEY));
      expect(record.cause).toContain("private Accounts detail");
      expect(failed).toEqual({ status: 400, details: { signIn: "unavailable", diagnosticId: record.diagnosticId } });
      expect(log).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        component: "gateway", installationId: INSTALLATION,
        event: { stream: "operational", name: "account.signin.failed", properties: { diagnosticId: record.diagnosticId, call: "start", errorType: "TypeError" } },
      }));
      expect(JSON.stringify(log.mock.calls)).not.toContain("private");

      // A refusal names what to do about it, and nothing failed.
      storage.kv.delete(EMAIL_SIGN_IN_FAILURE_KEY);
      expect(emailSignInFailed("redeem", new EmailSignInError("locked"), kernel, storage)).toEqual({ status: 429, details: { signIn: "locked" } });
      expect(storage.kv.get(EMAIL_SIGN_IN_FAILURE_KEY)).toBeUndefined();
      expect(log).toHaveBeenCalledOnce();
      log.mockRestore();
    });
  });

  it("is offered only where the operator runs owner email for this Ship", async () => {
    await fixture(async ({ ctx, ownership }) => {
      expect(ownerRecoveryOptions(ctx)).toEqual({ emailUrl: "https://accounts.example/owner/recover?handle=person", emailSignIn: true });
      // SAFETY: the same context with an environment that has no owner email binding.
      const without = { ...ctx, env: { GSV_OWNER_SIGNUP_URL: "https://accounts.example/owner/signup/" } } as KernelContext;
      expect(ownerRecoveryOptions(without)).toEqual({ emailUrl: "https://accounts.example/owner/recover?handle=person" });
      await expect(startEmailSignIn({ id: crypto.randomUUID(), secret: hex(), email: "owner@example.com" }, without)).rejects.toEqual(new EmailSignInError("unavailable"));
      expect(ownership.sendOwnerSignInCode).not.toHaveBeenCalled();
    });
  });
});

describe("a first password for someone who signs in by email", () => {
  it("sets the personal password without signing anything out, and leaves the administrator without one", async () => {
    await fixture(async ({ ctx, auth, recovery }) => {
      const session = await auth.issueToken({ uid: 1000, kind: "human" });
      expect(recovery.passwordStatus(as(ctx, 1000))).toEqual({ set: false });
      await expect(recovery.setFirstPassword({ password: "first-password" }, as(ctx, 1000))).resolves.toEqual({ updated: true });
      expect(recovery.passwordStatus(as(ctx, 1000))).toEqual({ set: true });
      expect(await auth.authenticate("person", "first-password")).toMatchObject({ ok: true });
      expect(await auth.authenticateToken("person", session.token)).toMatchObject({ ok: true });
      expect(auth.credentialEpoch(1000)).toBe(0);
      expect(await auth.authenticate("root", "first-password")).toMatchObject({ ok: false });
      expect(recovery.passwordStatus(as(ctx, 0))).toEqual({ set: false });
    });
  });

  it("changes no password that already exists, and takes none from a Process acting as the person", async () => {
    await fixture(async ({ ctx, recovery }) => {
      await expect(recovery.setFirstPassword({ password: "process-password" }, as(ctx, 1000, "process"))).rejects.toThrow("signed-in person");
      await recovery.setFirstPassword({ password: "first-password" }, as(ctx, 1000));
      await expect(recovery.setFirstPassword({ password: "second-password" }, as(ctx, 1000))).rejects.toThrow("already has a password");
      await expect(recovery.setFirstPassword({ uid: 1001, password: "other-password" }, as(ctx, 1000))).rejects.toThrow("unavailable");
    });
  });

  it("keeps the administrator without a password when owner email recovery gives the person one", async () => {
    await fixture(async ({ recovery, auth, sql }) => {
      const secret = hex();
      recovery.authorize({ installationId: INSTALLATION, attemptId: crypto.randomUUID(), purpose: "root-password-reset",
        secretHash: await sha256(secret), expiresAt: Date.now() + 300_000 });
      const [claim] = sql.exec<{ id: string }>("SELECT id FROM account_recovery_claims").toArray();
      expect(await recovery.redeem({ id: claim.id, secret, proof: hex(), password: "recovered-password", account: "personal" })).toEqual({ username: "person", uid: 1000 });
      expect(await auth.authenticate("person", "recovered-password")).toMatchObject({ ok: true });
      expect(await auth.authenticate("root", "recovered-password")).toMatchObject({ ok: false });
      expect(auth.credentialEpoch(0)).toBe(0);
    });
  });

  it("still lets password setup share its password with the administrator", async () => {
    const shared = await hashPassword("shared-password");
    await fixture(async ({ recovery, auth }) => {
      // SAFETY: password status reads only the auth store.
      expect(recovery.passwordStatus(as({ auth } as KernelContext, 1000))).toEqual({ set: true });
      expect(auth.replacePersonalPassword(1000, await hashPassword("new-password"), "test")).toBe(true);
    }, { personal: shared, root: shared });
  });
});
