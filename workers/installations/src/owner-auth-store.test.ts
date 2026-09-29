import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { InstallationOwnerAuthStore, OWNER_CODE_RESEND_MS, OWNER_CODE_TTL_MS, OWNER_SESSION_TTL_MS, type OwnerCodeRequest } from "./owner-auth-store";
import { InstallationOwnerStore } from "./owner-store";
import { AccountStore } from "./store";
import { sha256Hex } from "./tokens";

const codeSecret = "synthetic-owner-code-key-with-at-least-thirty-two-bytes";
const db = env.INSTALLATIONS_DB;
const browserSecret = () => crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
function fixture() {
  const suffix = crypto.randomUUID();
  const input: OwnerCodeRequest = { challengeId: crypto.randomUUID(), email: `${suffix}@example.com`,
    ip: `fixture-${suffix}`, browserSecret: browserSecret(), purpose: "login" };
  return { auth: new InstallationOwnerAuthStore(db, codeSecret), input, now: Date.now(), sessionSecret: browserSecret() };
}
async function login() {
  const f = fixture();
  const issued = await f.auth.issue(f.input, f.now);
  const receipt = await f.auth.verify({ ...f.input, code: issued.code, sessionSecret: f.sessionSecret }, f.now);
  return { ...f, issued, receipt };
}
async function ownerFixture(purpose: "link" | "recover") {
  const f = await login();
  const accounts = new AccountStore(db, "example.com");
  const registryId = `registry_${crypto.randomUUID()}`;
  await accounts.createPrincipal({ principalId: registryId, email: `${registryId}@example.com`, displayName: "Registry", verified: true });
  const reserved = await accounts.reserveInstallation({ principalId: purpose === "link" ? registryId : f.receipt.principalId,
    operationId: crypto.randomUUID(), handle: `owner-${crypto.randomUUID().slice(0, 8)}` });
  await db.prepare("UPDATE installations SET state = 'active' WHERE id = ?").bind(reserved.installationId).run();
  const owner = new InstallationOwnerStore(db, registryId);
  const id = crypto.randomUUID();
  const proof = await sha256Hex(browserSecret());
  const now = f.now + OWNER_CODE_RESEND_MS;
  if (purpose === "link") await owner.beginLink({ attemptId: id, installationId: reserved.installationId, secretHash: proof }, now);
  else await owner.beginRecovery(reserved.handle, id, now);
  await owner.startEmailAuthentication(id, { browserSecretHash: await sha256Hex(f.input.browserSecret), linkSecretHash: proof }, now);
  const input = { ...f.input, challengeId: crypto.randomUUID(), purpose, ownerAttemptId: id };
  return { ...f, now, input, owner, reserved, registryId };
}

