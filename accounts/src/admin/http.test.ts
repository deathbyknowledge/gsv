import { describe, expect, it, vi } from "vitest";
import { AccountsAdminHttp } from "./http";
import type { ManagedInferenceRoutingUpdate } from "../inference-policy";
import type {
  AdminInferenceOverview,
  AdminInstallation,
  AdminInstallationList,
  AdminInstallationListQuery,
  AdminInstallationSummary,
  IssuedAdminInstallation,
} from "./service";

const ACCOUNT_ORIGIN = "https://gsv.space";

function installation(
  state: AdminInstallation["state"] = "provisioning",
): AdminInstallation {
  return {
    installationId: "inst_admin_http",
    handle: "reviewer",
    canonicalOrigin: "https://reviewer.gsv.space",
    state,
    operationState: "provisioning",
    onboardingExpiresAt: 1_800_000,
    createdAt: 1_000_000,
    activatedAt: null,
    reset: null,
    inference: {
      enabled: false,
      monthlyLimitNanoUsd: 5_000_000_000,
      period: "2026-08",
      requests: 2,
      tokens: 3,
      costNanoUsd: 340,
      failed: 1,
      aborted: 0,
      abandoned: 0,
      mailIntake: { requests: 0, tokens: 0, costNanoUsd: 0 },
    },
  };
}

function installationSummary(
  current = installation(),
): AdminInstallationSummary {
  return {
    installationId: current.installationId,
    handle: current.handle,
    state: current.state,
    operationState: current.operationState,
    createdAt: current.createdAt,
    inferenceEnabled: current.inference.enabled,
  };
}

function installationList(
  current = installation(),
  overrides: Partial<AdminInstallationList> = {},
): AdminInstallationList {
  return {
    query: "",
    state: null,
    page: 1,
    pageSize: 50,
    total: 1,
    totalPages: 1,
    installations: [installationSummary(current)],
    ...overrides,
  };
}

