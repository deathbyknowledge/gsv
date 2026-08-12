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
      enabled: false,
      monthlyLimitNanoUsd: 0,
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
    overview: vi.fn(async () => ({
      inference: { enabled: false },
      installations: [installation()],
    })),
    create: vi.fn(async () => issued()),
    reissueOnboarding: vi.fn(async () => issued()),
    setInferenceControl: vi.fn(async () => {}),
    setInstallationInferencePolicy: vi.fn(async () => {}),
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
    expect(adminService.overview).not.toHaveBeenCalled();
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

  it("updates global and installation inference policy through the API", async () => {
    const adminService = service();
    const http = new AccountsAdminHttp(
      adminService,
      { allows: vi.fn(async () => true) },
      ACCOUNT_ORIGIN,
    );

    const controlResponse = await http.handle(new Request(
      `${ACCOUNT_ORIGIN}/admin/api/inference`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: ACCOUNT_ORIGIN,
        },
        body: JSON.stringify({ enabled: true }),
      },
    ));
    expect(controlResponse?.status).toBe(200);
    expect(adminService.setInferenceControl).toHaveBeenCalledWith(true);

    const policyResponse = await http.handle(new Request(
      `${ACCOUNT_ORIGIN}/admin/api/installations/inst_admin_http/inference`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: ACCOUNT_ORIGIN,
        },
        body: JSON.stringify({
          enabled: true,
          monthlyLimitNanoUsd: 5_000_000_000,
        }),
      },
    ));
    expect(policyResponse?.status).toBe(200);
    expect(adminService.setInstallationInferencePolicy).toHaveBeenCalledWith(
      "inst_admin_http",
      { enabled: true, monthlyLimitNanoUsd: 5_000_000_000 },
    );
  });

  it("converts the operator form allowance to exact nano-dollars", async () => {
    const adminService = service();
    const http = new AccountsAdminHttp(
      adminService,
      { allows: vi.fn(async () => true) },
      ACCOUNT_ORIGIN,
    );
    const response = await http.handle(new Request(
      `${ACCOUNT_ORIGIN}/admin/installations/inst_admin_http/inference`,
      {
        method: "POST",
        headers: { origin: ACCOUNT_ORIGIN },
        body: new URLSearchParams({
          enabled: "true",
          monthlyLimitUsd: "12.345678901",
        }),
      },
    ));

    expect(response?.status).toBe(200);
    expect(adminService.setInstallationInferencePolicy).toHaveBeenCalledWith(
      "inst_admin_http",
      { enabled: true, monthlyLimitNanoUsd: 12_345_678_901 },
    );
  });
});