describe("native owner email authentication", () => {
  it("creates an explicit immutable native principal and hashed fixed-lifetime session without creating a space", async () => {
    const f = fixture();
    const before = await db.prepare("SELECT COUNT(*) AS count FROM installations").first();
    const issued = await f.auth.issue({ ...f.input, email: ` ${f.input.email.toUpperCase()} ` }, f.now);
    expect(issued).toMatchObject({ code: expect.stringMatching(/^[0-9]{6}$/), email: f.input.email, sendRequired: true, deliveryStatus: "sending" });
    expect(await db.prepare("SELECT * FROM principals WHERE primary_email_normalized = ?").bind(f.input.email).first()).toBeNull();
    await f.auth.recordDelivery({ challengeId: issued.challengeId, deliveryId: issued.deliveryId!, browserSecret: f.input.browserSecret, sent: true }, f.now);
    const receipt = await f.auth.verify({ ...f.input, code: issued.code, sessionSecret: f.sessionSecret }, f.now);
    expect(receipt).toMatchObject({ purpose: "login", principalId: expect.stringMatching(/^principal_native_/),
      verifiedAt: f.now, sessionExpiresAt: f.now + OWNER_SESSION_TTL_MS });
    expect(await f.auth.session(f.sessionSecret, f.now + 1)).toEqual({ principalId: receipt.principalId, email: f.input.email,
      authenticatedAt: f.now, expiresAt: f.now + OWNER_SESSION_TTL_MS });
    expect(await db.prepare("SELECT COUNT(*) AS count FROM installations").first()).toEqual(before);
    const stored = await db.prepare("SELECT browser_secret_hash, code_verifier, session_hash FROM owner_auth_challenges WHERE id = ?")
      .bind(issued.challengeId).first<{ browser_secret_hash: string; code_verifier: string; session_hash: string }>();
    expect(stored).toEqual({ browser_secret_hash: await sha256Hex(f.input.browserSecret), code_verifier: expect.stringMatching(/^[a-f0-9]{64}$/),
      session_hash: await sha256Hex(f.sessionSecret) });
    expect(stored?.code_verifier).not.toBe(await sha256Hex(issued.code));
    const send = await db.prepare("SELECT email_key, ip_key FROM owner_auth_send_events WHERE id = ?").bind(issued.deliveryId).first();
    expect(send).toEqual({ email_key: expect.stringMatching(/^[a-f0-9]{64}$/), ip_key: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });

  it("allows one verification winner and only the same browser/session to retry a lost response", async () => {
    const f = fixture();
    const issued = await f.auth.issue(f.input, f.now);
    const secrets = [f.sessionSecret, browserSecret()];
    const attempts = secrets.map((sessionSecret) => ({ ...f.input, code: issued.code, sessionSecret }));
    const outcomes = await Promise.allSettled(attempts.map((input) => f.auth.verify(input, f.now)));
    expect(outcomes.filter((value) => value.status === "fulfilled")).toHaveLength(1);
    const winner = outcomes.findIndex((value) => value.status === "fulfilled");
    const input = attempts[winner];
    const session = await f.auth.session(secrets[winner], f.now);
    expect(session).not.toBeNull();
    if (!session) throw new Error("Winning authentication has no session");
    expect(await f.auth.verify(input, f.now + 1)).toMatchObject({ principalId: session.principalId, verifiedAt: f.now });
    await expect(f.auth.verify({ ...input, browserSecret: browserSecret() }, f.now + 1)).rejects.toMatchObject({ code: "unavailable" });
    await expect(f.auth.verify({ ...input, sessionSecret: browserSecret() }, f.now + 1)).rejects.toMatchObject({ code: "already_used" });
    expect((await db.prepare("SELECT * FROM owner_auth_sessions WHERE principal_id = ?").bind(session.principalId).all()).results).toHaveLength(1);
  });

  it("counts concurrent wrong guesses atomically and permanently locks the fifth attempt", async () => {
    const f = fixture();
    const issued = await f.auth.issue(f.input, f.now);
    const input = { ...f.input, code: issued.code === "000000" ? "111111" : "000000", sessionSecret: f.sessionSecret };
    await expect(f.auth.verify({ ...input, browserSecret: browserSecret() }, f.now)).rejects.toMatchObject({ code: "unavailable" });
    await Promise.allSettled(Array.from({ length: 8 }, () => f.auth.verify(input, f.now)));
    expect(await db.prepare("SELECT failed_attempts, verified_at FROM owner_auth_challenges WHERE id = ?").bind(issued.challengeId).first())
      .toEqual({ failed_attempts: 5, verified_at: null });
    await expect(f.auth.verify({ ...input, code: issued.code }, f.now)).rejects.toMatchObject({ code: "locked" });
    expect(await f.auth.session(f.sessionSecret, f.now)).toBeNull();
  });

  it("rejects code expiry and a different HMAC key without granting a principal", async () => {
    const f = fixture();
    const issued = await f.auth.issue(f.input, f.now);
    await expect(new InstallationOwnerAuthStore(db, codeSecret + "different").verify({ ...f.input, code: issued.code, sessionSecret: f.sessionSecret }, f.now))
      .rejects.toMatchObject({ code: "invalid" });
    await expect(f.auth.verify({ ...f.input, code: issued.code, sessionSecret: f.sessionSecret }, f.now + OWNER_CODE_TTL_MS))
      .rejects.toMatchObject({ code: "expired" });
    expect(await db.prepare("SELECT * FROM principal_email_credentials WHERE email_normalized = ?").bind(f.input.email).first()).toBeNull();
  });

  it.each([false, true])("does not resurrect an expired code after cleanup and challenge ID reuse (consumed: %s)", async (consumed) => {
    const f = fixture();
    const input: OwnerCodeRequest = { ...f.input, challengeId: `expired-replay-${consumed}`, email: `expired-replay-${consumed}@example.com`,
      browserSecret: "a".repeat(64) };
    const firstGeneration = "10000000-0000-4000-8000-000000000001";
    const nextGeneration = "10000000-0000-4000-8000-000000000002";
    const random = vi.spyOn(crypto, "randomUUID").mockReturnValueOnce(firstGeneration);
    try {
      const issued = await f.auth.issue(input, f.now);
      if (consumed) await f.auth.verify({ ...input, code: issued.code, sessionSecret: f.sessionSecret }, f.now);
      const now = f.now + OWNER_CODE_TTL_MS;
      await f.auth.cleanup(now);
      expect(await db.prepare("SELECT id FROM owner_auth_challenges WHERE id = ?").bind(input.challengeId).first()).toBeNull();
      random.mockReturnValueOnce(nextGeneration);
      const recreated = await f.auth.issue(input, now);
      expect(recreated.code).not.toBe(issued.code);
      expect(await db.prepare("SELECT code_generation FROM owner_auth_challenges WHERE id = ?").bind(input.challengeId).first())
        .toEqual({ code_generation: nextGeneration });
      const sessionSecret = (consumed ? "b" : "c").repeat(64);
      await expect(f.auth.verify({ ...input, code: issued.code, sessionSecret }, now)).rejects.toMatchObject({ code: "invalid" });
      expect(await f.auth.session(sessionSecret, now)).toBeNull();
      await expect(f.auth.verify({ ...input, code: recreated.code, sessionSecret }, now)).resolves.toMatchObject({ verifiedAt: now });
    } finally {
      random.mockRestore();
    }
  });

  it("makes delivery retries idempotent and keeps failed sends behind the durable cooldown", async () => {
    const f = fixture();
    const results = await Promise.all(Array.from({ length: 3 }, () => f.auth.issue(f.input, f.now)));
    expect(results.filter((result) => result.sendRequired)).toHaveLength(1);
    const issued = results.find((result) => result.sendRequired)!;
    expect(new Set(results.map((result) => result.code)).size).toBe(1);
    await f.auth.recordDelivery({ challengeId: issued.challengeId, deliveryId: issued.deliveryId!, browserSecret: f.input.browserSecret, sent: false }, f.now);
    expect(await new InstallationOwnerAuthStore(db, codeSecret).issue(f.input, f.now + 1))
      .toMatchObject({ sendRequired: false, deliveryStatus: "failed", retryAt: f.now + OWNER_CODE_RESEND_MS });
    const retry = await f.auth.issue(f.input, f.now + OWNER_CODE_RESEND_MS);
    expect(retry).toMatchObject({ sendRequired: true, code: issued.code });
    expect(retry.deliveryId).not.toBe(issued.deliveryId);
    await expect(f.auth.recordDelivery({ challengeId: issued.challengeId, deliveryId: issued.deliveryId!, browserSecret: f.input.browserSecret, sent: true }, f.now + OWNER_CODE_RESEND_MS))
      .rejects.toMatchObject({ code: "unavailable" });
    await f.auth.recordDelivery({ challengeId: retry.challengeId, deliveryId: retry.deliveryId!, browserSecret: f.input.browserSecret, sent: true }, f.now + OWNER_CODE_RESEND_MS);
    expect(await f.auth.issue(f.input, f.now + OWNER_CODE_RESEND_MS)).toMatchObject({ sendRequired: false, deliveryStatus: "sent" });
  });

  it("requires a new code when an expired recovery attempt and challenge are recreated with the old browser proof", async () => {
    const f = fixture();
    const input: OwnerCodeRequest = { ...f.input, email: "recovery-replay@example.com", browserSecret: "d".repeat(64) };
    const loginCode = await f.auth.issue(input, f.now);
    const principal = await f.auth.verify({ ...input, code: loginCode.code, sessionSecret: f.sessionSecret }, f.now);
    const accounts = new AccountStore(db, "example.com");
    const space = await accounts.reserveInstallation({ principalId: principal.principalId,
      operationId: crypto.randomUUID(), handle: "recovery-replay" });
    await db.prepare("UPDATE installations SET state = 'active' WHERE id = ?").bind(space.installationId).run();
    const owners = new InstallationOwnerStore(db, "unrelated-registry");
    const attempt = "20000000-0000-4000-8000-000000000001";
    const recover = { ...input, challengeId: attempt, purpose: "recover" as const, ownerAttemptId: attempt };
    const start = async (now: number) => {
      await owners.beginRecovery(space.handle, attempt, now);
      await owners.startEmailAuthentication(attempt, { browserSecretHash: await sha256Hex(input.browserSecret) }, now);
    };
    const now = f.now + OWNER_CODE_RESEND_MS;
    await start(now);
    const random = vi.spyOn(crypto, "randomUUID").mockReturnValueOnce("30000000-0000-4000-8000-000000000001");
    try {
      const issued = await f.auth.issue(recover, now);
      const first = await f.auth.verify({ ...recover, code: issued.code, sessionSecret: "e".repeat(64) }, now);
      await owners.verifyPrincipal(attempt, await sha256Hex(input.browserSecret), first.principalId, now);
      const later = now + OWNER_CODE_TTL_MS;
      await f.auth.cleanup(later);
      expect(await owners.get(attempt)).toBeNull();
      await start(later);
      random.mockReturnValueOnce("30000000-0000-4000-8000-000000000002");
      const next = await f.auth.issue(recover, later);
      expect(next.code).not.toBe(issued.code);
      await expect(f.auth.verify({ ...recover, code: issued.code, sessionSecret: "f".repeat(64) }, later)).rejects.toMatchObject({ code: "invalid" });
      expect((await owners.get(attempt))?.state).toBe("authenticating");
      await expect(f.auth.verify({ ...recover, code: next.code, sessionSecret: "f".repeat(64) }, later))
        .resolves.toMatchObject({ principalId: principal.principalId, verifiedAt: later });
    } finally {
      random.mockRestore();
    }
  });

  it("resends a delivered code only on explicit request, after cooldown and within the same quotas", async () => {
    const f = fixture();
    const issued = await f.auth.issue(f.input, f.now);
    await f.auth.recordDelivery({ challengeId: issued.challengeId, deliveryId: issued.deliveryId!, browserSecret: f.input.browserSecret, sent: true }, f.now);
    expect(await f.auth.issue({ ...f.input, resend: true }, f.now + 1)).toMatchObject({ sendRequired: false, deliveryStatus: "sent" });
    expect(await f.auth.issue(f.input, f.now + OWNER_CODE_RESEND_MS)).toMatchObject({ sendRequired: false, deliveryStatus: "sent" });
    for (let index = 1; index < 5; index++) {
      const now = f.now + index * OWNER_CODE_RESEND_MS;
      const resent = await f.auth.issue({ ...f.input, resend: true }, now);
      expect(resent).toMatchObject({ sendRequired: true, code: issued.code, expiresAt: issued.expiresAt });
      await f.auth.recordDelivery({ challengeId: resent.challengeId, deliveryId: resent.deliveryId!, browserSecret: f.input.browserSecret, sent: true }, now);
    }
    await expect(f.auth.issue({ ...f.input, resend: true }, f.now + 5 * OWNER_CODE_RESEND_MS))
      .rejects.toMatchObject({ code: "rate_limited", retryAt: f.now + 60 * 60 * 1000 });
  });

  it("enforces email send limits across browsers and restarts without letting duplicate posts bypass them", async () => {
    const f = fixture();
    const challenges = [];
    for (let index = 0; index < 5; index++) {
      challenges.push(await new InstallationOwnerAuthStore(db, codeSecret).issue({ ...f.input, challengeId: crypto.randomUUID(), browserSecret: browserSecret() },
        f.now + index * OWNER_CODE_RESEND_MS));
    }
    await expect(f.auth.issue({ ...f.input, challengeId: crypto.randomUUID(), browserSecret: browserSecret() }, f.now + 5 * OWNER_CODE_RESEND_MS))
      .rejects.toMatchObject({ code: "rate_limited", retryAt: f.now + 60 * 60 * 1000 });
    expect(challenges).toHaveLength(5);
  });

  it("enforces the shared IP limit atomically across different email addresses", async () => {
    const f = fixture();
    const results = await Promise.allSettled(Array.from({ length: 21 }, (_, index) => f.auth.issue({ ...f.input,
      challengeId: crypto.randomUUID(), email: `${index}-${f.input.email}` }, f.now)));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(20);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    await expect(f.auth.issue({ ...f.input, challengeId: crypto.randomUUID(), email: `later-${f.input.email}` }, f.now + 60 * 60 * 1000))
      .resolves.toMatchObject({ sendRequired: true });
  });

  it("does not enable email authentication for an existing OIDC principal with the same email", async () => {
    const f = fixture();
    const principalId = `principal_oidc_${crypto.randomUUID()}`;
    await new AccountStore(db, "example.com").createPrincipal({ principalId, email: f.input.email, displayName: "Existing external owner", verified: true });
    await db.prepare("INSERT INTO principal_external_identities (issuer, subject, principal_id, created_at) VALUES (?, ?, ?, ?)")
      .bind("https://identity.example.com", "external-subject", principalId, f.now).run();
    const issued = await f.auth.issue(f.input, f.now);
    await expect(f.auth.verify({ ...f.input, code: issued.code, sessionSecret: f.sessionSecret }, f.now))
      .rejects.toMatchObject({ code: "credential_unavailable" });
    expect(await db.prepare("SELECT * FROM principal_email_credentials WHERE email_normalized = ?").bind(f.input.email).first()).toBeNull();
    expect(await db.prepare("SELECT principal_id FROM principal_external_identities WHERE issuer = ? AND subject = ?")
      .bind("https://identity.example.com", "external-subject").first()).toEqual({ principal_id: principalId });
  });

  it("revokes and expires sessions without allowing a verification retry to recreate them", async () => {
    const f = await login();
    expect(await f.auth.session(f.sessionSecret, f.now + OWNER_SESSION_TTL_MS)).toBeNull();
    await f.auth.logout(f.sessionSecret, f.now + 1);
    expect(await f.auth.session(f.sessionSecret, f.now + 2)).toBeNull();
    await f.auth.cleanup(f.now + 2, 1);
    await expect(f.auth.verify({ ...f.input, code: f.issued.code, sessionSecret: f.sessionSecret }, f.now + 2))
      .rejects.toMatchObject({ code: "unavailable" });
    const other = await login();
    await db.prepare("UPDATE principals SET state = 'disabled' WHERE id = ?").bind(other.receipt.principalId).run();
    expect(await other.auth.session(other.sessionSecret, other.now)).toBeNull();
    await expect(other.auth.receipt({ receiptId: other.receipt.receiptId, ...other.input }, other.now)).rejects.toMatchObject({ code: "unavailable" });
  });

  it("reuses only an explicit native principal and never slides an existing session's expiry", async () => {
    const f = await login();
    const now = f.now + OWNER_CODE_RESEND_MS;
    const input = { ...f.input, challengeId: crypto.randomUUID(), browserSecret: browserSecret() };
    const issued = await f.auth.issue(input, now);
    const secondSession = browserSecret();
    const receipt = await f.auth.verify({ ...input, code: issued.code, sessionSecret: secondSession }, now);
    expect(receipt.principalId).toBe(f.receipt.principalId);
    expect((await f.auth.session(f.sessionSecret, now))?.expiresAt).toBe(f.now + OWNER_SESSION_TTL_MS);
    expect((await f.auth.session(secondSession, now))?.expiresAt).toBe(now + OWNER_SESSION_TTL_MS);
    await db.prepare("UPDATE principal_email_credentials SET revoked_at = ? WHERE principal_id = ?").bind(now, receipt.principalId).run();
    expect(await f.auth.session(f.sessionSecret, now)).toBeNull();
    expect(await f.auth.session(secondSession, now)).toBeNull();
  });

  it("cleans expired records in bounded batches while retaining a live owner's global credential", async () => {
    const f = await login();
    const before = await db.prepare("SELECT COUNT(*) AS count FROM owner_auth_challenges").first<{ count: number }>();
    const removed = await f.auth.cleanup(f.now + OWNER_SESSION_TTL_MS, 1);
    expect(removed).toBeLessThanOrEqual(4);
    expect(removed).toBeGreaterThan(0);
    const after = await db.prepare("SELECT COUNT(*) AS count FROM owner_auth_challenges").first<{ count: number }>();
    expect(before!.count - after!.count).toBe(1);
    expect(await db.prepare("SELECT principal_id FROM principal_email_credentials WHERE email_normalized = ?").bind(f.input.email).first())
      .toEqual({ principal_id: f.receipt.principalId });
    await expect(f.auth.cleanup(f.now, 101)).rejects.toMatchObject({ code: "invalid" });
  });

  it("cleans abandoned owner attempts without cascading an unbounded challenge batch", async () => {
    const f = await ownerFixture("recover");
    const issued = await f.auth.issue(f.input, f.now);
    const expiry = f.now + OWNER_CODE_TTL_MS;
    await db.prepare(`INSERT INTO owner_auth_challenges (id, email, purpose, owner_attempt_id, browser_secret_hash, code_generation,
      code_verifier, created_at, expires_at, delivery_id, delivery_status, delivery_lease_until)
      SELECT ?, email, purpose, owner_attempt_id, browser_secret_hash, code_generation, code_verifier, created_at, expires_at,
        ?, delivery_status, delivery_lease_until FROM owner_auth_challenges WHERE id = ?`)
      .bind(crypto.randomUUID(), crypto.randomUUID(), issued.challengeId).run();
    const abandoned = [crypto.randomUUID(), crypto.randomUUID()];
    for (const [index, id] of abandoned.entries()) {
      await db.prepare(`INSERT INTO installation_owner_attempts (id, installation_id, purpose, expected_owner_id, state, created_at, expires_at)
        VALUES (?, ?, 'recover', ?, 'pending', ?, ?)`)
        .bind(id, f.reserved.installationId, f.receipt.principalId, f.now, expiry - 2 + index).run();
    }
    const before = (await db.prepare("SELECT COUNT(*) AS count FROM owner_auth_challenges").first<{ count: number }>())!.count;
    expect(await f.auth.cleanup(expiry, 1)).toBeLessThanOrEqual(4);
    const after = (await db.prepare("SELECT COUNT(*) AS count FROM owner_auth_challenges").first<{ count: number }>())!.count;
    expect(before - after).toBe(1);
    expect(await f.owner.get(abandoned[0])).toBeNull();
    expect(await f.owner.get(abandoned[1])).not.toBeNull();
    expect(await f.owner.get(f.input.ownerAttemptId!)).not.toBeNull();
    await f.auth.cleanup(expiry, 100);
    expect(await f.owner.get(f.input.ownerAttemptId!)).toBeNull();
    expect(await f.owner.get(abandoned[1])).toBeNull();
    expect(await f.auth.session(f.sessionSecret, expiry)).toMatchObject({ principalId: f.receipt.principalId });
  });

  it.each(["link", "recover"] as const)("cascades %s challenges only for the deleted space, retaining global credentials and another space", async (purpose) => {
    const f = await ownerFixture(purpose);
    const issued = await f.auth.issue(f.input, f.now);
    const sessionSecret = browserSecret();
    await f.auth.verify({ ...f.input, code: issued.code, sessionSecret }, f.now);
    const accounts = new AccountStore(db, "example.com");
    const other = await accounts.reserveInstallation({ principalId: f.receipt.principalId,
      operationId: crypto.randomUUID(), handle: `other-${crypto.randomUUID().slice(0, 8)}` });
    await db.prepare("UPDATE installations SET state = 'active' WHERE id = ?").bind(other.installationId).run();
    const otherAttempt = await f.owner.beginRecovery(other.handle, crypto.randomUUID(), f.now);
    const otherBrowser = browserSecret();
    await f.owner.startEmailAuthentication(otherAttempt.id, { browserSecretHash: await sha256Hex(otherBrowser) }, f.now);
    const otherInput = { ...f.input, challengeId: crypto.randomUUID(), browserSecret: otherBrowser,
      purpose: "recover" as const, ownerAttemptId: otherAttempt.id };
    const otherIssued = await f.auth.issue(otherInput, f.now + OWNER_CODE_RESEND_MS);
    // The Accounts deletion owner removes this space's attempts before deleting its directory row.
    await db.prepare("DELETE FROM installation_owner_attempts WHERE installation_id = ?").bind(f.reserved.installationId).run();
    expect(await db.prepare("SELECT * FROM owner_auth_challenges WHERE id = ?").bind(issued.challengeId).first()).toBeNull();
    expect(await f.owner.get(otherAttempt.id)).not.toBeNull();
    expect(await f.auth.verify({ ...otherInput, code: otherIssued.code, sessionSecret: browserSecret() }, f.now + OWNER_CODE_RESEND_MS))
      .toMatchObject({ principalId: f.receipt.principalId, ownerAttemptId: otherAttempt.id });
    expect(await f.auth.session(sessionSecret, f.now + OWNER_CODE_RESEND_MS)).toMatchObject({ principalId: f.receipt.principalId });
    expect(await f.auth.session(f.sessionSecret, f.now + OWNER_CODE_RESEND_MS)).toMatchObject({ principalId: f.receipt.principalId });
    expect(await accounts.resolveInstallation(other.installationId)).toMatchObject({ found: true, state: "active" });
  });

  it("binds fresh link receipts to the exact attested browser/attempt and removes them with deleted owner attempts", async () => {
    const f = await ownerFixture("link");
    const issued = await f.auth.issue(f.input, f.now);
    const sessionSecret = browserSecret();
    const input = { ...f.input, code: issued.code, sessionSecret };
    await expect(f.auth.verify({ ...input, purpose: "login", ownerAttemptId: undefined }, f.now)).rejects.toMatchObject({ code: "unavailable" });
    const receipt = await f.auth.verify(input, f.now);
    expect(receipt).toMatchObject({ purpose: "link", ownerAttemptId: f.input.ownerAttemptId, principalId: f.receipt.principalId });
    await expect(f.auth.receipt({ receiptId: receipt.receiptId, ...f.input, ownerAttemptId: crypto.randomUUID() }, f.now)).rejects.toMatchObject({ code: "unavailable" });
    await expect(f.auth.receipt({ receiptId: f.receipt.receiptId, ...f.input }, f.now)).rejects.toMatchObject({ code: "unavailable" });
    await db.batch([
      db.prepare("UPDATE installation_owner_attempts SET state = 'complete', principal_id = ? WHERE id = ?").bind(receipt.principalId, f.input.ownerAttemptId),
      db.prepare("UPDATE installations SET owner_principal_id = ? WHERE id = ?").bind(receipt.principalId, f.reserved.installationId),
    ]);
    expect(await f.auth.verify(input, f.now + 1)).toMatchObject({ principalId: receipt.principalId, verifiedAt: f.now });
    await db.prepare("DELETE FROM installation_owner_attempts WHERE id = ?").bind(f.input.ownerAttemptId).run();
    expect(await db.prepare("SELECT * FROM owner_auth_challenges WHERE id = ?").bind(receipt.receiptId).first()).toBeNull();
    await expect(f.auth.receipt({ receiptId: receipt.receiptId, ...f.input }, f.now + 2)).rejects.toMatchObject({ code: "unavailable" });
    expect(await f.auth.session(sessionSecret, f.now + 2)).toMatchObject({ principalId: receipt.principalId });
  });

  it("sends recovery codes only to the existing native owner and fences changes before verification", async () => {
    const f = await ownerFixture("recover");
    await expect(f.auth.issue({ ...f.input, email: `other-${f.input.email}` }, f.now)).rejects.toBeDefined();
    const issued = await f.auth.issue(f.input, f.now);
    await db.prepare("UPDATE installations SET state = 'retained' WHERE id = ?").bind(f.reserved.installationId).run();
    await expect(f.auth.verify({ ...f.input, code: issued.code, sessionSecret: browserSecret() }, f.now)).rejects.toMatchObject({ code: "unavailable" });
    expect(await db.prepare("SELECT verified_at FROM owner_auth_challenges WHERE id = ?").bind(issued.challengeId).first()).toEqual({ verified_at: null });
  });
});
