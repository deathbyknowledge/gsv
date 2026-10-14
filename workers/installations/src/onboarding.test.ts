import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { InstallationOnboardingStore } from "./onboarding";
import { AccountStore } from "./store";

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
  it("resumes one usable bearer across concurrent clients and rotates only after expiry", async () => {
    const fixture = await provisioningInstallation("concurrent-resume");
    const secret = "onboarding-resume-test-".repeat(4);
    const firstStore = new InstallationOnboardingStore(env.INSTALLATIONS_DB, fixture.accounts, secret);
    const secondStore = new InstallationOnboardingStore(env.INSTALLATIONS_DB, fixture.accounts, secret);
    const now = Date.now();
    const first = await Promise.all([firstStore.begin(fixture.installationId, now), secondStore.begin(fixture.installationId, now)]);
    expect(first[0]).toEqual(first[1]);
    const originalToken = new URL(first[0].onboardingUrl).hash.slice(1);
    const original = await firstStore.authorize({ installationId: fixture.installationId, token: originalToken });
    expect(original.ok).toBe(true);
    expect(await secondStore.begin(fixture.installationId, now + 1)).toEqual(first[0]);
    const renewed = await Promise.all([firstStore.begin(fixture.installationId, first[0].expiresAt), secondStore.begin(fixture.installationId, first[0].expiresAt)]);
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
