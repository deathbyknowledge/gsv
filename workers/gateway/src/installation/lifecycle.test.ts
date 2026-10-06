import type {
  InstallationDirectoryResult,
  InstallationDirectoryService,
} from "@humansandmachines/gsv/protocol";
import { describe, expect, it, vi } from "vitest";
import { managedInstallationWorkGate } from "./lifecycle";

function directory(
  result: InstallationDirectoryResult,
): InstallationDirectoryService {
  return {
    resolveHostname: vi.fn(async () => result),
    resolveInstallation: vi.fn(async () => result),
  };
}

describe("managed installation lifecycle", () => {
  it("keeps unfinished setup closed and directs the client to owner verification", async () => {
    const setupUrl = "https://accounts.example/owner/signup/?resume=1";
    await expect(managedInstallationWorkGate({
      GSV_OWNER_SIGNUP_URL: setupUrl,
      INSTALLATION_DIRECTORY: directory({ found: true, installationId: "inst_setup", handle: "setup",
        canonicalOrigin: "https://setup.example", state: "provisioning", ownerSetupRecovery: true }),
    }, "inst_setup")).resolves.toEqual({ allowed: false, code: 503, message: "Finish setting up your space",
      details: { setupRecovery: true, setupUrl } });
  });

  it("does not offer owner-email recovery for an operator-issued installation", async () => {
    await expect(managedInstallationWorkGate({
      GSV_OWNER_SIGNUP_URL: "https://accounts.example/owner/signup/?resume=1",
      INSTALLATION_DIRECTORY: directory({ found: true, installationId: "inst_operator", handle: "operator",
        canonicalOrigin: "https://operator.example", state: "provisioning" }),
    }, "inst_operator")).resolves.toEqual({ allowed: false, code: 503, message: "Finish setting up your space",
      details: { setupRecovery: true } });
  });

  it("fails closed without an installation directory", async () => {
    await expect(
      managedInstallationWorkGate({}, "inst_missing_directory"),
    ).resolves.toEqual({ allowed: false, code: 503, message: "Managed installation is unavailable" });
  });

  it("allows active installations and rejects suspended installations", async () => {
    const identity = {
      found: true as const,
      installationId: "inst_lifecycle",
      handle: "lifecycle",
      canonicalOrigin: "https://lifecycle.gsv.space",
    };

    await expect(managedInstallationWorkGate(
      { INSTALLATION_DIRECTORY: directory({ ...identity, state: "active" }) },
      identity.installationId,
    )).resolves.toEqual({ allowed: true });
    await expect(managedInstallationWorkGate(
      {
        INSTALLATION_DIRECTORY: directory({
          ...identity,
          state: "restricted",
        }),
      },
      identity.installationId,
    )).resolves.toEqual({
      allowed: false,
      code: 423,
      message: "Managed installation is suspended",
    });
  });

  it("fails closed when Accounts cannot resolve the exact installation", async () => {
    await expect(managedInstallationWorkGate(
      { INSTALLATION_DIRECTORY: directory({ found: false }) },
      "inst_missing",
    )).resolves.toEqual({
      allowed: false,
      code: 503,
      message: "Managed installation is unavailable",
    });

    const mismatched = directory({
      found: true,
      installationId: "inst_other",
      handle: "other",
      canonicalOrigin: "https://other.gsv.space",
      state: "active",
    });
    await expect(managedInstallationWorkGate(
      { INSTALLATION_DIRECTORY: mismatched },
      "inst_expected",
    )).resolves.toEqual({
      allowed: false,
      code: 503,
      message: "Managed installation is unavailable",
    });
  });

  it("treats a reset installation retained by Accounts as unavailable", async () => {
    await expect(managedInstallationWorkGate(
      {
        INSTALLATION_DIRECTORY: directory({
          found: true,
          installationId: "inst_reset_previous",
          handle: "reset-previous",
          canonicalOrigin: "https://reset-previous.invalid",
          state: "retained",
        }),
      },
      "inst_reset_previous",
    )).resolves.toEqual({
      allowed: false,
      code: 503,
      message: "Managed installation is unavailable",
    });
  });
});
