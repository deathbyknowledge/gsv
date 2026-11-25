import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InstallationOwnerAuthStore } from "./owner-auth-store";
import { InstallationOwnerRecovery } from "./owner-recovery";
import { InstallationOwnerSignIn, installationOwnerSignIn } from "./owner-service";
import { InstallationOwnerStore } from "./owner-store";
import { AccountStore } from "./store";
import { sha256Hex } from "./tokens";

afterEach(() => vi.restoreAllMocks());

const hex = () => (crypto.randomUUID() + crypto.randomUUID()).replaceAll("-", "");

async function fixture() {
  const suffix = crypto.randomUUID().slice(0, 8);
  const db = env.INSTALLATIONS_DB;
  const accounts = new AccountStore(db, "example.com");
  const registry = `principal_registry_${suffix}`;
  await accounts.createPrincipal({ principalId: registry, email: `${suffix}@registry.invalid`, displayName: "Registry", verified: true });
  const owner = `principal_owner_${suffix}`;
  const email = `${suffix}@example.com`;
  await accounts.createPrincipal({ principalId: owner, email, displayName: "Owner", verified: true });
  await db.prepare("INSERT INTO principal_email_credentials (email_normalized, principal_id, created_at) VALUES (?, ?, ?)").bind(email, owner, Date.now()).run();
  const ship = async (name: string) => {
    const space = await accounts.reserveInstallation({ principalId: owner, operationId: `operation_${name}_${suffix}`, handle: `${name}-${suffix}` });
    await db.prepare("UPDATE installations SET state = 'active' WHERE id = ?").bind(space.installationId).run();
    return space;
  };
  const delivered: EmailMessageBuilder[] = [];
  const mail: SendEmail = { send: vi.fn(async (message: EmailMessage | EmailMessageBuilder): Promise<EmailSendResult> => {
    if (!("subject" in message)) throw new Error("Expected a composed email");
    delivered.push(message);
    return { messageId: crypto.randomUUID() };
  }) };
  const auth = new InstallationOwnerAuthStore(db, "sign-in-test-secret-".repeat(4));
  const recovery = new InstallationOwnerRecovery(auth, new InstallationOwnerStore(db, registry), mail, { from: "login@ship.space" }, 0);
  const signIn = new InstallationOwnerSignIn(auth, recovery);
  const code = () => delivered.at(-1)?.text?.match(/^([0-9]{6})$/m)?.[1] ?? "";
  return { auth, signIn, ship, email, delivered, code, source: `client-${suffix}` };
}

