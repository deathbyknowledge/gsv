import { describe, expect, it, vi } from "vitest";
import { EnvironmentAccountsAdminAccess } from "./access";

describe("accounts admin access", () => {
  it("admits only the exact loopback account origin in development", async () => {
    const access = new EnvironmentAccountsAdminAccess({
      ENVIRONMENT: "development",
      GSV_ACCOUNT_ORIGIN: "http://localhost:8976",
    });

    await expect(access.allows(new Request(
      "http://localhost:8976/admin",
    ))).resolves.toBe(true);
    await expect(access.allows(new Request(
      "http://local.localhost:8976/admin",
    ))).resolves.toBe(false);
    await expect(access.allows(new Request(
      "https://localhost:8976/admin",
    ))).resolves.toBe(false);
  });

  it("rejects a development boundary that is not exact HTTP localhost", async () => {
    const access = new EnvironmentAccountsAdminAccess({
      ENVIRONMENT: "development",
      GSV_ACCOUNT_ORIGIN: "https://accounts.gsv.space",
    });

    await expect(access.allows(new Request(
      "https://accounts.gsv.space/admin",
    ))).resolves.toBe(false);
  });

  it("verifies the production Access assertion against exact configuration", async () => {
    const verify = vi.fn(async () => undefined);
    const access = new EnvironmentAccountsAdminAccess({
      ENVIRONMENT: "production",
      GSV_ACCOUNT_ORIGIN: "https://accounts.gsv.space",
      GSV_ADMIN_ACCESS_TEAM_DOMAIN: "https://gsv.cloudflareaccess.com",
      GSV_ADMIN_ACCESS_AUD: "admin-audience",
    }, verify);

    await expect(access.allows(new Request(
      "https://accounts.gsv.space/admin",
      { headers: { "cf-access-jwt-assertion": "signed-token" } },
    ))).resolves.toBe(true);
    expect(verify).toHaveBeenCalledWith(
      "signed-token",
      "https://gsv.cloudflareaccess.com",
      "admin-audience",
    );
  });

  it("fails closed for absent, malformed, or rejected Access configuration", async () => {
    const rejected = new EnvironmentAccountsAdminAccess({
      ENVIRONMENT: "production",
      GSV_ACCOUNT_ORIGIN: "https://accounts.gsv.space",
      GSV_ADMIN_ACCESS_TEAM_DOMAIN: "https://gsv.cloudflareaccess.com",
      GSV_ADMIN_ACCESS_AUD: "admin-audience",
    }, async () => {
      throw new Error("invalid token");
    });
    const missing = new EnvironmentAccountsAdminAccess({
      ENVIRONMENT: "production",
      GSV_ACCOUNT_ORIGIN: "https://accounts.gsv.space",
    });
    const malformed = new EnvironmentAccountsAdminAccess({
      ENVIRONMENT: "production",
      GSV_ACCOUNT_ORIGIN: "https://accounts.gsv.space",
      GSV_ADMIN_ACCESS_TEAM_DOMAIN: "https://example.com",
      GSV_ADMIN_ACCESS_AUD: "admin-audience",
    });
    const request = new Request("https://accounts.gsv.space/admin", {
      headers: { "cf-access-jwt-assertion": "signed-token" },
    });

    await expect(rejected.allows(request)).resolves.toBe(false);
    await expect(missing.allows(request)).resolves.toBe(false);
    await expect(malformed.allows(request)).resolves.toBe(false);
  });
});
