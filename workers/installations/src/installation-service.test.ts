import { env, exports } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { expect, it } from "vitest";
import InstallationService from "./index";
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

it.each(["https://accounts.example.com", "https://owners.example.com"])("completes owner signup at %s while reserving every configured service handle", async (origin) => {
  const ownerHandle = `${new URL(origin).hostname.split(".")[0]}-pilot`;
  let code = "";
  const service = new InstallationService(createExecutionContext(), { ...env,
    GSV_OWNER_ORIGIN_ALIASES: '["https://owners.example.com"]',
    GSV_SIGNUP_ENABLED: "true", GSV_OWNER_SIGNUP_ORIGIN: "https://join.example.com", GSV_OWNER_AUTH_SECRET: "synthetic-auth-secret-".repeat(4),
    GSV_OWNER_EMAIL_FROM: "login@ship.space", GSV_OWNER_EMAIL_REPLY_TO: "hello@humansandmachin.es", OWNER_EMAIL: {
      async send(message: EmailMessage | EmailMessageBuilder): Promise<EmailSendResult> {
        if (!("subject" in message)) throw new Error("Expected composed mail");
        expect(message).toMatchObject({ from: { email: "login@ship.space", name: "Ship" },
          replyTo: "hello@humansandmachin.es", subject: "Your Ship sign-in code" });
        code = message.text?.match(/^([0-9]{6})$/m)?.[1] ?? "";
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
  const challenge = { challengeId: crypto.randomUUID(), browserSecret: secret(), email: `${ownerHandle}@example.com` };
  expect((await request("/code", challenge)).status).toBe(200);
  expect((await request("/verify", { challengeId: challenge.challengeId, browserSecret: challenge.browserSecret, code, sessionSecret })).status).toBe(200);
  const operationId = crypto.randomUUID();
  for (const handle of ["accounts", "join", "owners"]) {
    const availability = await request(`/handle?value=${handle}`);
    expect(availability.status).toBe(200);
    expect(await availability.json()).toEqual({ available: false });
    const denied = await request("/spaces", { operationId, handle });
    expect(denied.status).toBe(400);
    expect(await denied.json()).toEqual({ error: "This username is unavailable. Choose another.", code: "handle_unavailable" });
    expect(await service.resolveHostname(`${handle}.example.com`)).toEqual({ found: false });
  }
  expect(await env.INSTALLATIONS_DB.prepare("SELECT operation_id FROM provisioning_operations WHERE operation_id = ?")
    .bind(operationId).first()).toBeNull();
  const prepared = await request("/spaces", { operationId, handle: ownerHandle });
  expect(prepared.status).toBe(200);
  const result = await prepared.json<{ origin: string; onboardingToken: string }>();
  expect(result.origin).toBe(`https://${ownerHandle}.example.com`);
  const space = await service.resolveHostname(`${ownerHandle}.example.com`);
  if (!space.found) throw new Error("Expected created space");
  const authorization = await service.authorizeInstallationOnboarding({ installationId: space.installationId, token: result.onboardingToken });
  if (!authorization.ok) throw new Error("Expected setup authorization");
  await service.completeInstallationOnboarding({ installationId: space.installationId, claimId: authorization.claimId });
  expect(await service.resolveHostname(`${ownerHandle}.example.com`)).toMatchObject({ state: "active" });
  expect((await service.fetch(new Request("https://untrusted.example.com/owner/api/session"))).status).toBe(404);
  expect((await service.fetch(new Request("https://owners.example.com/admin"))).status).toBe(403);
});
