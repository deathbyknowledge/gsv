import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { EntitlementStore } from "../entitlements/store";
import { AccountStore } from "../store";
import { InstallationOnboardingStore } from "./onboarding";

async function provisioningInstallation(suffix: string): Promise<{
  accounts: AccountStore;
  onboarding: InstallationOnboardingStore;
  installationId: string;
}> {
  const accounts = new AccountStore(env.ACCOUNT_DB, "gsv.space");
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
  const now = Date.now();
  await new EntitlementStore(env.ACCOUNT_DB).project({
    installationId: reservation.installationId,
    state: "active",
    planKey: "test",
    inferenceBudgetMicrounits: 5_000_000,
    inferencePeriodStartsAt: now,
    inferencePeriodEndsAt: now + 30 * 24 * 60 * 60_000,
    storageLimitBytes: 10_000_000,
    effectiveAt: now,
    version: 1,
  });
  await accounts.beginProvisioning(reservation.operationId, principalId);
  return {
    accounts,
    onboarding: new InstallationOnboardingStore(env.ACCOUNT_DB, accounts),
    installationId: reservation.installationId,
  };
}

describe("installation onboarding claims", () => {
  it("authorizes only the capability bound to the provisioning installation", async () => {
    const fixture = await provisioningInstallation("authorize");
    const other = await provisioningInstallation("authorize-other");
    const issued = await fixture.onboarding.issue(fixture.installationId);
    const token = new URL(issued.onboardingUrl).hash.slice(1);

    expect(issued.onboardingUrl).toMatch(
      /^https:\/\/onboarding-authorize\.gsv\.space\/onboarding#onboard_/,
    );
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
      installationId: fixture.installationId,
      token: `${token}wrong`,
    })).resolves.toEqual({ ok: false });
    await expect(fixture.onboarding.authorize({
      installationId: other.installationId,
      token,
    })).resolves.toEqual({ ok: false });
    await expect(fixture.onboarding.authorize({
      installationId: fixture.installationId,
      token,
    }, issued.expiresAt)).resolves.toEqual({ ok: false });

    const stored = await env.ACCOUNT_DB.prepare(
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

  it("activates the installation without mapping a platform login", async () => {
    const fixture = await provisioningInstallation("complete");
    const issued = await fixture.onboarding.issue(fixture.installationId);
    const token = new URL(issued.onboardingUrl).hash.slice(1);
    const authorization = await fixture.onboarding.authorize({
      installationId: fixture.installationId,
      token,
    });
    if (!authorization.ok) throw new Error("claim was not authorized");

    await expect(fixture.onboarding.complete({
      claimId: authorization.claimId,
      installationId: fixture.installationId,
    })).resolves.toEqual({
      state: "complete",
      installationId: fixture.installationId,
    });
    await expect(fixture.accounts.resolveHostname(
      "onboarding-complete.gsv.space",
    )).resolves.toMatchObject({ found: true, state: "active" });
    await expect(fixture.onboarding.authorize({
      installationId: fixture.installationId,
      token,
    })).resolves.toEqual({ ok: false });

    const membership = await env.ACCOUNT_DB.prepare(
      `SELECT local_uid, state
       FROM memberships
       WHERE installation_id = ?`,
    ).bind(fixture.installationId).first<{
      local_uid: number | null;
      state: string;
    }>();
    expect(membership).toEqual({ local_uid: null, state: "pending" });
  });

  it("reissuing a claim invalidates the prior link", async () => {
    const fixture = await provisioningInstallation("reissue");
    const first = await fixture.onboarding.issue(fixture.installationId);
    const second = await fixture.onboarding.issue(fixture.installationId);

    await expect(fixture.onboarding.authorize({
      installationId: fixture.installationId,
      token: new URL(first.onboardingUrl).hash.slice(1),
    })).resolves.toEqual({ ok: false });
    await expect(fixture.onboarding.authorize({
      installationId: fixture.installationId,
      token: new URL(second.onboardingUrl).hash.slice(1),
    })).resolves.toMatchObject({ ok: true });
  });
});
