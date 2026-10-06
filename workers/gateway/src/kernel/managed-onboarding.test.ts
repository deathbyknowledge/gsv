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
