import { env } from "cloudflare:workers";
import type { D1Migration } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { telemetryRecordSchema } from "@humansandmachines/gsv/telemetry";
import { InstallationOnboardingStore } from "./onboarding";
import { AccountStore } from "./store";
import { createOpaqueToken } from "./tokens";

async function provisioningInstallation(suffix: string): Promise<{
  accounts: AccountStore;
  onboarding: InstallationOnboardingStore;
  installationId: string;
}> {
  const accounts = new AccountStore(env.INSTALLATIONS_DB, "gsv.space");
  const principalId = `principal_onboarding_${suffix}`;
  await accounts.createPrincipal({
    principalId,
    email: `onboarding-${suffix}@example.com`,
    displayName: `Onboarding ${suffix}`,
    verified: true,
  });
  const reservation = await accounts.reserveInstallation({
    principalId,
    operationId: `operation_onboarding_${suffix}`,
    handle: `onboarding-${suffix}`,
  });
  await accounts.beginProvisioning(reservation.operationId, principalId);
  return {
    accounts,
    onboarding: new InstallationOnboardingStore(env.INSTALLATIONS_DB, accounts),
    installationId: reservation.installationId,
  };
}

describe("installation onboarding claims", () => {
  it("preserves a pre-fence bearer without extending it, while admin reissue revokes both", async () => {
    const fixture = await provisioningInstallation("pre-fence");
    const db = env.INSTALLATIONS_DB;
    await db.prepare("UPDATE installations SET owner_setup = 1 WHERE id = ?").bind(fixture.installationId).run();
    // Reconstruct the pre-upgrade schema and commit the old request before installing the fence.
    await db.batch([
      "DROP TRIGGER installation_onboarding_claims_issuer_insert",
      "ALTER TABLE installation_onboarding_claims DROP COLUMN issuer_version",
      "ALTER TABLE installation_onboarding_claims DROP COLUMN legacy_token_hash",
      "ALTER TABLE installation_onboarding_claims DROP COLUMN legacy_expires_at",
    ].map((sql) => db.prepare(sql)));
    const legacy = await createOpaqueToken("onboard");
    const now = Date.now(), expiresAt = now + 60_000;
    await db.prepare(`INSERT INTO installation_onboarding_claims
      (id, installation_id, token_prefix, token_hash, expires_at, completed_at, revoked_at, created_at)
      VALUES ('onboarding_pre_fence', ?, ?, ?, ?, NULL, NULL, ?)`)
      .bind(fixture.installationId, legacy.prefix, legacy.hash, expiresAt, now).run();
    // SAFETY: The test configuration supplies the exact shipped migration statements.
    const migrations = (env as Env & { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS;
    for (const name of ["0025_onboarding_issuer.sql", "0026_onboarding_rollout_bearer.sql"]) {
      await db.batch(migrations.find((migration) => migration.name === name)!.queries.map((sql) => db.prepare(sql)));
    }
    const onboarding = new InstallationOnboardingStore(db, fixture.accounts, "pre-fence-test-secret-".repeat(4));
    const resumed = await onboarding.begin(fixture.installationId, now + 1, "resume");
    const current = new URL(resumed.onboardingUrl).hash.slice(1);
    const authorize = (token: string, time = now + 2) => onboarding.authorize({ installationId: fixture.installationId, token }, time);
    expect(await authorize(legacy.raw)).toMatchObject({ ok: true, claimId: "onboarding_pre_fence" });
    expect(await authorize(current)).toEqual(await authorize(legacy.raw));
    expect(await authorize(legacy.raw, expiresAt)).toEqual({ ok: false });
    expect(await authorize(current, expiresAt)).toMatchObject({ ok: true });
    const reissued = await onboarding.begin(fixture.installationId, now + 3);
    expect(await authorize(current, now + 4)).toEqual({ ok: false });
    expect(await authorize(legacy.raw, now + 4)).toEqual({ ok: false });
    expect(await authorize(new URL(reissued.onboardingUrl).hash.slice(1), now + 4)).toMatchObject({ ok: true });
    expect(await onboarding.begin(fixture.installationId, now + 5, "resume")).toEqual(reissued);
  });

  it("rejects old-worker issuance before and after a new owner setup claim", async () => {
    const fixture = await provisioningInstallation("old-issuer");
    const db = env.INSTALLATIONS_DB;
    await db.prepare("UPDATE installations SET owner_setup = 1 WHERE id = ?").bind(fixture.installationId).run();
    const oldIssue = () => db.prepare(`INSERT INTO installation_onboarding_claims
      (id, installation_id, token_prefix, token_hash, expires_at, completed_at, revoked_at, created_at)
      VALUES (?, ?, 'legacy', 'legacy-hash', ?, NULL, NULL, ?)
      ON CONFLICT (installation_id) DO UPDATE SET
        token_prefix = excluded.token_prefix, token_hash = excluded.token_hash,
        expires_at = excluded.expires_at, completed_at = NULL, revoked_at = NULL, created_at = excluded.created_at`)
      .bind(`onboarding_${crypto.randomUUID()}`, fixture.installationId, Date.now() + 60_000, Date.now()).run();
    await expect(oldIssue()).rejects.toThrow("onboarding issuer has changed");
    const onboarding = new InstallationOnboardingStore(db, fixture.accounts, "onboarding-rollout-test-".repeat(4));
    const issued = await onboarding.begin(fixture.installationId, Date.now(), "resume");
    await expect(oldIssue()).rejects.toThrow("onboarding issuer has changed");
    expect(await onboarding.begin(fixture.installationId, Date.now(), "resume")).toEqual(issued);
    expect(await onboarding.authorize({ installationId: fixture.installationId, token: new URL(issued.onboardingUrl).hash.slice(1) }))
      .toMatchObject({ ok: true });
  });

  it("resumes one usable bearer across concurrent clients and rotates only after expiry", async () => {
    const fixture = await provisioningInstallation("concurrent-resume");
    const secret = "onboarding-resume-test-".repeat(4);
    const firstStore = new InstallationOnboardingStore(env.INSTALLATIONS_DB, fixture.accounts, secret);
    const secondStore = new InstallationOnboardingStore(env.INSTALLATIONS_DB, fixture.accounts, secret);
    const now = Date.now();
    const first = await Promise.all([firstStore.begin(fixture.installationId, now, "resume"), secondStore.begin(fixture.installationId, now, "resume")]);
    expect(first[0]).toEqual(first[1]);
    const originalToken = new URL(first[0].onboardingUrl).hash.slice(1);
    const original = await firstStore.authorize({ installationId: fixture.installationId, token: originalToken });
    expect(original.ok).toBe(true);
    expect(await secondStore.begin(fixture.installationId, now + 1, "resume")).toEqual(first[0]);
    const renewed = await Promise.all([firstStore.begin(fixture.installationId, first[0].expiresAt, "resume"), secondStore.begin(fixture.installationId, first[0].expiresAt, "resume")]);
    expect(renewed[0]).toEqual(renewed[1]);
    const renewedToken = new URL(renewed[0].onboardingUrl).hash.slice(1);
    expect(renewedToken).not.toBe(originalToken);
    expect(await firstStore.authorize({ installationId: fixture.installationId, token: originalToken }, first[0].expiresAt)).toEqual({ ok: false });
    expect(await secondStore.authorize({ installationId: fixture.installationId, token: renewedToken }, first[0].expiresAt)).toEqual(original);
    const stored = await env.INSTALLATIONS_DB.prepare("SELECT token_hash FROM installation_onboarding_claims WHERE installation_id = ?")
      .bind(fixture.installationId).first<{ token_hash: string }>();
    expect(stored?.token_hash).not.toBe(renewedToken);
    if (!original.ok) throw new Error("Expected authorization");
    await firstStore.complete({ installationId: fixture.installationId, claimId: original.claimId });
    await expect(secondStore.begin(fixture.installationId)).rejects.toThrow("not awaiting onboarding");
  });

  it("authorizes only the capability bound to the provisioning installation", async () => {
    const fixture = await provisioningInstallation("authorize");
    const other = await provisioningInstallation("authorize-other");
    const issued = await fixture.onboarding.issue(fixture.installationId);
    const token = new URL(issued.onboardingUrl).hash.slice(1);

    await expect(fixture.onboarding.authorize({
      installationId: fixture.installationId,
      token,
    })).resolves.toMatchObject({
      ok: true,
      installation: {
        installationId: fixture.installationId,
        handle: "onboarding-authorize",
      },
    });
    await expect(fixture.onboarding.authorize({
      installationId: other.installationId,
      token,
    })).resolves.toEqual({ ok: false });
    await expect(fixture.onboarding.authorize({
      installationId: fixture.installationId,
      token,
    }, issued.expiresAt)).resolves.toEqual({ ok: false });

    const stored = await env.INSTALLATIONS_DB.prepare(
      `SELECT token_prefix, token_hash
       FROM installation_onboarding_claims
       WHERE installation_id = ?`,
    ).bind(fixture.installationId).first<{
      token_prefix: string;
      token_hash: string;
    }>();
    expect(stored?.token_prefix).toBe(token.slice(0, 16));
    expect(stored?.token_hash).not.toBe(token);
  });

  it("activates routing without mapping a directory principal into the Kernel", async () => {
    const fixture = await provisioningInstallation("complete");
    const issued = await fixture.onboarding.issue(fixture.installationId);
    const token = new URL(issued.onboardingUrl).hash.slice(1);
    const authorization = await fixture.onboarding.authorize({
      installationId: fixture.installationId,
      token,
    });
    if (!authorization.ok) throw new Error("claim was not authorized");

    await fixture.onboarding.complete({
      claimId: authorization.claimId,
      installationId: fixture.installationId,
    });
    await expect(fixture.accounts.resolveHostname(
      "onboarding-complete.gsv.space",
    )).resolves.toMatchObject({ found: true, state: "active" });
    const membership = await env.INSTALLATIONS_DB.prepare(
      `SELECT principal_id, state FROM memberships WHERE installation_id = ?`,
    ).bind(fixture.installationId).first<{
      principal_id: string;
      state: string;
    }>();
    expect(membership).toEqual({
      principal_id: "principal_onboarding_complete",
      state: "pending",
    });
  });

  it("rotates the onboarding bearer while preserving the claim retained by the Kernel", async () => {
    const fixture = await provisioningInstallation("reissue");
    const first = await fixture.onboarding.issue(fixture.installationId);
    const original = await fixture.onboarding.authorize({
      installationId: fixture.installationId,
      token: new URL(first.onboardingUrl).hash.slice(1),
    });
    if (!original.ok) throw new Error("original claim was not authorized");
    const second = await fixture.onboarding.issue(fixture.installationId, first.expiresAt);
    expect(second.expiresAt).toBeGreaterThan(first.expiresAt);

    await expect(fixture.onboarding.authorize({
      installationId: fixture.installationId,
      token: new URL(first.onboardingUrl).hash.slice(1),
    })).resolves.toEqual({ ok: false });
    await expect(fixture.onboarding.authorize({
      installationId: fixture.installationId,
      token: new URL(second.onboardingUrl).hash.slice(1),
    }, first.expiresAt)).resolves.toMatchObject({ ok: true, claimId: original.claimId });

    await expect(fixture.onboarding.complete({
      installationId: fixture.installationId,
      claimId: original.claimId,
    })).resolves.toEqual({ state: "complete", installationId: fixture.installationId });
    await expect(fixture.accounts.resolveInstallation(fixture.installationId))
      .resolves.toMatchObject({ found: true, state: "active" });
    await expect(fixture.onboarding.authorize({
      installationId: fixture.installationId,
      token: new URL(second.onboardingUrl).hash.slice(1),
    }, first.expiresAt)).resolves.toEqual({ ok: false });
    await expect(fixture.onboarding.issue(fixture.installationId))
      .rejects.toThrow("installation is not awaiting onboarding");
    await expect(fixture.onboarding.complete({
      installationId: fixture.installationId,
      claimId: original.claimId,
    })).rejects.toThrow("installation onboarding claim is unavailable");
  });
});

describe("activation attribution", () => {
  async function activate(suffix: string, attribution: string | null) {
    const fixture = await provisioningInstallation(suffix);
    const onboarding = new InstallationOnboardingStore(env.INSTALLATIONS_DB, fixture.accounts, undefined, { GSV_TELEMETRY_ENABLED: "1" });
    await env.INSTALLATIONS_DB.prepare("UPDATE provisioning_operations SET attribution_json = ? WHERE installation_id = ?")
      .bind(attribution, fixture.installationId).run();
    const issued = await onboarding.issue(fixture.installationId);
    const authorization = await onboarding.authorize({ installationId: fixture.installationId, token: new URL(issued.onboardingUrl).hash.slice(1) });
    if (!authorization.ok) throw new Error("claim was not authorized");
    const logged: unknown[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((value) => { logged.push(value); });
    try {
      await onboarding.complete({ claimId: authorization.claimId, installationId: fixture.installationId });
    } finally {
      log.mockRestore();
    }
    return { installationId: fixture.installationId, records: logged.flatMap((value) => {
      const record = telemetryRecordSchema.safeParse(value);
      return record.success ? [record.data] : [];
    }) };
  }

  it("reports where a website signup came from when the Ship activates", async () => {
    const { installationId, records } = await activate("attributed", JSON.stringify({ placement: "example", example: "tickets" }));
    expect(records).toEqual([expect.objectContaining({ component: "accounts", installationId, event: {
      stream: "product", name: "installation.attributed", properties: { origin: "website", placement: "example", example: "tickets" },
    } })]);
  });

  it("reports a direct signup, and treats a malformed origin as direct", async () => {
    expect((await activate("direct", null)).records.map((record) => record.event)).toEqual([
      { stream: "product", name: "installation.attributed", properties: { origin: "direct" } },
    ]);
    expect((await activate("malformed", JSON.stringify({ placement: "hero-heading", visitorId: "abc" }))).records.map((record) => record.event)).toEqual([
      { stream: "product", name: "installation.attributed", properties: { origin: "direct" } },
    ]);
  });
});
