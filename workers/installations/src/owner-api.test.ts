import { UsernamePolicy } from "./username-policy";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { AccountStore } from "./store";
import { InstallationOwnerStore } from "./owner-store";
import { InstallationOwnerAuthStore } from "./owner-auth-store";
import { InstallationOnboardingStore } from "./onboarding";
import { InstallationSignup } from "./signup";
import { InstallationOwnerApi } from "./owner-api";
import type { JsonObject } from "@humansandmachines/gsv/protocol";
import { runProductEmailJobs } from "./product-email";
import { InstallationAdminStore } from "./administration";
import { adminInstallationPage, adminInstallationsPage } from "./admin/installations-page";

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
    code = message.text?.match(/^([0-9]{6})$/m)?.[1] ?? "";
    return { messageId: crypto.randomUUID() };
  });
  const makeApi = () => new InstallationOwnerApi(auth, owners, signup, { send }, { from: "accounts@example.com" }, ORIGIN, "example.com");
  let api = makeApi();
  const request = async (path: string, token?: string, body?: JsonObject, headers: Record<string, string> = {},
    cf?: { country?: string; city?: string; region?: string }) => {
    const requestHeaders = new Headers({ "content-type": "application/json", "cf-connecting-ip": registry, ...headers });
    if (token) requestHeaders.set("authorization", `Bearer ${token}`);
    const incoming = new Request(`${ORIGIN}/owner/api${path}`, {
      method: body === undefined ? "GET" : "POST", headers: requestHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (cf) Object.defineProperty(incoming, "cf", { value: cf });
    const response = await api.handle(incoming);
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
  it("keeps the first signup snapshot through retries and exposes it only in authenticated administration", async () => {
    const f = await fixture();
    await f.signIn();
    const input = { operationId: crypto.randomUUID(), handle: `geo-${crypto.randomUUID()}` };
    const geo = { country: "CH", city: "Zürich", region: "Zurich" };
    const headers = { origin: "https://signup.example.com/path?token=private" };
    expect((await f.request("/spaces", undefined, input, headers, geo)).status).toBe(401);
    expect(await f.accounts.getReservationByOperation(input.operationId)).toBeNull();
    const created = await f.request("/spaces", f.sessionSecret, input, headers, geo);
    expect(created.status).toBe(200);
    const reply = await created.json<{ onboardingToken: string }>();
    expect(reply).not.toHaveProperty("signup");
    const reservation = (await f.accounts.getReservationByOperation(input.operationId))!;
    const admin = new InstallationAdminStore(env.INSTALLATIONS_DB);
    const expected = { ...geo, origin: "https://signup.example.com" };
    await expect(admin.getInstallation(reservation.installationId)).resolves.toMatchObject({ signup: expected });
    f.restart();
    expect((await f.request("/spaces", f.sessionSecret, input, { origin: "https://other.example" }, { country: "US" })).status).toBe(200);
    await expect(admin.getInstallation(reservation.installationId)).resolves.toMatchObject({ signup: expected });
    const list = await admin.listInstallations({ query: f.challenge.email.toUpperCase(), state: "provisioning", page: 1 });
    expect(list.total).toBe(1);
    expect(list.installations[0]).toMatchObject({ ownerEmail: f.challenge.email, signup: expected });
    const html = await adminInstallationsPage(list).text();
    for (const value of ["🇨🇭", "Switzerland", "Zürich", "signup.example.com", f.challenge.email, "Signup location", "Signup origin"]) expect(html).toContain(value);
    expect(html).not.toContain("token=private");
    expect(await adminInstallationPage((await admin.getInstallation(reservation.installationId))!).text()).toContain("Switzerland");
    const authorization = await f.onboarding.authorize({ installationId: reservation.installationId, token: reply.onboardingToken });
    if (!authorization.ok) throw new Error("Expected setup authorization");
    await f.onboarding.complete({ installationId: reservation.installationId, claimId: authorization.claimId });
    expect((await f.request("/spaces", f.sessionSecret, input, {}, { country: "DE" })).status).toBe(200);
    await expect(admin.getInstallation(reservation.installationId)).resolves.toMatchObject({ signup: expected });
  });

  it("renders missing historic signup metadata without inventing a country", async () => {
    const f = await fixture();
    await f.signIn();
    const owner = (await f.auth.session(f.sessionSecret))!;
    const reservation = await f.accounts.reserveInstallation({ principalId: owner.principalId,
      operationId: crypto.randomUUID(), handle: `historic-${crypto.randomUUID()}`, ownerSetup: true });
    const admin = new InstallationAdminStore(env.INSTALLATIONS_DB);
    const list = await admin.listInstallations({ query: reservation.handle, state: null, page: 1 });
    expect(list.installations[0].signup).toBeNull();
    expect(await adminInstallationsPage(list).text()).toContain("Not recorded");
    await expect(admin.getInstallation(reservation.installationId)).resolves.toMatchObject({ signup: null });
  });

  it.each([false, true])("replays verified signup without duplicating mail, spaces or optional marketing (opt-in: %s)", async (optedIn) => {
    const f = await fixture();
    const verify = await f.signIn();
    const marketing = () => env.INSTALLATIONS_DB.prepare("SELECT * FROM product_email_signups WHERE email=?").bind(f.challenge.email).first();
    expect(await marketing()).toBeNull();
    f.restart();
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.send.mock.calls[0][0]).toMatchObject({ from: { email: "accounts@example.com", name: "Ship" } });
    expect(f.send.mock.calls[0][0]).not.toHaveProperty("replyTo");
    expect((await f.request("/verify", undefined, verify)).status).toBe(200);
    const initialSession = await (await f.request("/session", f.sessionSecret)).json<{ spaceDomain: string; spaces: unknown[] }>();
    expect(initialSession.spaceDomain).toBe("example.com");
    expect(initialSession.spaces).toEqual([]);
    const operationId = crypto.randomUUID();
    const handle = `test-${crypto.randomUUID()}`;
    expect(await (await f.request(`/handle?value=${handle.toUpperCase()}`, f.sessionSecret)).json()).toEqual({ available: true });
    const input: JsonObject = { operationId, handle: handle.toUpperCase() };
    if (optedIn) input.productEmails = { wordingVersion: "ship-product-updates-2026-10-26", locale: "en" };
    expect((await f.request("/spaces", undefined, input)).status).toBe(401);
    const first = await (await f.request("/spaces", f.sessionSecret, input)).json<{ origin: string; onboardingToken: string }>();
    expect(first.origin).toBe(`https://${handle}.${initialSession.spaceDomain}`);
    expect(await (await f.request(`/handle?value=${handle.toUpperCase()}`, f.sessionSecret)).json()).toEqual({ available: false });
    f.restart();
    const resumed = await (await f.request("/spaces", f.sessionSecret, input)).json<typeof first>();
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
    const subscribe = vi.fn().mockResolvedValue(undefined);
    const config = { PRODUCT_EMAIL: { subscribe } };
    await runProductEmailJobs(env.INSTALLATIONS_DB, config);
    await runProductEmailJobs(env.INSTALLATIONS_DB, config);
    expect(subscribe).toHaveBeenCalledTimes(optedIn ? 1 : 0);
    if (optedIn) {
      expect(await marketing()).toMatchObject({ email: f.challenge.email, completed_at: expect.any(Number), attempts: 1, ip: null });
      expect(subscribe.mock.calls[0][0]).toMatchObject({ emailAddress: f.challenge.email, source: "ship-signup", consentBasis: "signup-checkbox" });
    } else expect(await marketing()).toBeNull();
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

it("returns unavailable for normalized policy matches and rejects direct creation with a field error", async () => {
  const f = await fixture();
  await f.signIn();
  const policy = new UsernamePolicy(env.INSTALLATIONS_DB);
  const initial = await policy.list();
  try {
    await policy.replace({ reserved: "Shíp.Support", blocked: "Bád_Name" });
    for (const handle of ["SHIP-SUPPORT", "BAD-NAME"]) {
      expect(await (await f.request(`/handle?value=${handle}`, f.sessionSecret)).json()).toEqual({ available: false });
      const operationId = crypto.randomUUID();
      const denied = await f.request("/spaces", f.sessionSecret, { operationId, handle });
      expect(denied.status).toBe(400);
      expect(await denied.json()).toEqual({ error: "This username is unavailable. Choose another.", code: "handle_unavailable" });
      expect(await f.accounts.getReservationByOperation(operationId)).toBeNull();
    }
  } finally {
    await policy.replace({ reserved: initial.reserved.join("\n"), blocked: initial.blocked.join("\n") });
  }
});

