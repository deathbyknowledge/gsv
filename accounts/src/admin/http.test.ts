import { describe, expect, it, vi } from "vitest";
import { AccountsAdminHttp } from "./http";
import type { AdminInstallation, IssuedAdminInstallation } from "./service";

const ACCOUNT_ORIGIN = "https://gsv.space";

function installation(): AdminInstallation {
  return {
    installationId: "inst_admin_http",
    handle: "reviewer",
    canonicalOrigin: "https://reviewer.gsv.space",
    state: "provisioning",
    operationState: "provisioning",
    onboardingExpiresAt: 1_800_000,
    createdAt: 1_000_000,
    activatedAt: null,
    inference: {
      period: "2026-08",
      requests: 2,
      tokens: 3,
      costNanoUsd: 340,
      failed: 0,
      aborted: 0,
      abandoned: 0,
    },
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
  it("denies the operator surface before reading registry state", async () => {
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

  it("renders the registry without exposing claim material from its list", async () => {
    const http = new AccountsAdminHttp(
      service(),
      { allows: vi.fn(async () => true) },
      ACCOUNT_ORIGIN,
    );

    const response = await http.handle(new Request(`${ACCOUNT_ORIGIN}/admin`));
    const body = await response?.text();
    expect(response?.headers.get("referrer-policy")).toBe("same-origin");
    expect(body).toContain("Create installation");
    expect(body).toContain("reviewer");
    expect(body).toContain("3 tokens");
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

    expect(response?.status).toBe(201);
    expect(await response?.text()).toContain("onboard_secret");
    expect(adminService.create).toHaveBeenCalledWith({
      operationId: "operation_admin_http",
      handle: "reviewer",
    });
  });

  it("rejects cross-origin mutations", async () => {
    const adminService = service();
    const http = new AccountsAdminHttp(
      adminService,
      { allows: vi.fn(async () => true) },
      ACCOUNT_ORIGIN,
    );
    const response = await http.handle(new Request(
      `${ACCOUNT_ORIGIN}/admin/api/installations`,
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
});
