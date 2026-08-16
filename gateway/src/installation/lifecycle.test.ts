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
  it("does not add a lifecycle dependency to standalone deployments", async () => {
    await expect(
      managedInstallationWorkGate({}, "singleton"),
    ).resolves.toEqual({ allowed: true });
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
