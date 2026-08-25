import { describe, expect, it, vi } from "vitest";
import { AccountsAdminHttp } from "./http";
import type { AdminInstallation, IssuedAdminInstallation } from "./service";

const ACCOUNT_ORIGIN = "https://accounts.gsv.space";

function installation(): AdminInstallation {
  return {
    installationId: "inst_admin_http",
    handle: "reviewer",
    canonicalOrigin: "https://reviewer.gsv.space",
    state: "provisioning",
    operationState: "provisioning",
    entitlementState: "active",
    planKey: "managed-preview",
    onboardingExpiresAt: 1_800_000,
    createdAt: 1_000_000,
    activatedAt: null,
  };
}

function issued(): IssuedAdminInstallation {
  return {
    installation: installation(),
    onboarding: {
      installationId: "inst_admin_http",
      onboardingUrl: "https://reviewer.gsv.space/onboarding#onboard_secret",
      expiresAt: 1_800_000,
    },
  };
}

function service() {
  return {
    list: vi.fn(async () => [installation()]),
    create: vi.fn(async () => issued()),
    reissueOnboarding: vi.fn(async () => issued()),
  };
}

describe("accounts admin HTTP", () => {
  it("does not claim non-admin account routes", async () => {
    const http = new AccountsAdminHttp(
      service(),
      { allows: vi.fn(async () => true) },
      ACCOUNT_ORIGIN,
    );

    await expect(http.handle(new Request(
      `${ACCOUNT_ORIGIN}/api/session`,
    ))).resolves.toBeNull();
  });

  it("denies the entire operator surface before reading registry state", async () => {
    const adminService = service();
    const http = new AccountsAdminHttp(
      adminService,
      { allows: vi.fn(async () => false) },
      ACCOUNT_ORIGIN,
    );

    const response = await http.handle(new Request(`${ACCOUNT_ORIGIN}/admin`));

    expect(response?.status).toBe(403);
    expect(adminService.list).not.toHaveBeenCalled();
  });

  it("renders a task-oriented installation registry without claim material", async () => {
    const http = new AccountsAdminHttp(
      service(),
      { allows: vi.fn(async () => true) },
      ACCOUNT_ORIGIN,
    );

    const response = await http.handle(new Request(`${ACCOUNT_ORIGIN}/admin`));
    const body = await response?.text();

    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-security-policy")).toContain(
      "form-action 'self'",
    );
    expect(response?.headers.get("referrer-policy")).toBe("same-origin");
    expect(body).toContain("Create installation");
    expect(body).not.toContain('name="referrer"');
    expect(body).toContain("reviewer.gsv.space");
    expect(body).toContain("Reissue link");
    expect(body).not.toContain("onboard_secret");
  });

  it("creates through the canonical form and shows the capability once", async () => {
    const adminService = service();
    const http = new AccountsAdminHttp(
      adminService,
      { allows: vi.fn(async () => true) },
      ACCOUNT_ORIGIN,
    );
    const response = await http.handle(new Request(
      `${ACCOUNT_ORIGIN}/admin/installations`,
      {
        method: "POST",
        headers: { origin: ACCOUNT_ORIGIN },
        body: new URLSearchParams({
          operationId: "operation_admin_http",
          handle: "reviewer",
        }),
      },
    ));
    const body = await response?.text();

    expect(response?.status).toBe(201);
    expect(adminService.create).toHaveBeenCalledWith({
      operationId: "operation_admin_http",
      handle: "reviewer",
    });
    expect(body).toContain("ONBOARDING LINK ISSUED");
    expect(body).toContain("onboard_secret");
    expect(response?.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects cross-origin mutations", async () => {
    const adminService = service();
    const http = new AccountsAdminHttp(
      adminService,
      { allows: vi.fn(async () => true) },
      ACCOUNT_ORIGIN,
    );
    const response = await http.handle(new Request(
      `${ACCOUNT_ORIGIN}/api/admin/installations`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://attacker.example",
        },
        body: JSON.stringify({
          operationId: "operation_cross_origin",
          handle: "attacker",
        }),
      },
    ));

    expect(response?.status).toBe(403);
    expect(adminService.create).not.toHaveBeenCalled();
  });

  it("uses the same service operations through the private JSON API", async () => {
    const adminService = service();
    const http = new AccountsAdminHttp(
      adminService,
      { allows: vi.fn(async () => true) },
      ACCOUNT_ORIGIN,
    );

    const list = await http.handle(new Request(
      `${ACCOUNT_ORIGIN}/api/admin/installations`,
    ));
    const reissue = await http.handle(new Request(
      `${ACCOUNT_ORIGIN}/api/admin/installations/inst_admin_http/onboarding`,
      { method: "POST", headers: { origin: ACCOUNT_ORIGIN } },
    ));

    await expect(list?.json()).resolves.toEqual({
      installations: [installation()],
    });
    await expect(reissue?.json()).resolves.toEqual(issued());
    expect(adminService.reissueOnboarding).toHaveBeenCalledWith(
      "inst_admin_http",
    );
  });
});
