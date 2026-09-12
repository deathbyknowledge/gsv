import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InstallationOwnerAuthStore, OWNER_CODE_RESEND_MS } from "./owner-auth-store";
import { InstallationOwnerEmailHttp } from "./owner-email-http";
import { InstallationOwnerStore } from "./owner-store";
import { AccountStore } from "./store";
import { sha256Hex } from "./tokens";

const ORIGIN = "https://accounts.example.com";
const SESSION = "__Host-gsv-owner-session";
type Form = Record<string, string>;
type Cookies = Map<string, string>;
afterEach(() => vi.restoreAllMocks());

function cookieHeader(cookies: Cookies): string {
  return [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
}
function receiveCookies(cookies: Cookies, response: Response): void {
  for (const value of response.headers.getSetCookie()) {
    const [pair] = value.split(";");
    const index = pair.indexOf("=");
    const name = pair.slice(0, index);
    if (value.includes("Max-Age=0")) cookies.delete(name);
    else cookies.set(name, pair.slice(index + 1));
  }
}
async function formFields(response: Response): Promise<Form> {
  const text = await response.text();
  return Object.fromEntries([...text.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)]
    .map((match) => [match[1], match[2].replaceAll("&amp;", "&").replaceAll("&quot;", '"')]));
}

async function fixture() {
  let now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const suffix = crypto.randomUUID().slice(0, 8);
  const registry = `principal_email_registry_${suffix}`;
  const accounts = new AccountStore(env.INSTALLATIONS_DB, "example.com");
  await accounts.createPrincipal({ principalId: registry, email: `${suffix}@registry.invalid`, displayName: "Registry", verified: true });
  const owners = new InstallationOwnerStore(env.INSTALLATIONS_DB, registry);
  const auth = new InstallationOwnerAuthStore(env.INSTALLATIONS_DB, "http-test-secret-".repeat(4));
  const delivered: EmailMessageBuilder[] = [];
  const send = vi.fn(async (message: EmailMessage | EmailMessageBuilder): Promise<EmailSendResult> => {
    if (!("subject" in message)) throw new Error("Expected a composed verification email");
    delivered.push(message);
    return { messageId: crypto.randomUUID() };
  });
  const mail: SendEmail = { send };
  const gateway = { authorizeRootRecovery: vi.fn(async () => ({ authorized: true as const })),
    confirmOwnerLinkAuthorization: vi.fn(async () => ({ authorized: true as const })) };
  const makeHttp = () => new InstallationOwnerEmailHttp(auth, owners, mail, "accounts@example.com", gateway, ORIGIN);
  let http = makeHttp();
  const request = async (path: string, cookies: Cookies, form?: Form, origin = ORIGIN, acceptCookies = true): Promise<Response> => {
    const headers = new Headers({ cookie: cookieHeader(cookies), origin, "cf-connecting-ip": `fixture-${suffix}` });
    const init: RequestInit = { method: form ? "POST" : "GET", headers };
    if (form) {
      headers.set("content-type", "application/x-www-form-urlencoded");
      init.body = new URLSearchParams(form);
    }
    const response = await http.handle(new Request(`${ORIGIN}${path}`, init));
    expect(response).not.toBeNull();
    if (!response) throw new Error("Expected an owner HTTP response");
    if (acceptCookies) receiveCookies(cookies, response);
    return response;
  };
  const start = async (cookies: Cookies, purpose: "login" | "link" | "recover", email: string, extra: Form = {}): Promise<Form> => {
    const response = await request(`/owner/${purpose}`, cookies);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    for (const cookie of response.headers.getSetCookie()) expect(cookie).toContain("Path=/; Secure; HttpOnly; SameSite=Lax");
    return { ...await formFields(response), email, ...extra };
  };
  const code = (index = delivered.length - 1): string => {
    const match = delivered[index]?.text?.match(/code is ([0-9]{6})\./);
    if (!match) throw new Error("Expected a captured verification code");
    return match[1];
  };
  const reserve = async (name: string) => {
    const space = await accounts.reserveInstallation({ principalId: registry, operationId: `operation_${name}_${suffix}`, handle: `${name}-${suffix}` });
    await env.INSTALLATIONS_DB.prepare("UPDATE installations SET state = 'active' WHERE id = ?").bind(space.installationId).run();
    return space;
  };
  const rootProof = async (installationId: string) => {
    const ownerAttemptId = crypto.randomUUID();
    const secret = crypto.randomUUID() + crypto.randomUUID();
    await owners.beginLink({ installationId, attemptId: ownerAttemptId, secretHash: await sha256Hex(secret) });
    return { ownerAttemptId, secret };
  };
  const link = async (cookies: Cookies, email: string, installationId: string) => {
    const form = await start(cookies, "link", email, await rootProof(installationId));
    expect((await request("/owner/link", cookies, form)).status).toBe(200);
    const verification = { ...form, code: code() };
    expect((await request("/owner/verify", cookies, verification)).status).toBe(303);
    return verification;
  };
  return { accounts, owners, auth, gateway, delivered, send, request, start, code, reserve, rootProof, link,
    registry, email: `${suffix}@example.com`, otherEmail: `${suffix}-other@example.com`,
    advance: () => { now += OWNER_CODE_RESEND_MS; }, restart: () => { http = makeHttp(); } };
}

