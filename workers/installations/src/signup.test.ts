import { env } from "cloudflare:workers";
import type { D1Migration } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { telemetryRecordSchema } from "@humansandmachines/gsv/telemetry";
import { AccountStore } from "./store";
import { InstallationOnboardingStore } from "./onboarding";
import { InstallationSignup } from "./signup";

const db = env.INSTALLATIONS_DB;
const accounts = new AccountStore(db, "example.com");
const onboarding = new InstallationOnboardingStore(db, accounts, "signup-test-secret-".repeat(4));
const signup = new InstallationSignup(db, accounts, onboarding, true);
const handle = () => `space-${crypto.randomUUID()}`;
async function owner(verified = true) {
  const id = `owner_${crypto.randomUUID()}`;
  await accounts.createPrincipal({ principalId: id, email: `${id}@example.com`, displayName: "Owner", verified });
  return id;
}

describe("open registration", () => {
  it("preserves setup admitted by an older worker after the migration", async () => {
    const principalId = await owner(), operationId = `invite_${crypto.randomUUID()}`, name = handle();
    await db.prepare(`INSERT INTO installation_creation_invites
      (id, token_hash, token_prefix, created_at, principal_id, claimed_at, updated_at)
      VALUES (?, ?, 'retired', 1, ?, 1, 1)`).bind(operationId, crypto.randomUUID(), principalId).run();
    const space = await accounts.reserveInstallation({ principalId, operationId, handle: name });
    expect(await signup.pending(principalId)).toEqual([]);
    await db.prepare("UPDATE installation_creation_invites SET installation_id = ? WHERE id = ?")
      .bind(space.installationId, operationId).run();
    expect(await signup.pending(principalId)).toEqual([{ operationId, handle: name, origin: space.canonicalOrigin }]);
    const prepared = await Promise.all([signup.prepare(operationId, principalId, name), signup.prepare(operationId, principalId, name)]);
    expect(prepared[0].onboardingToken).toBe(prepared[1].onboardingToken);
    expect(await onboarding.authorize({ installationId: space.installationId, token: prepared[0].onboardingToken! })).toMatchObject({ ok: true });
  });

  it("migrates unfinished code-based setup into the same owner recovery flow", async () => {
    const principalId = await owner(), operationId = `invite_${crypto.randomUUID()}`, name = handle();
    const space = await accounts.reserveInstallation({ principalId, operationId, handle: name });
    await db.prepare(`INSERT INTO installation_creation_invites
      (id, token_hash, token_prefix, created_at, principal_id, claimed_at, installation_id, updated_at)
      VALUES (?, ?, 'retired', 1, ?, 1, ?, 1)`)
      .bind(operationId, crypto.randomUUID(), principalId, space.installationId).run();
    // SAFETY: The test configuration supplies the exact shipped migration statements.
    const migrations = (env as Env & { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS;
    const migration = migrations.find((item) => item.name === "0023_open_signup.sql")!;
    await db.batch(migration.queries.slice(1).map((query) => db.prepare(query)));
    expect(await signup.pending(principalId)).toEqual([{ operationId, handle: name, origin: space.canonicalOrigin }]);
    expect((await signup.prepare(operationId, principalId, name)).onboardingToken).toBeTruthy();
  });

  it("requires a verified owner and rejects closed registration without allocating state", async () => {
    await expect(signup.prepare(crypto.randomUUID(), await owner(false), handle())).rejects.toThrow("Verified owner");
    const operationId = crypto.randomUUID();
    await expect(new InstallationSignup(db, accounts, onboarding, false).prepare(operationId, await owner(), handle())).rejects.toThrow("closed");
    expect(await accounts.getReservationByOperation(operationId)).toBeNull();
  });

  it("checks email policy before allocation while preserving already-admitted setups", async () => {
    const principalId = await owner(), operationId = crypto.randomUUID(), name = handle();
    const policy = { allowsEmail: () => false, prepare: vi.fn(async () => {}) };
    const restricted = new InstallationSignup(db, accounts, onboarding, true, policy);
    await expect(restricted.prepare(operationId, principalId, name)).rejects.toMatchObject({ code: "email_restricted" });
    expect(await accounts.getReservationByOperation(operationId)).toBeNull();
    expect(policy.prepare).not.toHaveBeenCalled();
    const first = await signup.prepare(operationId, principalId, name);
    expect((await restricted.prepare(operationId, principalId, name)).onboardingToken).toBe(first.onboardingToken);
  });

  it("resumes the same setup after reopening without a signup code", async () => {
    const principalId = await owner(), operationId = crypto.randomUUID(), name = handle();
    const first = await signup.prepare(operationId, principalId, name);
    const space = (await accounts.getReservationByOperation(operationId))!;
    expect(await accounts.resolveHostname(`${name}.example.com`)).toMatchObject({ ownerSetupRecovery: true });
    expect(await signup.pending(principalId)).toEqual([{ operationId, handle: name, origin: first.origin }]);
    const again = await new InstallationSignup(db, accounts, onboarding, false).prepare(operationId, principalId, name);
    expect(again.origin).toBe(first.origin);
    const authorization = await onboarding.authorize({ installationId: space.installationId, token: again.onboardingToken! });
    if (!authorization.ok) throw new Error("Expected authorization");
    await onboarding.complete({ installationId: space.installationId, claimId: authorization.claimId });
    expect((await signup.prepare(operationId, principalId, name)).onboardingToken).toBeNull();
    expect(await signup.pending(principalId)).toEqual([]);
    await expect(signup.prepare(operationId, await owner(), name)).rejects.toThrow("different reservation");
    expect(await db.prepare("SELECT COUNT(*) AS count FROM installations WHERE owner_principal_id = ?").bind(principalId).first()).toEqual({ count: 1 });
  });

  it("atomically allows one self-service space even with concurrent requests from different clients", async () => {
    const principalId = await owner();
    const outcomes = await Promise.allSettled([signup.prepare(crypto.randomUUID(), principalId, handle()), signup.prepare(crypto.randomUUID(), principalId, handle())]);
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await db.prepare("SELECT COUNT(*) AS count FROM installations WHERE owner_principal_id = ?").bind(principalId).first()).toEqual({ count: 1 });
  });

  it("resumes setup concurrently after its preferred-domain alias has been opened", async () => {
    const principalId = await owner(), operationId = crypto.randomUUID(), name = handle();
    const legacy = new AccountStore(db, "old.example");
    const space = await legacy.reserveInstallation({ principalId, operationId, handle: name, ownerSetup: true });
    const current = new AccountStore(db, "new.example", undefined, [], ["old.example"]);
    expect(await current.resolveHostname(`${name}.new.example`)).toMatchObject({ installationId: space.installationId, state: "reserved" });
    const claims = new InstallationOnboardingStore(db, current, "signup-test-secret-".repeat(4));
    const resumed = new InstallationSignup(db, current, claims, false);
    const results = await Promise.all([resumed.prepare(operationId, principalId, name), resumed.prepare(operationId, principalId, name)]);
    expect(results[0]).toEqual(results[1]);
    expect(results[0].origin).toBe(`https://${name}.old.example`);
    const authorization = await claims.authorize({ installationId: space.installationId, token: results[0].onboardingToken! });
    if (!authorization.ok) throw new Error("Expected onboarding authorization");
    await claims.complete({ installationId: space.installationId, claimId: authorization.claimId });
    for (const domain of ["old.example", "new.example"]) {
      expect(await current.resolveHostname(`${name}.${domain}`)).toMatchObject({ installationId: space.installationId, state: "active" });
    }
  });

  it("keeps an unavailable handle retryable and does not adopt an operator setup", async () => {
    const name = handle();
    await accounts.reserveInstallation({ principalId: await owner(), operationId: crypto.randomUUID(), handle: name });
    const principalId = await owner(), operationId = crypto.randomUUID();
    await expect(signup.prepare(operationId, principalId, name)).rejects.toThrow("handle is unavailable");
    expect(await accounts.getReservationByOperation(operationId)).toBeNull();
    expect((await signup.prepare(operationId, principalId, handle())).onboardingToken).toBeTruthy();
    const operatorOwner = await owner();
    const operator = await accounts.reserveInstallation({ principalId: operatorOwner, operationId: crypto.randomUUID(), handle: handle() });
    await expect(signup.prepare(operator.operationId, operatorOwner, operator.handle)).rejects.toThrow("unavailable");
  });

  it("retains policy failures for inspection and only issues setup after policy succeeds", async () => {
    const principalId = await owner(), operationId = crypto.randomUUID(), name = handle();
    const policy = { prepare: vi.fn(async (): Promise<void> => { throw new Error("Plan service unavailable"); }) };
    const managed = new InstallationSignup(db, accounts, onboarding, true, policy);
    await expect(managed.prepare(operationId, principalId, name)).rejects.toThrow("Reference:");
    const space = (await accounts.getReservationByOperation(operationId))!;
    expect(space.state).toBe("reserved");
    expect(await db.prepare("SELECT 1 FROM installation_onboarding_claims WHERE installation_id = ?").bind(space.installationId).first()).toBeNull();
    const failure = await db.prepare("SELECT last_error FROM provisioning_operations WHERE operation_id = ?").bind(operationId).first<{ last_error: string }>();
    expect(JSON.parse(failure!.last_error)).toMatchObject({ diagnosticId: expect.any(String), exceptionMessage: "Plan service unavailable" });
    await db.prepare("UPDATE installations SET reservation_expires_at = 1 WHERE id = ?").bind(space.installationId).run();
    policy.prepare.mockResolvedValue(undefined);
    expect((await managed.prepare(operationId, principalId, name)).onboardingToken).toBeTruthy();
  });

  it("reports a failed activation to telemetry under the reference it keeps", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const principalId = await owner(), operationId = crypto.randomUUID();
    const policy = { prepare: async (): Promise<void> => { throw new Error("Plan service unavailable"); } };
    const managed = new InstallationSignup(db, accounts, onboarding, true, policy, { GSV_TELEMETRY_ENABLED: "1" });
    await expect(managed.prepare(operationId, principalId, handle())).rejects.toThrow("Reference:");
    const space = (await accounts.getReservationByOperation(operationId))!;
    const failure = await db.prepare("SELECT last_error FROM provisioning_operations WHERE operation_id = ?").bind(operationId).first<{ last_error: string }>();
    const records = log.mock.calls.flatMap(([value]) => {
      const record = telemetryRecordSchema.safeParse(value);
      return record.success ? [record.data] : [];
    });
    expect(records).toEqual([expect.objectContaining({
      component: "accounts", installationId: space.installationId,
      event: { stream: "operational", name: "installation.setup.failed", properties: expect.objectContaining({
        diagnosticId: JSON.parse(failure!.last_error).diagnosticId, stage: "activation", outcome: "failed",
      }) },
    })]);
    expect(warn).not.toHaveBeenCalled();
    log.mockRestore();
    warn.mockRestore();
  });
});
