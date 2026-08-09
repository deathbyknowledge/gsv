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
  });

  it("verifies production requests against the configured Access identity", async () => {
    const verify = vi.fn(async () => undefined);
    const access = new EnvironmentAccountsAdminAccess({
      ENVIRONMENT: "production",
      GSV_ACCOUNT_ORIGIN: "https://gsv.space",
      GSV_ADMIN_ACCESS_TEAM_DOMAIN: "https://gsv.cloudflareaccess.com",
      GSV_ADMIN_ACCESS_AUD: "admin-audience",
    }, verify);
    const request = new Request("https://gsv.space/admin", {
      headers: { "cf-access-jwt-assertion": "signed-token" },
    });

    await expect(access.allows(request)).resolves.toBe(true);
    expect(verify).toHaveBeenCalledWith(
      "signed-token",
      "https://gsv.cloudflareaccess.com",
      "admin-audience",
    );
  });

  it("fails closed without valid production Access configuration", async () => {
    const access = new EnvironmentAccountsAdminAccess({
      ENVIRONMENT: "production",
      GSV_ACCOUNT_ORIGIN: "https://gsv.space",
      GSV_ADMIN_ACCESS_TEAM_DOMAIN: "https://example.com",
      GSV_ADMIN_ACCESS_AUD: "admin-audience",
    });
    await expect(access.allows(new Request(
      "https://gsv.space/admin",
      { headers: { "cf-access-jwt-assertion": "signed-token" } },
    ))).resolves.toBe(false);
  });
});
