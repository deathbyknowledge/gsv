import { afterEach, describe, expect, it, vi } from "vitest";
import type { Kernel } from "./do";
import type { KernelContext } from "./context";
import type { KernelConnection, KernelConnectionState } from "./connection";
import { ManagedOnboarding } from "./managed-onboarding";
import { MANAGED_SETUP_FAILURE_KEY } from "./do-shared";
import * as setup from "./sys/setup";

afterEach(() => vi.restoreAllMocks());

describe.each(["authorization", "pending-recovery", "recovery", "activation"] as const)("setup %s diagnostics", (path) => {
  it.each([new TypeError("private Accounts detail"), "private non-error rejection"])(
    "retains a lookup failure privately and exports only its closed metadata (%s)", async (cause) => {
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const put = vi.fn();
      const sendError = vi.fn();
      const identity = { installationId: "inst_setup_diagnostic", handle: "setup", canonicalOrigin: "https://setup.example" };
      const authorization = vi.fn().mockResolvedValue({ ok: true, claimId: "claim", installation: identity });
      if (path === "authorization") authorization.mockRejectedValue(cause);
      const resolveInstallation = vi.fn().mockRejectedValue(cause);
      const resolveHostname = vi.fn().mockRejectedValue(cause);
      // SAFETY: Accounts failure paths use these Kernel boundaries; local credential recovery is stubbed below.
      const host = {} as Kernel;
      Object.assign(host, {
        env: { GSV_TELEMETRY_ENABLED: true, INSTALLATION_DIRECTORY: {
          authorizeInstallationOnboarding: authorization, resolveInstallation, resolveHostname,
          completeInstallationOnboarding: vi.fn().mockRejectedValue(cause),
        } },
        installationId: identity.installationId, installationIdentity: identity,
        auth: { isSetupMode: () => false },
        ctx: { storage: { kv: { put } } },
        transport: { sendError },
      });
      vi.spyOn(setup, "recoverCompletedSysSetup").mockResolvedValue({
        server: { version: "test", release: "test" }, rootLocked: false,
        user: { uid: 1000, gid: 1000, gids: [1000], username: "owner", home: "/home/owner", cwd: "/home/owner" },
      });
      const onboarding = new ManagedOnboarding(host);
      if (path === "pending-recovery") onboarding.pendingManagedOnboarding = { claimId: "claim", installationId: identity.installationId };
      // SAFETY: This rejection path only forwards the connection and never reads setup context.
      const connection = {} as KernelConnection<KernelConnectionState>;
      // SAFETY: Account creation is not exercised; local credential recovery is stubbed.
      const context = {} as KernelContext;
      await onboarding.handleManagedSysSetup(connection, {
        type: "req", id: "recovery-request", call: "sys.setup", args: {
          username: "owner", password: "private-password",
          onboardingToken: path === "authorization" || path === "activation" ? "private-setup-token" : undefined,
        },
      }, context);
      const failures = put.mock.calls.filter(([key]) => key === MANAGED_SETUP_FAILURE_KEY);
      expect(failures).toHaveLength(1);
      const diagnostic = failures[0][1];
      expect(diagnostic.cause).toContain("private");
      expect(diagnostic.cause.length).toBeLessThanOrEqual(8192);
      expect(sendError).toHaveBeenCalledExactlyOnceWith(connection, "recovery-request", 503,
        path === "activation" ? "Installation setup could not be activated" : "Installation setup is unavailable",
        { diagnosticId: diagnostic.diagnosticId });
      expect(log).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        component: "gateway", installationId: "inst_setup_diagnostic",
        event: { stream: "operational", name: "installation.setup.failed", properties: {
          stage: path === "pending-recovery" ? "recovery" : path,
          diagnosticId: diagnostic.diagnosticId, outcome: "failed", errorType: cause instanceof TypeError ? "TypeError" : "unknown",
          durationMs: expect.any(Number),
        } },
      }));
      expect(JSON.stringify(log.mock.calls)).not.toContain("private");
      expect(JSON.stringify(sendError.mock.calls)).not.toContain("private");
      if (path === "pending-recovery" || path === "activation") {
        expect(onboarding.pendingManagedOnboarding).toEqual({ claimId: "claim", installationId: identity.installationId });
      }
      if (path === "pending-recovery") {
        expect(resolveHostname).toHaveBeenCalledExactlyOnceWith("setup.example");
        expect(resolveInstallation).not.toHaveBeenCalled();
      }
    },
  );
});