describe("owner email sign-in for a Kernel", () => {
  it("mails the owner a code in the subject and a link to their Ship, then verifies it into that Ship's claim", async () => {
    const f = await fixture();
    const space = await f.ship("signin");
    const attempt = { installationId: space.installationId, attemptId: crypto.randomUUID(), secret: hex() };
    expect(await f.signIn.sendOwnerSignInCode({ ...attempt, email: f.email, source: f.source })).toEqual({ accepted: true });
    expect(f.delivered).toHaveLength(1);
    const code = f.code();
    expect(f.delivered[0]).toMatchObject({ to: f.email, subject: `${code} is your Ship sign-in code` });
    const link = `${space.canonicalOrigin}/chat#signin=${attempt.attemptId}&code=${code}`;
    expect(f.delivered[0].text).toContain(link);
    expect(f.delivered[0].html).toContain(link.replace("&", "&amp;"));

    const claim = { installationId: space.installationId, attemptId: attempt.attemptId, purpose: "root-password-reset",
      secretHash: await sha256Hex(attempt.secret), expiresAt: expect.any(Number) };
    expect(await f.signIn.verifyOwnerSignIn({ ...attempt, code })).toEqual({ authorized: claim });
    // A lost answer to the Kernel verifies again rather than spending the code.
    expect(await f.signIn.verifyOwnerSignIn({ ...attempt, code })).toEqual({ authorized: claim });
    // The session a verification opens in Accounts is not one the Kernel or the client can present.
    expect(await f.auth.session(attempt.secret)).toBeNull();
    expect(await f.auth.session(await sha256Hex(attempt.secret))).toBeNull();
  });

  it("answers a stranger the same way without mailing anyone or authorizing a claim", async () => {
    const f = await fixture();
    const space = await f.ship("stranger");
    const attempt = { installationId: space.installationId, attemptId: crypto.randomUUID(), secret: hex() };
    expect(await f.signIn.sendOwnerSignInCode({ ...attempt, email: `someone-else-${crypto.randomUUID().slice(0, 6)}@example.com`, source: f.source }))
      .toEqual({ accepted: true });
    expect(f.delivered).toHaveLength(0);
    expect(await f.signIn.verifyOwnerSignIn({ ...attempt, code: "123456" })).not.toHaveProperty("authorized");
  });

  it("never authorizes one Ship's attempt for another Ship", async () => {
    const f = await fixture();
    const [space, other] = [await f.ship("mine"), await f.ship("other")];
    const attempt = { installationId: space.installationId, attemptId: crypto.randomUUID(), secret: hex() };
    await f.signIn.sendOwnerSignInCode({ ...attempt, email: f.email, source: f.source });
    const sent = f.delivered.length;
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61_000);
    await f.signIn.sendOwnerSignInCode({ ...attempt, installationId: other.installationId, email: f.email, source: f.source, resend: true });
    expect(f.delivered).toHaveLength(sent);
    vi.restoreAllMocks();
    expect(await f.signIn.verifyOwnerSignIn({ ...attempt, installationId: other.installationId, code: f.code() })).toEqual({ failed: "unavailable" });
  });

  it("locks the attempt after five wrong codes", async () => {
    const f = await fixture();
    const space = await f.ship("locked");
    const attempt = { installationId: space.installationId, attemptId: crypto.randomUUID(), secret: hex() };
    await f.signIn.sendOwnerSignInCode({ ...attempt, email: f.email, source: f.source });
    const wrong = f.code() === "000000" ? "000001" : "000000";
    for (let i = 0; i < 4; i++) expect(await f.signIn.verifyOwnerSignIn({ ...attempt, code: wrong })).toEqual({ failed: "invalid" });
    expect(await f.signIn.verifyOwnerSignIn({ ...attempt, code: wrong })).toEqual({ failed: "locked" });
    expect(await f.signIn.verifyOwnerSignIn({ ...attempt, code: f.code() })).toEqual({ failed: "locked" });
  });

  it("lets an unexpected failure reach the Kernel, which records it, instead of answering a refusal", async () => {
    const f = await fixture();
    const space = await f.ship("broken");
    const attempt = { installationId: space.installationId, attemptId: crypto.randomUUID(), secret: hex() };
    vi.spyOn(f.auth, "issue").mockRejectedValueOnce(new TypeError("D1 went away"));
    await expect(f.signIn.sendOwnerSignInCode({ ...attempt, email: f.email, source: f.source })).rejects.toThrow("D1 went away");
    expect(f.delivered).toHaveLength(0);
    await f.signIn.sendOwnerSignInCode({ ...attempt, email: f.email, source: f.source });
    vi.spyOn(f.auth, "unheldSessionSecret").mockRejectedValueOnce(new TypeError("D1 went away"));
    await expect(f.signIn.verifyOwnerSignIn({ ...attempt, code: f.code() })).rejects.toThrow("D1 went away");
  });

  it("refuses malformed attempts before touching state", async () => {
    const f = await fixture();
    const space = await f.ship("malformed");
    const attempt = { installationId: space.installationId, attemptId: crypto.randomUUID(), secret: hex() };
    await expect(f.signIn.sendOwnerSignInCode({ ...attempt, secret: "short", email: f.email, source: f.source })).rejects.toThrow();
    await expect(f.signIn.verifyOwnerSignIn({ ...attempt, attemptId: "not-a-uuid", code: "123456" })).rejects.toThrow();
    expect(f.delivered).toHaveLength(0);
  });
});

describe("owner email sign-in from an operator's Accounts", () => {
  it("serves only the Kernel's deployment-granted binding, and only where owner email is configured", () => {
    const mail: SendEmail = { send: vi.fn() };
    const configured = { INSTALLATIONS_DB: env.INSTALLATIONS_DB, OWNER_EMAIL: mail, GSV_OWNER_EMAIL_FROM: "login@ship.space", GSV_OWNER_AUTH_SECRET: "sign-in-test-secret-".repeat(4) };
    const kernel = { authority: "kernel-owner-link" };
    expect(installationOwnerSignIn(configured, "principal_registry", kernel)).toBeInstanceOf(InstallationOwnerSignIn);
    expect(() => installationOwnerSignIn(configured, "principal_registry", undefined)).toThrow("not configured");
    expect(() => installationOwnerSignIn(configured, "principal_registry", { authority: "other" })).toThrow("not configured");
    expect(() => installationOwnerSignIn({ ...configured, OWNER_EMAIL: undefined }, "principal_registry", kernel)).toThrow("not configured");
  });
});
