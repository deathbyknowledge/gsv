import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { handleInstallationOwnerRequest } from "./owner-front-door";
import { ownerIdentityEnabled, type InstallationOwnerEnvironment } from "./owner-service";

const origin = "https://accounts.example.com";
function environment(): InstallationOwnerEnvironment {
  return { INSTALLATIONS_DB: env.INSTALLATIONS_DB, GSV_ADMIN_ORIGIN: origin,
    OWNER_EMAIL: { send: vi.fn(async () => ({ messageId: "fixture" })) },
    GSV_OWNER_EMAIL_FROM: "accounts@example.com", GSV_OWNER_AUTH_SECRET: "fixture-secret-".repeat(4),
    ACCOUNTS_GATEWAY_RECOVERY: { authorizeRootRecovery: vi.fn(async () => ({ authorized: true as const })),
      confirmOwnerLinkAuthorization: vi.fn(async () => ({ authorized: true as const })) } };
}

describe("shared owner front door", () => {
  it("opens native sign-in without an identity provider and leaves administration separate", async () => {
    const config = environment();
    const get = (path: string) => handleInstallationOwnerRequest(new Request(`${origin}${path}`), config, "registry");
    expect(ownerIdentityEnabled(config)).toBe(true);
    expect((await get("/"))?.headers.get("location")).toBe("/owner/spaces");
    expect((await get("/owner/spaces"))?.headers.get("location")).toBe("/owner/login");
    const login = await get("/owner/login");
    expect(login?.status).toBe(200);
    expect(await login?.text()).toContain('action="/owner/login"');
    expect(await get("/admin")).toBeNull();
    expect(await get("/operator")).toBeNull();
    expect(config.OWNER_EMAIL?.send).not.toHaveBeenCalled();
    expect((await handleInstallationOwnerRequest(new Request("https://evil.example/owner/login"), config, "registry"))?.status).toBe(404);
  });

  it("retains provider-only links and exposes explicit provider fallback beside native linking", async () => {
    const config = { ...environment(), GSV_OWNER_OIDC_ISSUER: "https://identity.example.com", GSV_OWNER_OIDC_CLIENT_ID: "client" };
    const get = (path: string, value = config) => handleInstallationOwnerRequest(new Request(`${origin}${path}`), value, "registry");
    expect(await (await get("/owner/link"))?.text()).toContain('href="/owner/identity/link"');
    expect(await (await get("/owner/identity/link"))?.text()).toContain('action="/owner/identity/link"');
    expect(await (await get("/owner/identity/recover"))?.text()).toContain('action="/owner/identity/recover"');
    expect((await get("/owner/callback?state=invalid"))?.status).toBe(400);
    expect(await (await get("/owner/link", { ...config, OWNER_EMAIL: undefined }))?.text()).toContain('action="/owner/link"');
  });

  it("fails closed when owner authentication or trusted recovery authority is absent", async () => {
    for (const config of [{ ...environment(), OWNER_EMAIL: undefined }, { ...environment(), ACCOUNTS_GATEWAY_RECOVERY: undefined }]) {
      expect(ownerIdentityEnabled(config)).toBe(false);
      const response = await handleInstallationOwnerRequest(new Request(`${origin}/owner/link`), config, "registry");
      expect(response?.status).toBe(503);
      expect(response?.headers.get("cache-control")).toBe("no-store");
    }
  });
});
