import { env, exports } from "cloudflare:workers";
import { expect, it } from "vitest";
import { InstallationAdminStore } from "./administration";
import { AccountStore } from "./store";
import { InstallationOnboardingStore } from "./onboarding";
import { InstallationResetCoordinator } from "./reset-preparation";
import type { SignupAttribution } from "@humansandmachines/gsv/telemetry";

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

it("shows who invited a Ship and how many Ships it invited, across resets on either side", async () => {
  const db = env.INSTALLATIONS_DB;
  const accounts = new AccountStore(db, "example.com");
  const admin = new InstallationAdminStore(db);
  const ship = async (handle: string, input: { active?: boolean; inviterInstallationId?: string; attribution?: SignupAttribution } = {}) => {
    const owner = await accounts.createPrincipal({ email: `${handle}@example.com`, displayName: handle, verified: true });
    const space = await accounts.reserveInstallation({ principalId: owner.id, operationId: `create_${handle}`, handle,
      inviterInstallationId: input.inviterInstallationId, attribution: input.attribution });
    if (input.active) {
      await db.batch([
        db.prepare("UPDATE installations SET state = 'active' WHERE id = ?").bind(space.installationId),
        db.prepare("UPDATE hostnames SET state = 'active' WHERE installation_id = ?").bind(space.installationId),
      ]);
    }
    return space;
  };
  const inviter = await ship("invites-host", { active: true });
  const joined = await ship("invites-joined", { active: true, inviterInstallationId: inviter.installationId });
  await ship("invites-pending", { inviterInstallationId: inviter.installationId });
  await ship("invites-website", { attribution: { placement: "hero" } });

  await expect(admin.getInstallation(inviter.installationId)).resolves.toMatchObject({ invitedBy: null, invitations: { total: 2, active: 1 } });
  await expect(admin.getInstallation(joined.installationId)).resolves.toMatchObject({
    invitedBy: { installationId: inviter.installationId, handle: "invites-host" }, invitations: { total: 0, active: 0 },
  });
  const origins = async () => Object.fromEntries((await admin.listInstallations({ query: "invites-", state: null, page: 1 }))
    .installations.map((entry) => [entry.handle, entry.origin]));
  await expect(origins()).resolves.toEqual({
    "invites-host": "direct", "invites-joined": "invite", "invites-pending": "invite", "invites-website": "website",
  });

  const inviterReset = await accounts.resetInstallation({ installationId: inviter.installationId, operationId: "reset_invites_host", confirmHandle: "invites-host" });
  const joinedReset = await accounts.resetInstallation({ installationId: joined.installationId, operationId: "reset_invites_joined", confirmHandle: "invites-joined" });
  await expect(admin.getInstallation(inviterReset.installationId)).resolves.toMatchObject({ invitations: { total: 2, active: 0 } });
  await db.prepare("UPDATE installations SET state = 'active' WHERE id = ?").bind(joinedReset.installationId).run();
  await expect(admin.getInstallation(inviterReset.installationId)).resolves.toMatchObject({ invitations: { total: 2, active: 1 } });
  await expect(admin.getInstallation(joinedReset.installationId)).resolves.toMatchObject({
    invitedBy: { installationId: inviterReset.installationId, handle: "invites-host" },
  });
  await expect(origins()).resolves.toMatchObject({ "invites-host": "direct", "invites-joined": "invite" });

  // The old installations' rows and the reset edges go with cleanup; the facts now live on the replacements.
  await db.batch([
    db.prepare("DELETE FROM installation_reset_operations WHERE operation_id IN ('reset_invites_host', 'reset_invites_joined')"),
    db.prepare("DELETE FROM provisioning_operations WHERE installation_id IN (?, ?)").bind(inviter.installationId, joined.installationId),
  ]);
  await expect(admin.getInstallation(inviterReset.installationId)).resolves.toMatchObject({ invitations: { total: 2, active: 1 } });
  await expect(admin.getInstallation(joinedReset.installationId)).resolves.toMatchObject({
    invitedBy: { installationId: inviterReset.installationId, handle: "invites-host" },
  });
  await expect(origins()).resolves.toMatchObject({ "invites-host": "direct", "invites-joined": "invite" });
});
