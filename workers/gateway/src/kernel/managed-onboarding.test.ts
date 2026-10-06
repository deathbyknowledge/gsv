import { afterEach, describe, expect, it, vi } from "vitest";
import type { Kernel } from "./do";
import type { KernelContext } from "./context";
import type { KernelConnection, KernelConnectionState } from "./connection";
import { ManagedOnboarding } from "./managed-onboarding";
import { MANAGED_SETUP_RECOVERY_FAILURE_KEY } from "./do-shared";

afterEach(() => vi.restoreAllMocks());

describe("setup recovery diagnostics", () => {
  it.each([new TypeError("private Accounts detail"), "private non-error rejection"])(
    "retains a lookup failure privately and exports only its closed metadata (%s)", async (cause) => {
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const put = vi.fn();
      const sendError = vi.fn();
      // SAFETY: Rejected setup with no pending completion uses only these Kernel boundaries.
      const host = {} as Kernel;
      Object.assign(host, {
        env: { GSV_TELEMETRY_ENABLED: true, INSTALLATION_DIRECTORY: {
          resolveInstallation: vi.fn().mockRejectedValue(cause),
        } },
        installationId: "inst_setup_diagnostic",
        ctx: { storage: { kv: { put } } },
        transport: { sendError },
      });
      const onboarding = new ManagedOnboarding(host);
      // SAFETY: This rejection path only forwards the connection and never reads setup context.
      const connection = {} as KernelConnection<KernelConnectionState>;
      // SAFETY: Setup is rejected before any KernelContext capability can be used.
      const context = {} as KernelContext;
      await onboarding.handleManagedSysSetup(connection, {
        type: "req", id: "recovery-request", call: "sys.setup", args: { username: "owner", password: "private-password" },
      }, context);
      expect(put).toHaveBeenCalledOnce();
      const [key, diagnostic] = put.mock.calls[0];
      expect(key).toBe(MANAGED_SETUP_RECOVERY_FAILURE_KEY);
      expect(diagnostic.cause).toContain("private");
      expect(diagnostic.cause.length).toBeLessThanOrEqual(8192);
      expect(sendError).toHaveBeenCalledExactlyOnceWith(connection, "recovery-request", 503,
        "Installation setup is unavailable", { diagnosticId: diagnostic.diagnosticId });
      expect(log).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        component: "gateway", installationId: "inst_setup_diagnostic",
        event: { stream: "operational", name: "installation.setup_recovery.failed", properties: {
          diagnosticId: diagnostic.diagnosticId, outcome: "failed", errorType: cause instanceof TypeError ? "TypeError" : "unknown",
          durationMs: expect.any(Number),
        } },
      }));
      expect(JSON.stringify(log.mock.calls)).not.toContain("private");
      expect(JSON.stringify(sendError.mock.calls)).not.toContain("private");
    },
  );
});
