import { env, exports } from "cloudflare:workers";
import { expect, it } from "vitest";
import { InstallationAdminStore } from "./administration";
import { AccountStore } from "./store";
import { InstallationOnboardingStore } from "./onboarding";
import { InstallationResetCoordinator } from "./reset-preparation";

it("administers installations and preserves reset isolation without commercial tables", async () => {
  const accounts = new AccountStore(env.INSTALLATIONS_DB, "example.com");
  const onboarding = new InstallationOnboardingStore(env.INSTALLATIONS_DB, accounts);
  const admin = new InstallationAdminStore(env.INSTALLATIONS_DB);
  const owner = await accounts.createPrincipal({ email: "admin@example.com", displayName: "Owner", verified: true });
  const homes = [];
  for (const handle of ["admin-first", "admin-second"]) {
    const home = await accounts.reserveInstallation({ principalId: owner.id, operationId: `create_${handle}`, handle });
    const claim = await onboarding.begin(home.installationId);
    const authorized = await exports.default.authorizeInstallationOnboarding({
      installationId: home.installationId, token: new URL(claim.onboardingUrl).hash.slice(1),
    });
    if (!authorized.ok) throw new Error("Onboarding was not authorized");
    await exports.default.completeInstallationOnboarding({ claimId: authorized.claimId, installationId: home.installationId });
    homes.push(home);
  }
  const [first, second] = homes;
  await expect(admin.listInstallations({ query: "ADMIN-", state: "active", page: 1 })).resolves.toMatchObject({ total: 2 });
  await admin.setInstallationState(first.installationId, "restricted");
  await admin.setInstallationState(first.installationId, "restricted");
  await expect(admin.listInstallations({ query: "admin-", state: "restricted", page: 1 })).resolves.toMatchObject({
    total: 1, installations: [{ installationId: first.installationId }],
  });
  await expect(admin.getInstallation(second.installationId)).resolves.toMatchObject({ state: "active", operationState: "complete" });
  await admin.setInstallationState(first.installationId, "active");
  const reset = await new InstallationResetCoordinator(env.INSTALLATIONS_DB, accounts, {}).reset({
    installationId: first.installationId, operationId: "reset_admin_first", confirmHandle: first.handle,
  });
  await expect(admin.listInstallations({ query: "admin-", state: null, page: 1 })).resolves.toMatchObject({ total: 2 });
  await expect(admin.getInstallation(reset.installationId)).resolves.toMatchObject({
    state: "reserved", reset: { previousInstallationId: first.installationId, dataDeletionState: "pending" },
  });
  await expect(admin.setInstallationState(reset.installationId, "active")).rejects.toThrow("cannot transition from reserved");
  await expect(admin.getInstallation(first.installationId)).resolves.toMatchObject({ state: "retained" });
  await expect(admin.getInstallation(second.installationId)).resolves.toMatchObject({ state: "active" });
});