describe("a failed setup step", () => {
  async function setUp(rejection: Error) {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const put = vi.fn();
    const sendError = vi.fn();
    const identity = { installationId: "inst_setup_step", handle: "setup", canonicalOrigin: "https://setup.example" };
    // SAFETY: setup reads only these Kernel boundaries before the stubbed account creation.
    const host = {} as Kernel;
    Object.assign(host, {
      env: { GSV_TELEMETRY_ENABLED: true, INSTALLATION_DIRECTORY: {
        authorizeInstallationOnboarding: vi.fn().mockResolvedValue({ ok: true, claimId: "claim", installation: identity }),
      } },
      installationId: identity.installationId, installationIdentity: identity,
      auth: { isSetupMode: () => true },
      ctx: { storage: { kv: { put } } },
      transport: { sendError },
    });
    vi.spyOn(setup, "handleSysSetup").mockRejectedValue(rejection);
    // SAFETY: This rejection path only forwards the connection and never reads setup context.
    const connection = {} as KernelConnection<KernelConnectionState>;
    // SAFETY: Account creation is stubbed.
    await new ManagedOnboarding(host).handleManagedSysSetup(connection, {
      type: "req", id: "setup-request", call: "sys.setup",
      args: { username: "owner", password: "private-password", onboardingToken: "private-setup-token" },
    }, {} as KernelContext);
    return { log, put, sendError, connection };
  }

  it("retains a step's cause privately and exports only its closed metadata", async () => {
    const { log, put, sendError, connection } = await setUp(
      new setup.SetupStepError("provision-personal-agent", new TypeError("private ripgit detail")));
    const failures = put.mock.calls.filter(([key]) => key === MANAGED_SETUP_FAILURE_KEY);
    expect(failures).toHaveLength(1);
    const diagnostic = failures[0][1];
    expect(diagnostic).toMatchObject({ stage: "setup", step: "provision-personal-agent", cause: expect.stringContaining("private ripgit detail") });
    expect(sendError).toHaveBeenCalledExactlyOnceWith(connection, "setup-request", 503,
      "Installation setup did not finish. Try again.", { diagnosticId: diagnostic.diagnosticId });
    expect(log).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      component: "gateway", installationId: "inst_setup_step",
      event: { stream: "operational", name: "installation.setup.failed", properties: {
        stage: "setup", step: "provision-personal-agent", diagnosticId: diagnostic.diagnosticId,
        outcome: "failed", errorType: "TypeError", durationMs: expect.any(Number),
      } },
    }));
    expect(JSON.stringify(log.mock.calls)).not.toContain("private");
    expect(JSON.stringify(sendError.mock.calls)).not.toContain("private");
  });

  it("answers a refused request with its reason and records no failure", async () => {
    const { log, put, sendError, connection } = await setUp(new Error("User already exists: owner"));
    expect(sendError).toHaveBeenCalledExactlyOnceWith(connection, "setup-request", 400, "User already exists: owner");
    expect(put).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });
});

describe("managed work gate", () => {
  it("reuses a recent Accounts confirmation until a lifecycle change invalidates it", async () => {
    let state: "active" | "retained" = "active";
    const resolveInstallation = vi.fn(async (installationId: string) => ({
      found: true as const, installationId, handle: "gate", canonicalOrigin: "https://gate.example", state,
    }));
    // SAFETY: the work gate reads only its directory binding, installation id and retirement state.
    const host = {} as Kernel;
    Object.assign(host, {
      env: { INSTALLATION_DIRECTORY: { resolveInstallation, resolveHostname: vi.fn() } },
      installationId: "inst_gate",
      retirement: { assertActive: () => {} },
    });
    const onboarding = new ManagedOnboarding(host);
    await expect(onboarding.managedWorkGate()).resolves.toEqual({ allowed: true });
    state = "retained";
    await expect(onboarding.managedWorkGate()).resolves.toEqual({ allowed: true });
    onboarding.invalidateWorkGate();
    await expect(onboarding.managedWorkGate()).resolves.toMatchObject({ allowed: false, code: 503 });
    expect(resolveInstallation).toHaveBeenCalledTimes(2);
  });
});
