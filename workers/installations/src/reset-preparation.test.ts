import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import type { InstallationResetPreparation, InstallationResetService } from "@humansandmachines/gsv/services/lifecycle";
import { AccountStore } from "./store";
import { InstallationOnboardingStore } from "./onboarding";
import { InstallationResetCoordinator } from "./reset-preparation";

it.each([false, true])("recovers a committed reset after delayed preparation (legacy expiry: %s)", async (legacyExpiry) => {
  const accounts = new AccountStore(env.INSTALLATIONS_DB, "example.com");
  const onboarding = new InstallationOnboardingStore(env.INSTALLATIONS_DB, accounts);
  const suffix = legacyExpiry ? "legacy" : "current";
  const owner = await accounts.createPrincipal({ email: `delayed-${suffix}@example.com`, displayName: "Owner", verified: true });
  const original = await accounts.reserveInstallation({ principalId: owner.id, operationId: `original-${suffix}`, handle: `delayed-${suffix}` });
  const initial = await onboarding.begin(original.installationId);
  const authorized = await onboarding.authorize({ installationId: original.installationId, token: new URL(initial.onboardingUrl).hash.slice(1) });
  if (!authorized.ok) throw new Error("Initial onboarding was not authorized");
  await onboarding.complete({ installationId: original.installationId, claimId: authorized.claimId });
  const ordinary = await accounts.reserveInstallation({ principalId: owner.id, operationId: `ordinary-${suffix}`, handle: `ordinary-${suffix}` });
  const ordinaryState = env.INSTALLATIONS_DB.prepare(
    `SELECT i.state, i.reservation_expires_at, h.state AS hostname_state,
            p.state AS operation_state, p.attempt, p.updated_at
     FROM installations i JOIN hostnames h ON h.installation_id = i.id
     JOIN provisioning_operations p ON p.installation_id = i.id WHERE i.id = ?`,
  ).bind(ordinary.installationId);
  const ordinaryBefore = await ordinaryState.first();

  let available = false;
  const attempts: InstallationResetPreparation[] = [];
  const participant: InstallationResetService = {
    async prepareInstallationReset(input) {
      attempts.push(input);
      if (!available) throw new Error("Inference preparation is unavailable");
      return { ...input, state: "prepared" };
    },
  };
  const request = { installationId: original.installationId, operationId: `reset-${suffix}`, confirmHandle: original.handle };
  const startedAt = Date.now();
  await expect(new InstallationResetCoordinator(env.INSTALLATIONS_DB, accounts, { inference: participant }).reset(request))
    .rejects.toThrow("Inference preparation is unavailable");
  const committed = await accounts.getResetByOperation(request.operationId);
  if (!committed) throw new Error("Reset was not committed");
  expect(committed.reservationExpiresAt).toBeNull();
  if (legacyExpiry) {
    // Already committed replacements from earlier releases retain the old reservation deadline.
    await env.INSTALLATIONS_DB.prepare("UPDATE installations SET reservation_expires_at = ? WHERE id = ?")
      .bind(startedAt + 30 * 60 * 1000, committed.installationId).run();
  }
  const clock = vi.spyOn(Date, "now").mockReturnValue(startedAt + 31 * 60 * 1000);
  try {
    const restartedAccounts = new AccountStore(env.INSTALLATIONS_DB, "example.com");
    const restartedOnboarding = new InstallationOnboardingStore(env.INSTALLATIONS_DB, restartedAccounts);
    await expect(restartedOnboarding.begin(committed.installationId)).rejects.toThrow("reset preparation is pending");
    // Having another committed reset does not exempt this owner's ordinary reservation.
    await expect(restartedAccounts.beginProvisioning(ordinary.operationId, owner.id)).rejects.toThrow("could not enter provisioning");
    expect(await ordinaryState.first()).toEqual(ordinaryBefore);
    available = true;
    const restartedCoordinator = new InstallationResetCoordinator(env.INSTALLATIONS_DB, restartedAccounts, { inference: participant });
    if (!legacyExpiry) await expect(restartedCoordinator.resumePending()).resolves.toEqual({ prepared: 1, pending: 0 });
    const resumed = await restartedCoordinator.reset(request);
    expect(resumed.installationId).toBe(committed.installationId);
    const preparation = { version: 1, operationId: request.operationId,
      previousInstallationId: original.installationId, replacementInstallationId: committed.installationId };
    expect(attempts).toEqual([preparation, preparation]);
    const issued = await restartedOnboarding.begin(resumed.installationId);
    const claim = await restartedOnboarding.authorize({ installationId: resumed.installationId, token: new URL(issued.onboardingUrl).hash.slice(1) });
    if (!claim.ok) throw new Error("Replacement onboarding was not authorized");
    await restartedOnboarding.complete({ installationId: resumed.installationId, claimId: claim.claimId });
    await expect(restartedAccounts.resolveHostname(`delayed-${suffix}.example.com`))
      .resolves.toMatchObject({ installationId: committed.installationId, state: "active" });
    await expect(restartedAccounts.resolveInstallation(original.installationId)).resolves.toMatchObject({ state: "retained" });
    await expect(restartedAccounts.getResetByOperation(request.operationId))
      .resolves.toMatchObject({ installationId: committed.installationId, previousInstallationId: original.installationId, operationState: "complete", dataDeletionState: "pending" });
    expect((await env.INSTALLATIONS_DB.prepare("SELECT id FROM installations WHERE owner_principal_id = ?").bind(owner.id).all()).results).toHaveLength(3);
  } finally {
    clock.mockRestore();
  }
});
