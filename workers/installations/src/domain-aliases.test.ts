import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { AccountStore } from "./store";
import { InstallationOnboardingStore } from "./onboarding";

it("keeps identity across a domain change, onboarding and reset, without allocating unknown hosts", async () => {
  const old = new AccountStore(env.INSTALLATIONS_DB, "old.example");
  const owner = await old.createPrincipal({ email: "aliases@example.com", displayName: "Owner", verified: true });
  const first = await old.reserveInstallation({ principalId: owner.id, operationId: "aliases-create", handle: "pilot" });
  const current = new AccountStore(env.INSTALLATIONS_DB, "fleet.example", undefined, [], ["old.example"]);
  const onboarding = new InstallationOnboardingStore(env.INSTALLATIONS_DB, current);
  const activate = async (installationId: string) => {
    const issued = await onboarding.begin(installationId);
    const authorization = await onboarding.authorize({ installationId, token: new URL(issued.onboardingUrl).hash.slice(1) });
    if (!authorization.ok) throw new Error("Expected onboarding authorization");
    await onboarding.complete({ installationId, claimId: authorization.claimId });
  };

  await expect(current.resolveHostname("pilot.fleet.example")).resolves.toMatchObject({
    installationId: first.installationId, canonicalOrigin: "https://pilot.old.example", state: "reserved",
  });
  await activate(first.installationId);
  for (const hostname of ["pilot.old.example", "pilot.fleet.example"]) {
    expect(await current.resolveHostname(hostname)).toMatchObject({ installationId: first.installationId, state: "active" });
  }
  await env.INSTALLATIONS_DB.prepare("UPDATE installations SET state = 'restricted' WHERE id = ?").bind(first.installationId).run();
  expect(await current.resolveHostname("pilot.fleet.example")).toMatchObject({ state: "restricted" });
  const reset = await current.resetInstallation({ installationId: first.installationId, operationId: "aliases-reset", confirmHandle: "pilot" });
  expect(reset.installationId).not.toBe(first.installationId);
  expect(reset.canonicalOrigin).toBe("https://pilot.old.example");
  await activate(reset.installationId);
  for (const hostname of ["pilot.old.example", "pilot.fleet.example"]) {
    expect(await current.resolveHostname(hostname)).toMatchObject({ installationId: reset.installationId, state: "active" });
  }
  const newcomer = await current.reserveInstallation({ principalId: owner.id, operationId: "aliases-new", handle: "new-pilot" });
  expect(newcomer.canonicalOrigin).toBe("https://new-pilot.fleet.example");
  for (const hostname of ["new-pilot.old.example", "unknown.fleet.example", "pilot.fleet.example.attacker.example", "nested.pilot.fleet.example"]) {
    expect(await current.resolveHostname(hostname)).toEqual({ found: false });
  }
  expect(await env.INSTALLATIONS_DB.prepare("SELECT COUNT(*) AS count FROM installations").first("count")).toBe(3);
  await env.INSTALLATIONS_DB.prepare("UPDATE hostnames SET state = 'retired' WHERE normalized_hostname = ?").bind("pilot.fleet.example").run();
  expect(await current.resolveHostname("pilot.fleet.example")).toEqual({ found: false });
  expect(await current.resolveHostname("pilot.old.example")).toMatchObject({ installationId: reset.installationId });
});
