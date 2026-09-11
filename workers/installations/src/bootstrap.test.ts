import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { InstallationAdminService } from "./admin/service";
import { InstallationBootstrapService, type OperatorAccessMode } from "./bootstrap";
import { InstallationOnboardingStore } from "./onboarding";
import { AccountStore } from "./store";
import { createOpaqueToken } from "./tokens";
import { InstallationOperatorHttp, OperatorInstallationAdminAccess } from "./operator-http";

beforeEach(async () => {
  for (const table of ["operator_bootstrap", "operator_credentials", "installation_onboarding_claims", "provisioning_operations",
    "memberships", "hostnames", "installations", "principals"]) {
    await env.INSTALLATIONS_DB.prepare(`DELETE FROM ${table}`).run();
  }
});

async function fixture(mode: OperatorAccessMode = "operator") {
  const accounts = new AccountStore(env.INSTALLATIONS_DB, "example.com", undefined, ["accounts.example.com"]);
  const onboarding = new InstallationOnboardingStore(env.INSTALLATIONS_DB, accounts);
  const admin = new InstallationAdminService(env.INSTALLATIONS_DB, accounts, onboarding,
    { id: "operator_registry", email: "registry@example.invalid", displayName: "Registry" }, {});
  const service = new InstallationBootstrapService(env.INSTALLATIONS_DB, accounts, onboarding, admin, mode);
  const claim = await createOpaqueToken("bootstrap");
  const operator = await createOpaqueToken("operator");
  const setup = await createOpaqueToken("onboard");
  await env.INSTALLATIONS_DB.prepare(
    `INSERT INTO operator_bootstrap (id, claim_id, token_prefix, token_hash, expires_at, access_mode, operation_id, created_at)
     VALUES (1, 'first', ?, ?, ?, ?, 'bootstrap_first', ?)`,
  ).bind(claim.prefix, claim.hash, Date.now() + 60_000, mode, Date.now()).run();
  const input: Parameters<InstallationBootstrapService["redeem"]>[0] = { claim: claim.raw, handle: "first", onboardingToken: setup.raw };
  if (mode === "operator") input.operatorToken = operator.raw;
  return { accounts, onboarding, admin, service, claim, operator, setup, input };
}