function inferenceOverview(): AdminInferenceOverview {
  return {
    enabled: false,
    routing: {
      version: 1,
      modelId: "deepseek/deepseek-v4-flash-0731",
      displayName: "DeepSeek V4 Flash",
      contextWindow: 1_048_576,
      maxOutputTokens: 384_000,
      reasoning: true,
      inputNanoUsdPerToken: 80,
      outputNanoUsdPerToken: 180,
      cacheReadNanoUsdPerToken: 16,
      cacheWriteNanoUsdPerToken: 0,
      provider: {
        allowFallbacks: true,
        requireParameters: false,
        dataCollection: "allow",
        zdr: false,
        order: [],
        only: [],
        ignore: [],
        quantizations: [],
        sort: "default",
      },
      updatedAt: 0,
    },
    period: "2026-08",
    requests: 10,
    tokens: 50,
    costNanoUsd: 2_000_000_000,
    failed: 1,
    aborted: 2,
    abandoned: 3,
    mailIntake: { requests: 4, tokens: 20, costNanoUsd: 500_000_000 },
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

function resetIssued(): IssuedAdminInstallation {
  const result = issued();
  return {
    ...result,
    installation: {
      ...result.installation,
      installationId: "inst_admin_http_replacement",
      reset: {
        previousInstallationId: "inst_admin_http",
        dataDeletionState: "pending",
      },
    },
    onboarding: {
      ...result.onboarding,
      installationId: "inst_admin_http_replacement",
    },
    reset: {
      previousInstallationId: "inst_admin_http",
      dataDeletionState: "pending",
    },
  };
}

function service(
  current = installation(),
  list = installationList(current),
) {
  return {
    listInstallations: vi.fn(async (_query: AdminInstallationListQuery) => list),
    getInstallation: vi.fn(async (
      _installationId: string,
    ): Promise<AdminInstallation | null> => current),
    inferenceOverview: vi.fn(async () => inferenceOverview()),
    create: vi.fn(async () => issued()),
    reissueOnboarding: vi.fn(async () => issued()),
    resetInstallation: vi.fn(async () => resetIssued()),
    setInferenceControl: vi.fn(async () => {}),
    setInferenceRouting: vi.fn(async (input: ManagedInferenceRoutingUpdate) => ({
      version: 1 as const,
      ...input,
      updatedAt: 2_000_000,
    })),
    setInstallationInferencePolicy: vi.fn(async () => {}),
    setInstallationState: vi.fn(async () => {}),
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
    expect(adminService.listInstallations).not.toHaveBeenCalled();
  });

  it("renders a searchable registry of summary links without inline edits", async () => {
    const adminService = service();
    const http = new AccountsAdminHttp(
      adminService,
      { allows: vi.fn(async () => true) },
      ACCOUNT_ORIGIN,
    );

    const response = await http.handle(new Request(
      `${ACCOUNT_ORIGIN}/admin/installations?q=REVIEW&state=provisioning`,
    ));
    const body = await response?.text();
    expect(response?.headers.get("referrer-policy")).toBe("same-origin");
    expect(adminService.listInstallations).toHaveBeenCalledWith({
      query: "REVIEW",
      state: "provisioning",
      page: 1,
    });
    expect(body).toContain("New installation");
    expect(body).toContain("/admin/installations/inst_admin_http");
    expect(body).toContain("reviewer");
    expect(body).not.toContain("Suspend reviewer");
    expect(body).not.toContain("Monthly USD allowance");
    expect(body).not.toContain("onboard_secret");
  });

  it("preserves search and state while paging the registry", async () => {
    const list = installationList(installation(), {
      query: "review",
      state: "active",
      total: 51,
      totalPages: 2,
    });
    const http = new AccountsAdminHttp(
      service(installation(), list),
      { allows: vi.fn(async () => true) },
      ACCOUNT_ORIGIN,
    );

    const response = await http.handle(new Request(`${ACCOUNT_ORIGIN}/admin`));
    expect(await response?.text()).toContain(
      "/admin/installations?q=review&amp;state=active&amp;page=2",
    );
  });

  it("renders creation on its own page", async () => {
    const http = new AccountsAdminHttp(
      service(),
      { allows: vi.fn(async () => true) },
      ACCOUNT_ORIGIN,
    );

    const response = await http.handle(new Request(
      `${ACCOUNT_ORIGIN}/admin/installations/new`,
    ));
    const body = await response?.text();
    expect(body).toContain("Reserve a GSV");
    expect(body).toContain('action="/admin/installations"');
    expect(body).not.toContain("Current installations");
  });

  it.each([
    ["active", "Suspend reviewer"],
    ["restricted", "Reactivate reviewer"],
  ] as const)("renders %s lifecycle controls only on the detail page", async (
    state,
    action,
  ) => {
    const current = installation(state);
    const http = new AccountsAdminHttp(
      service(current),
      { allows: vi.fn(async () => true) },
      ACCOUNT_ORIGIN,
    );

    const response = await http.handle(new Request(
      `${ACCOUNT_ORIGIN}/admin/installations/inst_admin_http`,
    ));
    const body = await response?.text();
    expect(body).toContain(action);
    expect(body).toContain(`Reset reviewer`);
    expect(body).toContain("does not delete the previous installation's stored data");
    expect(body).toContain('action="/admin/installations/inst_admin_http/reset"');
    expect(body).toContain("Monthly USD allowance");
    expect(body).toContain("Mail intake");
    expect(body).toContain("5.00");
    expect(body).toContain("3</strong>");
    expect(body).not.toContain("onboard_secret");
  });

  it("renders global inference policy and aggregate usage separately", async () => {
    const adminService = service();
    const http = new AccountsAdminHttp(
      adminService,
      { allows: vi.fn(async () => true) },
      ACCOUNT_ORIGIN,
    );

    const response = await http.handle(new Request(
      `${ACCOUNT_ORIGIN}/admin/inference`,
    ));
    const body = await response?.text();
    expect(adminService.inferenceOverview).toHaveBeenCalledOnce();
    expect(body).toContain("Managed inference");
    expect(body).toContain("Requests paused");
    expect(body).toContain("$2.00");
    expect(body).toContain("Mail intake");
    expect(body).toContain("$0.50");
    expect(body).toContain("deepseek/deepseek-v4-flash-0731");
    expect(body).toContain("Allowed quantizations");
  });

  it("updates the private gsv default route without exposing it to users", async () => {
    const adminService = service();
    const http = new AccountsAdminHttp(
      adminService,
      { allows: vi.fn(async () => true) },
      ACCOUNT_ORIGIN,
    );
    const response = await http.handle(new Request(
      `${ACCOUNT_ORIGIN}/admin/inference/routing`,
      {
        method: "POST",
        headers: { origin: ACCOUNT_ORIGIN },
        body: new URLSearchParams({
          modelId: "deepseek/deepseek-r1",
          displayName: "DeepSeek R1",
          contextWindow: "131072",
          maxOutputTokens: "32768",
          reasoning: "true",
          inputUsdPerMillion: "0.40",
          outputUsdPerMillion: "1.20",
          cacheReadUsdPerMillion: "0.10",
          cacheWriteUsdPerMillion: "0",
          allowFallbacks: "false",
          requireParameters: "true",
          dataCollection: "deny",
          zdr: "true",
          sort: "throughput",
          preferredMinThroughput: "30",
          preferredMaxLatency: "2.5",
          order: "Fireworks, DeepInfra",
          only: "Fireworks, DeepInfra",
          ignore: "",
          quantizations: "fp16, bf16, fp8",
        }),
      },
    ));

    expect(response?.status).toBe(303);
    expect(adminService.setInferenceRouting).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: "deepseek/deepseek-r1",
        inputNanoUsdPerToken: 400,
        outputNanoUsdPerToken: 1_200,
        provider: expect.objectContaining({
          sort: "throughput",
          order: ["Fireworks", "DeepInfra"],
          quantizations: ["fp16", "bf16", "fp8"],
        }),
      }),
    );
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

  it("preserves creation identity when the operator can retry", async () => {
    const adminService = service();
    adminService.create.mockRejectedValueOnce(new Error("handle is unavailable"));
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
          operationId: "operation_retry_http",
          handle: "reviewer",
        }),
      },
    ));

    expect(response?.status).toBe(400);
    const body = await response?.text();
    expect(body).toContain('value="operation_retry_http"');
    expect(body).toContain('value="reviewer"');
  });

  it("reissues onboarding directly on the installation page", async () => {
    const adminService = service();
    const http = new AccountsAdminHttp(
      adminService,
      { allows: vi.fn(async () => true) },
      ACCOUNT_ORIGIN,
    );
    const response = await http.handle(new Request(
      `${ACCOUNT_ORIGIN}/admin/installations/inst_admin_http/onboarding`,
      {
        method: "POST",
        headers: { origin: ACCOUNT_ORIGIN },
        body: new URLSearchParams(),
      },
    ));

    expect(response?.status).toBe(200);
    expect(await response?.text()).toContain("onboard_secret");
    expect(adminService.reissueOnboarding).toHaveBeenCalledWith(
      "inst_admin_http",
    );
  });

  it("resets through an explicit handle confirmation and shows the new claim", async () => {
    const adminService = service(installation("active"));
    const http = new AccountsAdminHttp(
      adminService,
      { allows: vi.fn(async () => true) },
      ACCOUNT_ORIGIN,
    );
    const response = await http.handle(new Request(
      `${ACCOUNT_ORIGIN}/admin/installations/inst_admin_http/reset`,
      {
        method: "POST",
        headers: { origin: ACCOUNT_ORIGIN },
        body: new URLSearchParams({
          operationId: "reset_admin_http",
          confirmHandle: "reviewer",
        }),
      },
    ));

    expect(response?.status).toBe(201);
    const body = await response?.text();
    expect(body).toContain("onboard_secret");
    expect(body).toContain("inst_admin_http");
    expect(body).toContain("pending deletion");
    expect(adminService.resetInstallation).toHaveBeenCalledWith(
      "inst_admin_http",
      {
        operationId: "reset_admin_http",
        confirmHandle: "reviewer",
      },
    );
  });

  it("resets through the operator API with the same confirmation boundary", async () => {
    const adminService = service(installation("restricted"));
    const http = new AccountsAdminHttp(
      adminService,
      { allows: vi.fn(async () => true) },
      ACCOUNT_ORIGIN,
    );
    const response = await http.handle(new Request(
      `${ACCOUNT_ORIGIN}/admin/api/installations/inst_admin_http/reset`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: ACCOUNT_ORIGIN,
        },
        body: JSON.stringify({
          operationId: "reset_admin_api",
          confirmHandle: "reviewer",
        }),
      },
    ));

    expect(response?.status).toBe(201);
    await expect(response?.json()).resolves.toMatchObject({
      installation: { installationId: "inst_admin_http_replacement" },
      reset: {
        previousInstallationId: "inst_admin_http",
        dataDeletionState: "pending",
      },
    });
    expect(adminService.resetInstallation).toHaveBeenCalledWith(
      "inst_admin_http",
      {
        operationId: "reset_admin_api",
        confirmHandle: "reviewer",
      },
    );
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

  it("exposes bounded list and installation detail reads through the API", async () => {
    const adminService = service();
    const http = new AccountsAdminHttp(
      adminService,
      { allows: vi.fn(async () => true) },
      ACCOUNT_ORIGIN,
    );

    const listResponse = await http.handle(new Request(
      `${ACCOUNT_ORIGIN}/admin/api/installations?q=review&page=1`,
    ));
    await expect(listResponse?.json()).resolves.toMatchObject({
      page: 1,
      installations: [expect.objectContaining({ handle: "reviewer" })],
    });
    const detailResponse = await http.handle(new Request(
      `${ACCOUNT_ORIGIN}/admin/api/installations/inst_admin_http`,
    ));
    await expect(detailResponse?.json()).resolves.toMatchObject({
      installationId: "inst_admin_http",
      inference: { tokens: 3 },
    });
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

  it("redirects contextual forms after exact nano-dollar updates", async () => {
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

    expect(response?.status).toBe(303);
    expect(response?.headers.get("location")).toBe(
      "/admin/installations/inst_admin_http",
    );
    expect(adminService.setInstallationInferencePolicy).toHaveBeenCalledWith(
      "inst_admin_http",
      { enabled: true, monthlyLimitNanoUsd: 12_345_678_901 },
    );
  });

  it("redirects lifecycle forms while retaining JSON API responses", async () => {
    const adminService = service();
    const http = new AccountsAdminHttp(
      adminService,
      { allows: vi.fn(async () => true) },
      ACCOUNT_ORIGIN,
    );

    const suspended = await http.handle(new Request(
      `${ACCOUNT_ORIGIN}/admin/installations/inst_admin_http/lifecycle`,
      {
        method: "POST",
        headers: { origin: ACCOUNT_ORIGIN },
        body: new URLSearchParams({ state: "restricted" }),
      },
    ));
    expect(suspended?.status).toBe(303);
    expect(suspended?.headers.get("location")).toBe(
      "/admin/installations/inst_admin_http",
    );

    const reactivated = await http.handle(new Request(
      `${ACCOUNT_ORIGIN}/admin/api/installations/inst_admin_http/lifecycle`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: ACCOUNT_ORIGIN,
        },
        body: JSON.stringify({ state: "active" }),
      },
    ));
    await expect(reactivated?.json()).resolves.toEqual({
      installationId: "inst_admin_http",
      state: "active",
    });
  });

  it("renders mutation failures in the installation they belong to", async () => {
    const adminService = service(installation("active"));
    adminService.setInstallationState.mockRejectedValueOnce(
      new Error("installation cannot transition from active to active"),
    );
    const http = new AccountsAdminHttp(
      adminService,
      { allows: vi.fn(async () => true) },
      ACCOUNT_ORIGIN,
    );

    const response = await http.handle(new Request(
      `${ACCOUNT_ORIGIN}/admin/installations/inst_admin_http/lifecycle`,
      {
        method: "POST",
        headers: { origin: ACCOUNT_ORIGIN },
        body: new URLSearchParams({ state: "active" }),
      },
    ));
    expect(response?.status).toBe(400);
    const body = await response?.text();
    expect(body).toContain("installation cannot transition");
    expect(body).toContain("reviewer");
  });

  it("rejects invalid registry pagination before querying D1", async () => {
    const adminService = service();
    const http = new AccountsAdminHttp(
      adminService,
      { allows: vi.fn(async () => true) },
      ACCOUNT_ORIGIN,
    );

    const response = await http.handle(new Request(
      `${ACCOUNT_ORIGIN}/admin/api/installations?page=0`,
    ));
    expect(response?.status).toBe(400);
    expect(adminService.listInstallations).not.toHaveBeenCalled();
  });

  it("returns not found for an unknown installation detail", async () => {
    const adminService = service();
    adminService.getInstallation.mockResolvedValueOnce(null);
    const http = new AccountsAdminHttp(
      adminService,
      { allows: vi.fn(async () => true) },
      ACCOUNT_ORIGIN,
    );

    const response = await http.handle(new Request(
      `${ACCOUNT_ORIGIN}/admin/installations/inst_missing`,
    ));
    expect(response?.status).toBe(404);
    expect(await response?.text()).toContain("does not exist");
  });
});
