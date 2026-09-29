import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { AccountStore } from "./store";
import { InstallationOwnerStore } from "./owner-store";
import { InstallationOwnerAuthStore } from "./owner-auth-store";
import { InstallationOnboardingStore } from "./onboarding";
import { InstallationCreationInvites } from "./creation-invites";
import { InstallationOwnerApi } from "./owner-api";
import type { JsonObject } from "@humansandmachines/gsv/protocol";

const ORIGIN = "https://accounts.example.com";
const secret = () => crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");

async function fixture() {
  const accounts = new AccountStore(env.INSTALLATIONS_DB, "example.com");
  const registry = `registry_${crypto.randomUUID()}`;
  await accounts.createPrincipal({ principalId: registry, email: `${registry}@example.com`, displayName: "Registry", verified: true });
  const owners = new InstallationOwnerStore(env.INSTALLATIONS_DB, registry);
  const auth = new InstallationOwnerAuthStore(env.INSTALLATIONS_DB, "api-test-secret-".repeat(4));
  const onboarding = new InstallationOnboardingStore(env.INSTALLATIONS_DB, accounts);
  const invites = new InstallationCreationInvites(env.INSTALLATIONS_DB, accounts, onboarding);
  let code = "";
  const send = vi.fn(async (message: EmailMessage | EmailMessageBuilder): Promise<EmailSendResult> => {
    if (!("subject" in message)) throw new Error("Expected composed mail");
    code = message.text?.match(/code is ([0-9]{6})\./)?.[1] ?? "";
    return { messageId: crypto.randomUUID() };
  });
  const makeApi = () => new InstallationOwnerApi(auth, owners, invites, { send }, "accounts@example.com", ORIGIN, "example.com");
  let api = makeApi();
  const request = async (path: string, token?: string, body?: JsonObject, headers: Record<string, string> = {}) => {
    const requestHeaders = new Headers({ "content-type": "application/json", "cf-connecting-ip": registry, ...headers });
    if (token) requestHeaders.set("authorization", `Bearer ${token}`);
    const response = await api.handle(new Request(`${ORIGIN}/owner/api${path}`, {
      method: body === undefined ? "GET" : "POST", headers: requestHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
    }));
    if (!response) throw new Error("Missing API response");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.has("access-control-allow-credentials")).toBe(false);
    return response;
  };
  const challenge = { challengeId: crypto.randomUUID(), browserSecret: secret(), email: `${registry}-owner@example.com` };
  const sessionSecret = secret();
  const signIn = async () => {
    expect((await request("/code", undefined, challenge)).status).toBe(200);
    expect((await request("/code", undefined, challenge)).status).toBe(200);
    const verify = { challengeId: challenge.challengeId, browserSecret: challenge.browserSecret, sessionSecret, code };
    expect((await request("/verify", undefined, verify)).status).toBe(200);
    return verify;
  };
  return { accounts, invites, onboarding, auth, request, challenge, sessionSecret, send, signIn,
    restart: () => { api = makeApi(); }, code: () => code };
}

describe("desktop owner API", () => {
  it("replays lost verification and setup responses without duplicating mail or spaces", async () => {
    const f = await fixture();
    const verify = await f.signIn();
    f.restart();
    expect(f.send).toHaveBeenCalledTimes(1);
    expect((await f.request("/verify", undefined, verify)).status).toBe(200);
    const initialSession = await (await f.request("/session", f.sessionSecret)).json<{ spaceDomain: string; spaces: unknown[] }>();
    expect(initialSession.spaceDomain).toBe("example.com");
    expect(initialSession.spaces).toEqual([]);
    const issued = await f.invites.create({ note: "operator-only" });
    const claim = await f.request("/invites/claim", f.sessionSecret, { code: issued.code });
    expect(claim.status).toBe(200);
    expect(await claim.text()).not.toContain("operator-only");
    const handle = `test-${crypto.randomUUID()}`;
    const first = await (await f.request(`/invites/${issued.invite.id}/space`, f.sessionSecret, { handle })).json<{ origin: string; onboardingToken: string }>();
    expect(first.origin).toBe(`https://${handle}.${initialSession.spaceDomain}`);
    f.restart();
    const resumed = await (await f.request(`/invites/${issued.invite.id}/space`, f.sessionSecret, { handle })).json<typeof first>();
    expect(resumed.origin).toBe(first.origin);
    const owner = await f.auth.session(f.sessionSecret);
    const [invite] = await f.invites.owned(owner!.principalId);
    const authorization = await f.onboarding.authorize({ installationId: invite.installationId!, token: resumed.onboardingToken });
    if (!authorization.ok) throw new Error("Expected setup authorization");
    await f.onboarding.complete({ installationId: invite.installationId!, claimId: authorization.claimId });
    const activated = await (await f.request(`/invites/${issued.invite.id}/space`, f.sessionSecret, { handle })).json<{ onboardingToken: string | null }>();
    expect(activated.onboardingToken).toBeNull();
    const session = await (await f.request("/session", f.sessionSecret)).json<{ spaces: unknown[]; invites: unknown[] }>();
    expect(session.spaces).toHaveLength(1);
    expect(session.invites).toHaveLength(1);
    expect((await f.request("/logout", f.sessionSecret, {})).status).toBe(200);
    expect((await f.request("/session", f.sessionSecret)).status).toBe(401);
    expect((await f.request("/verify", undefined, verify)).status).toBe(400);
  });

  it("requires explicit bearer authority and cannot reuse verification for another purpose or session", async () => {
    const f = await fixture();
    const verify = await f.signIn();
    expect((await f.request("/session", undefined, undefined, { cookie: `__Host-gsv-owner-session=${f.sessionSecret}` })).status).toBe(401);
    expect((await f.request("/verify", undefined, { ...verify, purpose: "recover" })).status).toBe(400);
    expect((await f.request("/verify", undefined, { ...verify, sessionSecret: secret() })).status).toBe(400);
    const issued = await f.invites.create({});
    const other = await fixture();
    await other.signIn();
    await other.request("/invites/claim", other.sessionSecret, { code: issued.code });
    expect((await f.request("/invites/claim", f.sessionSecret, { code: issued.code })).status).toBe(400);
    expect((await f.request(`/invites/${issued.invite.id}/space`, f.sessionSecret, { handle: "stolen" })).status).toBe(400);
  });

  it("reports failed delivery without leaking mail errors", async () => {
    const f = await fixture();
    f.send.mockRejectedValueOnce(new Error("private delivery address"));
    const response = await f.request("/code", undefined, f.challenge);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private delivery address");
    expect((await f.request("/session", secret())).status).toBe(401);
  });
});
