import { env, exports } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { expect, it } from "vitest";
import InstallationService from "./index";
import { AccountStore } from "./store";
import { InstallationOnboardingStore } from "./onboarding";
import { InstallationResetCoordinator } from "./reset-preparation";
import { InstallationCreationInvites } from "./creation-invites";

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

it("rejects configured service handles without consuming an invite, then completes signup with another handle", async () => {
  const origin = "https://accounts.example.com";
  let code = "";
  const service = new InstallationService(createExecutionContext(), { ...env,
    GSV_OWNER_SIGNUP_ORIGIN: "https://join.example.com", GSV_OWNER_AUTH_SECRET: "synthetic-auth-secret-".repeat(4),
    GSV_OWNER_EMAIL_FROM: "accounts@example.com", OWNER_EMAIL: {
      async send(message: EmailMessage | EmailMessageBuilder): Promise<EmailSendResult> {
        if (!("subject" in message)) throw new Error("Expected composed mail");
        code = message.text?.match(/code is ([0-9]{6})\./)?.[1] ?? "";
        return { messageId: crypto.randomUUID() };
      },
    },
  });
  const secret = () => (crypto.randomUUID() + crypto.randomUUID()).replaceAll("-", "");
  const sessionSecret = secret();
  const request = (path: string, body?: Record<string, string>) => service.fetch(new Request(`${origin}/owner/api${path}`, {
    method: body ? "POST" : "GET", headers: { "content-type": "application/json", authorization: `Bearer ${sessionSecret}` },
    body: body ? JSON.stringify(body) : undefined,
  }));
  const challenge = { challengeId: crypto.randomUUID(), browserSecret: secret(), email: "signup-owner@example.com" };
  expect((await request("/code", challenge)).status).toBe(200);
  expect((await request("/verify", { challengeId: challenge.challengeId, browserSecret: challenge.browserSecret, code, sessionSecret })).status).toBe(200);
  const store = new AccountStore(env.INSTALLATIONS_DB, "example.com");
  const invitations = new InstallationCreationInvites(env.INSTALLATIONS_DB, store, new InstallationOnboardingStore(env.INSTALLATIONS_DB, store));
  const issued = await invitations.create({});
  expect((await request("/invites/claim", { code: issued.code })).status).toBe(200);
  for (const handle of ["accounts", "join"]) {
    expect((await request(`/handle?value=${handle}`)).status).toBe(400);
    const denied = await request(`/invites/${issued.invite.id}/space`, { handle });
    expect(denied.status).toBe(400);
    expect(await denied.json()).toEqual({ error: "handle is reserved for an operator service" });
    expect(await service.resolveHostname(`${handle}.example.com`)).toEqual({ found: false });
  }
  expect(await env.INSTALLATIONS_DB.prepare("SELECT installation_id FROM installation_creation_invites WHERE id = ?")
    .bind(issued.invite.id).first()).toEqual({ installation_id: null });
  expect(await env.INSTALLATIONS_DB.prepare("SELECT operation_id FROM provisioning_operations WHERE operation_id = ?")
    .bind(issued.invite.id).first()).toBeNull();
  const prepared = await request(`/invites/${issued.invite.id}/space`, { handle: "new-owner" });
  expect(prepared.status).toBe(200);
  const result = await prepared.json<{ origin: string; onboardingToken: string }>();
  expect(result.origin).toBe("https://new-owner.example.com");
  const space = await service.resolveHostname("new-owner.example.com");
  if (!space.found) throw new Error("Expected created space");
  const authorization = await service.authorizeInstallationOnboarding({ installationId: space.installationId, token: result.onboardingToken });
  if (!authorization.ok) throw new Error("Expected setup authorization");
  await service.completeInstallationOnboarding({ installationId: space.installationId, claimId: authorization.claimId });
  expect(await service.resolveHostname("new-owner.example.com")).toMatchObject({ state: "active" });
});
