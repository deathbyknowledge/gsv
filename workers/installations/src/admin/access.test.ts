import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CloudflareInstallationAdminAccess,
  type InstallationAdminAccessConfiguration,
} from "./access";

afterEach(() => { vi.restoreAllMocks(); });

const production: InstallationAdminAccessConfiguration = {
  environment: "production",
  origin: "https://installations.example.com",
  teamDomain: "https://operator.cloudflareaccess.com",
  audience: "installation-admin",
};

function request(token?: string): Request {
  return new Request(`${production.origin}/admin`, {
    headers: token === undefined ? {} : { "cf-access-jwt-assertion": token },
  });
}

describe("installation admin access", () => {
  it("admits only the configured localhost origin in development", async () => {
    const verify = vi.fn(async () => undefined);
    const access = new CloudflareInstallationAdminAccess({
      environment: "development", origin: "http://localhost:8976",
    }, verify);
    await expect(access.allows(new Request("http://localhost:8976/admin"))).resolves.toBe(true);
    for (const url of [
      "http://local.localhost:8976/admin",
      "http://127.0.0.1:8976/admin",
      "http://localhost:8977/admin",
      "https://localhost:8976/admin",
      "https://installations.example.com/admin",
    ]) {
      await expect(access.allows(new Request(url))).resolves.toBe(false);
    }
    expect(verify).not.toHaveBeenCalled();
  });

  it.each([
    "", "not a URL", "http://localhost:8976/", "http://localhost:8976/admin",
    "https://localhost:8976", "http://127.0.0.1:8976", "http://local.localhost:8976",
  ])("rejects invalid development origin %j", async (origin) => {
    const access = new CloudflareInstallationAdminAccess({ environment: "development", origin });
    await expect(access.allows(new Request("http://localhost:8976/admin"))).resolves.toBe(false);
  });

  it("verifies production assertions against the configured issuer and audience", async () => {
    const verify = vi.fn(async () => undefined);
    const access = new CloudflareInstallationAdminAccess({ ...production, audience: " installation-admin " }, verify);
    await expect(access.allows(request(" signed-token "))).resolves.toBe(true);
    expect(verify).toHaveBeenCalledWith("signed-token", production.teamDomain, "installation-admin");
  });

  it.each([
    undefined, "", "not a URL", "https://example.com", "http://operator.cloudflareaccess.com",
    "https://operator.cloudflareaccess.com/", "https://operator.cloudflareaccess.com/path",
    "https://operator.cloudflareaccess.com.evil.example", "https://user@operator.cloudflareaccess.com",
  ])("fails closed for invalid Access team domain %j", async (teamDomain) => {
    const verify = vi.fn(async () => undefined);
    const access = new CloudflareInstallationAdminAccess({ ...production, teamDomain }, verify);
    await expect(access.allows(request("signed-token"))).resolves.toBe(false);
    expect(verify).not.toHaveBeenCalled();
  });

  it("requires a nonempty audience and assertion before invoking the verifier", async () => {
    const verify = vi.fn(async () => undefined);
    for (const audience of [undefined, "", "  "]) {
      const access = new CloudflareInstallationAdminAccess({ ...production, audience }, verify);
      await expect(access.allows(request("signed-token"))).resolves.toBe(false);
    }
    const access = new CloudflareInstallationAdminAccess(production, verify);
    for (const token of [undefined, "", "  "]) {
      await expect(access.allows(request(token))).resolves.toBe(false);
    }
    expect(verify).not.toHaveBeenCalled();
  });

  it("fails closed when verification rejects", async () => {
    const access = new CloudflareInstallationAdminAccess(production, async () => {
      throw new Error("verification unavailable");
    });
    await expect(access.allows(request("signed-token"))).resolves.toBe(false);
  });

  it("does not admit unknown environments or allow localhost to bypass production verification", async () => {
    const verify = vi.fn(async () => undefined);
    for (const environment of ["", "staging", "test"]) {
      const access = new CloudflareInstallationAdminAccess({ ...production, environment }, verify);
      await expect(access.allows(request("signed-token"))).resolves.toBe(false);
    }
    const access = new CloudflareInstallationAdminAccess({ ...production, origin: "http://localhost:8976" }, verify);
    await expect(access.allows(new Request("http://localhost:8976/admin"))).resolves.toBe(false);
    expect(verify).not.toHaveBeenCalled();
  });

  it("validates signed RS256 tokens with the real verifier and rejects invalid claims, signatures, and algorithms", async () => {
    const keys = await generateKeyPair("RS256");
    const otherKeys = await generateKeyPair("RS256");
    const publicKey = { ...await exportJWK(keys.publicKey), kid: "access-test-key", alg: "RS256" };
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      expect(String(input)).toBe(`${production.teamDomain}/cdn-cgi/access/certs`);
      return Response.json({ keys: [publicKey] });
    });
    const access = new CloudflareInstallationAdminAccess(production);
    const signed = async (issuer: string, audience: string, expiration = "5m", key = keys.privateKey) => new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: "access-test-key" })
      .setIssuer(issuer).setAudience(audience).setIssuedAt().setExpirationTime(expiration).sign(key);
    await expect(access.allows(request(await signed(production.teamDomain!, production.audience!)))).resolves.toBe(true);
    for (const token of [
      await signed("https://other.cloudflareaccess.com", production.audience!),
      await signed(production.teamDomain!, "other-application"),
      await signed(production.teamDomain!, production.audience!, "-1m"),
      await signed(production.teamDomain!, production.audience!, "5m", otherKeys.privateKey),
      await new SignJWT({}).setProtectedHeader({ alg: "HS256" })
        .setIssuer(production.teamDomain!).setAudience(production.audience!)
        .setExpirationTime("5m").sign(crypto.getRandomValues(new Uint8Array(32))),
      "not-a-jwt",
    ]) {
      await expect(access.allows(request(token))).resolves.toBe(false);
    }
    expect(fetch).toHaveBeenCalled();
  });
});
