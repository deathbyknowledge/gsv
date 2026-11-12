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
    expect(records.filter((record) => record.event.stream === "operational")).toEqual([expect.objectContaining({
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

describe("signup attribution", () => {
  const spyLog = () => vi.spyOn(console, "log").mockImplementation(() => {});
  const recorded = (log: ReturnType<typeof spyLog>) => log.mock.calls.flatMap(([value]) => {
    const record = telemetryRecordSchema.safeParse(value);
    return record.success ? [record.data.event] : [];
  });
  const reporting = new InstallationSignup(db, accounts, onboarding, true, undefined, { GSV_TELEMETRY_ENABLED: "1" });

  it("reports where a signup came from once, when the reservation is first created", async () => {
    const log = spyLog();
    try {
      const principalId = await owner(), operationId = crypto.randomUUID(), name = handle();
      await reporting.prepare(operationId, principalId, name, { placement: "hero", example: "tickets", utmSource: "facebook", utmCampaign: "launch" });
      await reporting.prepare(operationId, principalId, name, { placement: "final-call" });
      await reporting.prepare(operationId, principalId, name);
      expect(recorded(log).filter((event) => event.name === "installation.attributed")).toEqual([{
        stream: "product", name: "installation.attributed",
        properties: { origin: "website", placement: "hero", example: "tickets", utmSource: "facebook", utmCampaign: "launch" },
      }]);
    } finally {
      log.mockRestore();
    }
  });

  it("reports a campaign signup and a direct signup by their origin", async () => {
    const log = spyLog();
    try {
      await reporting.prepare(crypto.randomUUID(), await owner(), handle(), { utmSource: "facebook" });
      await reporting.prepare(crypto.randomUUID(), await owner(), handle());
      expect(recorded(log).filter((event) => event.name === "installation.attributed").map((event) => event.properties)).toEqual([
        { origin: "campaign", utmSource: "facebook" }, { origin: "direct" },
      ]);
    } finally {
      log.mockRestore();
    }
  });
});

describe("signup inviter", () => {
  async function ship(state: "active" | "restricted" = "active", principalId?: string) {
    const ownerId = principalId ?? await owner();
    const space = await accounts.reserveInstallation({ principalId: ownerId, operationId: crypto.randomUUID(), handle: handle() });
    await db.batch([
      db.prepare("UPDATE installations SET state = ? WHERE id = ?").bind(state, space.installationId),
      db.prepare("UPDATE hostnames SET state = 'active' WHERE installation_id = ?").bind(space.installationId),
    ]);
    return { installationId: space.installationId, hostname: `${space.handle}.example.com` };
  }
  const inviterOf = async (operationId: string) => (await db.prepare(
    "SELECT inviter_installation_id FROM provisioning_operations WHERE operation_id = ?",
  ).bind(operationId).first<{ inviter_installation_id: string | null }>())!;

  it("records an active Ship someone else owns and reports the signup as invited, keeping the website's slugs", async () => {
    const inviter = await ship();
    const principalId = await owner(), operationId = crypto.randomUUID();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const reporting = new InstallationSignup(db, accounts, onboarding, true, undefined, { GSV_TELEMETRY_ENABLED: "1" });
      await reporting.prepare(operationId, principalId, handle(), { placement: "hero" }, inviter.hostname);
      const events = log.mock.calls.flatMap(([value]) => {
        const record = telemetryRecordSchema.safeParse(value);
        return record.success && record.data.event.name === "installation.attributed" ? [record.data.event.properties] : [];
      });
      expect(events).toEqual([{ origin: "invite", placement: "hero" }]);
      expect(JSON.stringify(log.mock.calls)).not.toContain(inviter.installationId);
    } finally {
      log.mockRestore();
    }
    expect((await inviterOf(operationId)).inviter_installation_id).toBe(inviter.installationId);
  });

  it("drops an unknown or inactive Ship without failing the signup", async () => {
    const restricted = await ship("restricted");
    for (const hostname of ["nobody-here.example.com", restricted.hostname]) {
      const principalId = await owner(), operationId = crypto.randomUUID();
      await expect(signup.prepare(operationId, principalId, handle(), undefined, hostname)).resolves.toMatchObject({ onboardingToken: expect.any(String) });
      expect((await inviterOf(operationId)).inviter_installation_id).toBeNull();
    }
  });

  it("never records a Ship as inviting its own owner, and keeps a reservation whose inviter vanished", async () => {
    const principalId = await owner();
    const own = await ship("active", principalId);
    // Operator allocation has no one-Ship limit, so the owner's own Ship can be offered as inviter and must be dropped by the insert.
    const operationId = crypto.randomUUID();
    await accounts.reserveInstallation({ principalId, operationId, handle: handle(), inviterInstallationId: own.installationId });
    expect((await inviterOf(operationId)).inviter_installation_id).toBeNull();
    // An inviter erased between the lookup and the write leaves the reservation intact, without an inviter.
    const gone = crypto.randomUUID();
    await expect(accounts.reserveInstallation({ principalId, operationId: gone, handle: handle(), inviterInstallationId: "inst_gone" }))
      .resolves.toMatchObject({ state: "reserved" });
    expect((await inviterOf(gone)).inviter_installation_id).toBeNull();
  });

  it("keeps the first request's inviter when a resumed signup carries another or none", async () => {
    const first = await ship(), second = await ship();
    const principalId = await owner(), operationId = crypto.randomUUID(), name = handle();
    await signup.prepare(operationId, principalId, name, undefined, first.hostname);
    await signup.prepare(operationId, principalId, name, undefined, second.hostname);
    await signup.prepare(operationId, principalId, name);
    expect((await inviterOf(operationId)).inviter_installation_id).toBe(first.installationId);
    const directOwner = await owner(), direct = crypto.randomUUID(), directName = handle();
    await signup.prepare(direct, directOwner, directName);
    await signup.prepare(direct, directOwner, directName, undefined, first.hostname);
    expect((await inviterOf(direct)).inviter_installation_id).toBeNull();
  });
});