describe("first installation bootstrap", () => {
  it("rejects the operator hostname before binding the one-time claim", async () => {
    const state = await fixture();
    await expect(state.service.redeem({ ...state.input, handle: "accounts" })).rejects.toThrow(/operator service/);
    expect((await env.INSTALLATIONS_DB.prepare("SELECT started_at FROM operator_bootstrap").first())?.started_at).toBeNull();
    await expect(state.admin.create({ operationId: "reserved_operator", handle: "accounts" })).rejects.toThrow(/operator service/);
    expect((await state.service.redeem(state.input)).onboardingUrl).toContain("first.example.com");
  });
  it("creates one installation and recovers lost replies without replacing its setup claim", async () => {
    const state = await fixture();
    const first = await state.service.redeem(state.input);
    const before = await env.INSTALLATIONS_DB.prepare("SELECT * FROM installation_onboarding_claims").all();
    expect(await state.service.redeem(state.input)).toEqual(first);
    expect((await env.INSTALLATIONS_DB.prepare("SELECT * FROM installation_onboarding_claims").all()).results).toEqual(before.results);
    expect((await env.INSTALLATIONS_DB.prepare("SELECT COUNT(*) AS n FROM installations").first())?.n).toBe(1);
    expect(first.operatorAccess).toBe(true);
    expect(await state.service.authorizeOperator(state.operator.raw)).toBe(true);
    const secretRows = JSON.stringify((await env.INSTALLATIONS_DB.prepare("SELECT * FROM operator_bootstrap").all()).results)
      + JSON.stringify((await env.INSTALLATIONS_DB.prepare("SELECT * FROM operator_credentials").all()).results);
    expect(secretRows).not.toContain(state.claim.raw);
    expect(secretRows).not.toContain(state.operator.raw);
    expect(secretRows).not.toContain(state.setup.raw);
  });

  it("does not reissue a consumed setup claim and leaves a second installation untouched", async () => {
    const state = await fixture();
    const first = await state.service.redeem(state.input);
    const authorized = await state.onboarding.authorize({ installationId: first.installationId, token: state.setup.raw });
    if (!authorized.ok) throw new Error("Expected setup authorization");
    await state.onboarding.complete({ claimId: authorized.claimId, installationId: first.installationId });
    const second = await state.admin.create({ operationId: "second_create", handle: "second" });
    const before = (await env.INSTALLATIONS_DB.prepare("SELECT * FROM installation_onboarding_claims ORDER BY installation_id").all()).results;
    expect((await state.service.redeem(state.input)).onboardingUrl).toBeNull();
    expect((await env.INSTALLATIONS_DB.prepare("SELECT * FROM installation_onboarding_claims ORDER BY installation_id").all()).results).toEqual(before);
    expect((await state.accounts.resolveHostname("second.example.com"))).toMatchObject({ installationId: second.installation.installationId });
  });

  it("allows Access bootstrap without minting an operator credential", async () => {
    const state = await fixture("access");
    expect((await state.service.redeem(state.input)).operatorAccess).toBe(false);
    expect((await env.INSTALLATIONS_DB.prepare("SELECT * FROM operator_credentials").all()).results).toEqual([]);
    expect(await state.service.authorizeOperator(state.operator.raw)).toBe(false);
  });

  it("rejects expiry and competing attempts before creating another first installation", async () => {
    const state = await fixture();
    await expect(state.service.redeem(state.input, Date.now() + 120_000)).rejects.toThrow(/claim is unavailable/);
    expect((await env.INSTALLATIONS_DB.prepare("SELECT * FROM installations").all()).results).toEqual([]);
    await state.service.redeem(state.input);
    await expect(state.service.redeem({ ...state.input, handle: "different" })).rejects.toThrow(/different attempt/);
    expect((await env.INSTALLATIONS_DB.prepare("SELECT COUNT(*) AS n FROM installations").first())?.n).toBe(1);
  });

  it("keeps explicit setup reissues and rotated operator credentials across bootstrap retries", async () => {
    const state = await fixture();
    const first = await state.service.redeem(state.input);
    const reissued = await state.admin.reissueOnboarding(first.installationId);
    const replacement = await createOpaqueToken("operator");
    await env.INSTALLATIONS_DB.prepare("UPDATE operator_credentials SET token_hash = ?, token_prefix = ?, updated_at = ? WHERE id = 1")
      .bind(replacement.hash, replacement.prefix, Date.now()).run();
    const repeated = await state.service.redeem(state.input);
    expect(repeated.onboardingUrl).toBeNull();
    expect(repeated.operatorAccess).toBe(false);
    expect(await state.service.authorizeOperator(replacement.raw)).toBe(true);
    expect(await state.onboarding.authorize({ installationId: first.installationId,
      token: new URL(reissued.onboarding.onboardingUrl).hash.slice(1) })).toMatchObject({ ok: true });
  });

  it("requires the exact origin, stores an HttpOnly operator cookie, and authenticates administration", async () => {
    const state = await fixture();
    const origin = "https://accounts.example.com";
    const http = new InstallationOperatorHttp(state.service, origin, "operator");
    const request = (requestOrigin: string) => new Request(`${origin}/bootstrap`, { method: "POST",
      headers: { origin: requestOrigin, "content-type": "application/json" }, body: JSON.stringify(state.input) });
    expect((await http.handle(request("https://attacker.example")))?.status).toBe(403);
    expect((await env.INSTALLATIONS_DB.prepare("SELECT COUNT(*) AS n FROM installations").first())?.n).toBe(0);
    const response = await http.handle(request(origin));
    expect(response?.status).toBe(200);
    const cookie = response?.headers.get("set-cookie");
    expect(cookie).toContain("HttpOnly; Secure; SameSite=Strict; Path=/");
    expect(cookie).not.toContain("Domain=");
    const access = new OperatorInstallationAdminAccess(state.service, "operator", { async allows() { return false; } });
    expect(await access.allows(new Request(`${origin}/admin`, { headers: { cookie: cookie ?? "" } }))).toBe(true);
    expect(await access.allows(new Request(`${origin}/admin`))).toBe(false);
    const logout = await http.handle(new Request(`${origin}/operator/logout`, { method: "POST", headers: { origin } }));
    expect(logout?.headers.get("set-cookie")).toContain("Max-Age=0");
    const csrf = await http.handle(new Request(`${origin}/operator/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: state.operator.raw }) }));
    expect(csrf?.status).toBe(403);
  });

  it("keeps bootstrap secrets out of HTML and prevents operator tokens from bypassing Access", async () => {
    const state = await fixture();
    await state.service.redeem(state.input);
    const origin = "https://accounts.example.com";
    const http = new InstallationOperatorHttp(state.service, origin, "operator");
    const page = await http.handle(new Request(`${origin}/bootstrap`));
    expect(page?.headers.get("cache-control")).toBe("no-store");
    expect(page?.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    const html = await page?.text();
    expect(html).not.toContain(state.claim.raw);
    expect(html).not.toContain(state.operator.raw);
    expect((await http.handle(new Request("https://another.example/bootstrap")))?.status).toBe(403);
    const access = new OperatorInstallationAdminAccess(state.service, "access", { async allows() { return false; } });
    expect(await access.allows(new Request(`${origin}/admin`, { headers: { authorization: `Bearer ${state.operator.raw}` } }))).toBe(false);
  });
});
