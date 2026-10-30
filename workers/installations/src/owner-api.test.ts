import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { AccountStore } from "./store";
import { InstallationOwnerStore } from "./owner-store";
import { InstallationOwnerAuthStore } from "./owner-auth-store";
import { InstallationOnboardingStore } from "./onboarding";
import { InstallationSignup } from "./signup";
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
  const onboarding = new InstallationOnboardingStore(env.INSTALLATIONS_DB, accounts, "api-test-secret-".repeat(4));
  const signup = new InstallationSignup(env.INSTALLATIONS_DB, accounts, onboarding, true);
  let code = "";
  const send = vi.fn(async (message: EmailMessage | EmailMessageBuilder): Promise<EmailSendResult> => {
    if (!("subject" in message)) throw new Error("Expected composed mail");
    code = message.text?.match(/code is ([0-9]{6})\./)?.[1] ?? "";
    return { messageId: crypto.randomUUID() };
  });
  const makeApi = () => new InstallationOwnerApi(auth, owners, signup, { send }, "accounts@example.com", ORIGIN, "example.com");
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
  return { accounts, signup, onboarding, auth, request, challenge, sessionSecret, send, signIn,
    restart: () => { api = makeApi(); }, code: () => code };
}

describe("desktop owner API", () => {
  it("checks handles before email verification without granting space creation", async () => {
    const f = await fixture();
    const handle = `public-${crypto.randomUUID()}`;
    const check = await f.request(`/handle?value=${handle.toUpperCase()}`);
    expect(check.status).toBe(200);
    expect(await check.json()).toEqual({ available: true });
    expect((await f.request("/handle?value=not_a_handle")).status).toBe(400);
    expect((await f.request("/handle?value=signup")).status).toBe(400);
    expect((await f.request("/session")).status).toBe(401);
    expect((await f.request("/spaces", undefined, { operationId: crypto.randomUUID(), handle })).status).toBe(401);
    expect(f.send).not.toHaveBeenCalled();
    await f.signIn();
    await f.request("/spaces", f.sessionSecret, { operationId: crypto.randomUUID(), handle });
    expect(await (await f.request(`/handle?value=${handle}`)).json()).toEqual({ available: false });
  });

  it("replays lost verification and setup responses without duplicating mail or spaces", async () => {
    const f = await fixture();
    const verify = await f.signIn();
    f.restart();
    expect(f.send).toHaveBeenCalledTimes(1);
    expect((await f.request("/verify", undefined, verify)).status).toBe(200);
    const initialSession = await (await f.request("/session", f.sessionSecret)).json<{ spaceDomain: string; spaces: unknown[] }>();
    expect(initialSession.spaceDomain).toBe("example.com");
    expect(initialSession.spaces).toEqual([]);
    const operationId = crypto.randomUUID();
    const handle = `test-${crypto.randomUUID()}`;
    expect(await (await f.request(`/handle?value=${handle.toUpperCase()}`, f.sessionSecret)).json()).toEqual({ available: true });
    const first = await (await f.request("/spaces", f.sessionSecret, { operationId, handle: handle.toUpperCase() })).json<{ origin: string; onboardingToken: string }>();
    expect(first.origin).toBe(`https://${handle}.${initialSession.spaceDomain}`);
    expect(await (await f.request(`/handle?value=${handle.toUpperCase()}`, f.sessionSecret)).json()).toEqual({ available: false });
    f.restart();
    const resumed = await (await f.request("/spaces", f.sessionSecret, { operationId, handle })).json<typeof first>();
    expect(resumed.origin).toBe(first.origin);
    const owner = await f.auth.session(f.sessionSecret);
    const reservation = await f.accounts.getReservationByOperation(operationId);
    expect((await f.signup.pending(owner!.principalId))).toHaveLength(1);
    const authorization = await f.onboarding.authorize({ installationId: reservation!.installationId, token: resumed.onboardingToken });
    if (!authorization.ok) throw new Error("Expected setup authorization");
    await f.onboarding.complete({ installationId: reservation!.installationId, claimId: authorization.claimId });
    const activated = await (await f.request("/spaces", f.sessionSecret, { operationId, handle })).json<{ onboardingToken: string | null }>();
    expect(activated.onboardingToken).toBeNull();
    const session = await (await f.request("/session", f.sessionSecret)).json<{ spaces: unknown[]; setups: unknown[] }>();
    expect(session.spaces).toHaveLength(1);
    expect(session.setups).toHaveLength(0);
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
    const other = await fixture();
    await other.signIn();
    const operationId = crypto.randomUUID();
    await other.request("/spaces", other.sessionSecret, { operationId, handle: `owned-${crypto.randomUUID()}` });
    expect((await f.request("/spaces", f.sessionSecret, { operationId, handle: "stolen" })).status).toBe(400);
    expect((await f.request("/spaces", undefined, { operationId: crypto.randomUUID(), handle: "anonymous" })).status).toBe(401);
    expect((await f.request("/invites/claim", f.sessionSecret, { code: "retired-code" })).status).toBe(410);
  });

  it("reports failed delivery without leaking mail errors", async () => {
    const f = await fixture();
    f.send.mockRejectedValueOnce(new Error("private delivery address"));
    const response = await f.request("/code", undefined, f.challenge);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private delivery address");
    expect((await f.request("/session", secret())).status).toBe(401);
  });

  it("explains invalid handle characters before space creation", async () => {
    const f = await fixture();
    await f.signIn();
    const response = await f.request("/handle?value=not_a_handle", f.sessionSecret);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Use letters, numbers or hyphens. Start and end with a letter or number." });
  });
});