describe("native owner email HTTP", () => {
  it("signs in through delivered code, retries a lost response, lists spaces and revokes logout server-side", async () => {
    const f = await fixture();
    const cookies: Cookies = new Map();
    expect((await f.request("/owner/spaces", cookies)).headers.get("location")).toBe("/owner/login");
    const form = await f.start(cookies, "login", f.email);
    expect((await f.request("/owner/login", cookies, form)).status).toBe(200);
    expect((await f.request("/owner/login", cookies, form)).status).toBe(200);
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(cookies.has(SESSION)).toBe(false);
    const verify = { ...form, code: f.code() };
    const lost = await f.request("/owner/verify", cookies, verify, ORIGIN, false);
    expect(lost.status).toBe(303);
    const initialSession = lost.headers.getSetCookie().find((value) => value.startsWith(`${SESSION}=`));
    f.restart();
    const retry = await f.request("/owner/verify", cookies, verify);
    expect(retry.status).toBe(303);
    expect(retry.headers.getSetCookie().find((value) => value.startsWith(`${SESSION}=`))).toBe(initialSession);
    const session = await f.auth.session(cookies.get(SESSION)!);
    expect(session?.email).toBe(f.email);
    const page = await f.request("/owner/spaces", cookies);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("No spaces linked yet");
    const copiedSession = new Map(cookies);
    expect((await f.request("/owner/logout", cookies, {})).status).toBe(303);
    expect(cookies.has(SESSION)).toBe(false);
    expect(await f.auth.session(copiedSession.get(SESSION)!)).toBeNull();
    expect((await f.request("/owner/spaces", copiedSession)).headers.get("location")).toBe("/owner/login");
    expect((await f.request("/owner/verify", copiedSession, verify)).status).toBe(400);
  });

  it("shows only each owner's spaces while one owner can link multiple spaces", async () => {
    const f = await fixture();
    const alice: Cookies = new Map();
    const bob: Cookies = new Map();
    const first = await f.reserve("first");
    const second = await f.reserve("second");
    const other = await f.reserve("other");
    await f.link(alice, f.email, first.installationId);
    f.advance();
    await f.link(alice, f.email, second.installationId);
    await f.link(bob, f.otherEmail, other.installationId);
    f.restart();
    const a = await (await f.request("/owner/spaces", alice)).text();
    const b = await (await f.request("/owner/spaces", bob)).text();
    expect(a).toContain(first.canonicalOrigin);
    expect(a).toContain(second.canonicalOrigin);
    expect(a).not.toContain(other.canonicalOrigin);
    expect(b).toContain(other.canonicalOrigin);
    expect(b).not.toContain(first.canonicalOrigin);
    expect(b).not.toContain(second.canonicalOrigin);
    expect((await f.auth.session(alice.get(SESSION)!))?.principalId).not.toBe((await f.auth.session(bob.get(SESSION)!))?.principalId);
    f.advance();
    const wrongOwner = await f.start(bob, "recover", f.otherEmail, { handle: first.handle });
    const count = f.send.mock.calls.length;
    expect((await f.request("/owner/recover", bob, wrongOwner)).status).toBeGreaterThanOrEqual(400);
    expect(f.send).toHaveBeenCalledTimes(count);
    expect(f.gateway.authorizeRootRecovery).not.toHaveBeenCalled();
  });

  it("requires both root and email proofs and resumes the same claim after a gateway failure", async () => {
    const f = await fixture();
    const space = await f.reserve("link");
    const cookies: Cookies = new Map();
    const proof = await f.rootProof(space.installationId);
    const form = await f.start(cookies, "link", f.email, proof);
    expect((await f.request("/owner/link", cookies, { ...form, secret: "wrong-proof" })).status).toBe(400);
    expect(f.send).not.toHaveBeenCalled();
    expect((await f.owners.get(proof.ownerAttemptId))?.state).toBe("pending");
    expect((await f.request("/owner/link", cookies, form)).status).toBe(200);
    expect((await f.owners.get(proof.ownerAttemptId))?.state).toBe("authenticating");
    expect(f.gateway.confirmOwnerLinkAuthorization).not.toHaveBeenCalled();
    const verification = { ...form, code: f.code() };
    f.gateway.confirmOwnerLinkAuthorization.mockRejectedValueOnce(new Error("private-gateway-material"));
    const failed = await f.request("/owner/verify", cookies, verification);
    expect(failed.status).toBe(400);
    expect(await failed.text()).not.toContain("private-gateway-material");
    expect(await env.INSTALLATIONS_DB.prepare("SELECT owner_principal_id FROM installations WHERE id = ?").bind(space.installationId).first("owner_principal_id")).toBe(f.registry);
    const principal = (await f.owners.get(proof.ownerAttemptId))?.principal_id;
    f.restart();
    const retry = await f.request("/owner/verify", cookies, verification);
    expect(retry.status).toBe(303);
    expect(retry.headers.get("location")).toBe(`${space.canonicalOrigin}/?owner=linked`);
    expect((await f.owners.get(proof.ownerAttemptId))?.principal_id).toBe(principal);
    expect(f.gateway.confirmOwnerLinkAuthorization).toHaveBeenLastCalledWith({ installationId: space.installationId, attemptId: proof.ownerAttemptId });
    expect((await f.request("/owner/verify", cookies, verification)).status).toBe(303);
    expect(f.gateway.confirmOwnerLinkAuthorization).toHaveBeenCalledTimes(2);
    expect(f.send).toHaveBeenCalledTimes(1);
  });

  it("requires a new purpose-bound code for root recovery even with an existing owner session", async () => {
    const f = await fixture();
    const cookies: Cookies = new Map();
    const space = await f.reserve("recover");
    const linked = await f.link(cookies, f.email, space.installationId);
    f.advance();
    const recovery = await f.start(cookies, "recover", f.email, { handle: space.handle });
    expect((await f.request("/owner/recover", cookies, recovery)).status).toBe(200);
    expect(f.gateway.authorizeRootRecovery).not.toHaveBeenCalled();
    expect((await f.request("/owner/verify", cookies, { ...linked, purpose: "recover", ownerAttemptId: recovery.ownerAttemptId })).status).toBe(400);
    expect(f.gateway.authorizeRootRecovery).not.toHaveBeenCalled();
    const verified = { ...recovery, code: f.code() };
    const response = await f.request("/owner/verify", cookies, verified);
    expect(response.status).toBe(303);
    const target = new URL(response.headers.get("location")!);
    expect(target.origin).toBe(space.canonicalOrigin);
    expect(target.pathname).toBe("/recover");
    const fragment = new URLSearchParams(target.hash.slice(1));
    expect(fragment.get("id")).toBe(recovery.ownerAttemptId);
    expect(f.gateway.authorizeRootRecovery).toHaveBeenCalledWith({ installationId: space.installationId,
      attemptId: recovery.ownerAttemptId, purpose: "root-password-reset", secretHash: await sha256Hex(fragment.get("secret")!), expiresAt: expect.any(Number) });
    f.restart();
    expect((await f.request("/owner/verify", cookies, verified)).headers.get("location")).toBe(target.href);
  });

  it("rejects wrong origins, browsers and purposes without issuing a session", async () => {
    const f = await fixture();
    const cookies: Cookies = new Map();
    const form = await f.start(cookies, "login", f.email);
    expect((await f.request("/owner/login", cookies, form, "https://other.example.com")).status).toBe(403);
    expect((await f.request("/owner/login", cookies, form, "")).status).toBe(403);
    expect((await f.request("/owner/login", new Map(), form)).status).toBe(400);
    expect(f.send).not.toHaveBeenCalled();
    expect((await f.request("/owner/login", cookies, form)).status).toBe(200);
    const verified = { ...form, code: f.code() };
    const stranger = new Map([...cookies].map(([name]) => [name, "a".repeat(64)]));
    expect((await f.request("/owner/verify", stranger, verified)).status).toBe(400);
    expect((await f.request("/owner/verify", cookies, { ...verified, purpose: "link", ownerAttemptId: crypto.randomUUID() })).status).toBe(400);
    expect(cookies.has(SESSION)).toBe(false);
    expect(stranger.has(SESSION)).toBe(false);
    expect((await f.request("/owner/verify", cookies, verified)).status).toBe(303);
  });

  it("keeps independent first-page browser proofs usable in parallel tabs", async () => {
    const f = await fixture();
    const cookies: Cookies = new Map();
    const first = await f.start(cookies, "login", f.email);
    const second = await f.start(cookies, "login", f.otherEmail);
    expect((await f.request("/owner/login", cookies, first)).status).toBe(200);
    const firstCode = f.code();
    expect((await f.request("/owner/login", cookies, second)).status).toBe(200);
    expect((await f.request("/owner/verify", cookies, { ...second, code: f.code() })).status).toBe(303);
    expect((await f.auth.session(cookies.get(SESSION)!))?.email).toBe(f.otherEmail);
    expect((await f.request("/owner/verify", cookies, { ...first, code: firstCode })).status).toBe(303);
    expect((await f.auth.session(cookies.get(SESSION)!))?.email).toBe(f.email);
  });

  it("reports delivery failure truthfully and retries after cooldown without duplicating ordinary submissions", async () => {
    const f = await fixture();
    const cookies: Cookies = new Map();
    const form = await f.start(cookies, "login", f.email);
    f.send.mockRejectedValueOnce(new Error("private-provider-response-123456"));
    const failed = await f.request("/owner/login", cookies, form);
    expect(failed.status).toBe(503);
    const body = await failed.text();
    expect(body).toContain("could not send");
    expect(body).not.toContain("private-provider-response-123456");
    expect(f.delivered).toHaveLength(0);
    expect((await f.request("/owner/resend", cookies, form)).status).toBe(202);
    expect(f.send).toHaveBeenCalledTimes(1);
    f.advance();
    expect((await f.request("/owner/resend", cookies, form)).status).toBe(200);
    expect(f.delivered).toHaveLength(1);
    expect((await f.request("/owner/login", cookies, form)).status).toBe(200);
    expect(f.send).toHaveBeenCalledTimes(2);
    f.advance();
    expect((await f.request("/owner/resend", cookies, form)).status).toBe(200);
    expect(f.send).toHaveBeenCalledTimes(3);
    expect(f.delivered).toHaveLength(2);
    expect((await f.request("/owner/verify", cookies, { ...form, code: f.code() })).status).toBe(303);
  });
});
