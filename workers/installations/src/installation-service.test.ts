import { env, exports } from "cloudflare:workers";
import { expect, it } from "vitest";
import { AccountStore } from "./store";
import { InstallationOnboardingStore } from "./onboarding";
import { InstallationResetCoordinator } from "./reset-preparation";

it("runs directory, onboarding and an isolated reset without any commercial tables", async () => {
  const accounts = new AccountStore(env.INSTALLATIONS_DB, "example.com");
  const onboarding = new InstallationOnboardingStore(env.INSTALLATIONS_DB, accounts);
  const owner = await accounts.createPrincipal({ email: "owner@example.com", displayName: "Owner", verified: true });
  const homes = [];
  for (const handle of ["first", "second"]) {
    const reservation = await accounts.reserveInstallation({ principalId: owner.id, operationId: `create_${handle}`, handle });
    const issued = await onboarding.begin(reservation.installationId);
    const authorized = await exports.default.authorizeInstallationOnboarding({
      installationId: reservation.installationId, token: new URL(issued.onboardingUrl).hash.slice(1),
    });
    if (!authorized.ok) throw new Error("Onboarding was not authorized");
    await exports.default.completeInstallationOnboarding({ claimId: authorized.claimId, installationId: reservation.installationId });
    homes.push(reservation);
  }
  expect((await env.INSTALLATIONS_DB.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'managed_inference_%'")
    .all()).results).toEqual([]);
  await expect(exports.default.resolveHostname("random.example.com")).resolves.toEqual({ found: false });
  const reset = await new InstallationResetCoordinator(env.INSTALLATIONS_DB, accounts, {}).reset({
    installationId: homes[0].installationId, operationId: "reset_first", confirmHandle: "first",
  });
  await expect(exports.default.resolveInstallation(homes[0].installationId)).resolves.toMatchObject({ state: "retained" });
  await expect(exports.default.resolveHostname("first.example.com")).resolves.toMatchObject({ installationId: reset.installationId, state: "reserved" });
  await expect(exports.default.resolveHostname("second.example.com")).resolves.toMatchObject({ installationId: homes[1].installationId, state: "active" });
  await expect(onboarding.begin(reset.installationId)).resolves.toMatchObject({ installationId: reset.installationId });
});
