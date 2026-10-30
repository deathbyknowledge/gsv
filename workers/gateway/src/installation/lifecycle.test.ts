import type {
  InstallationDirectoryResult,
  InstallationDirectoryService,
} from "@humansandmachines/gsv/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ManagedInstallationGate, managedInstallationWorkGate, setupFeatures } from "./lifecycle";

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
    }, "inst_setup")).resolves.toEqual({ allowed: false, code: 503, message: "Finish setting up your Ship",
      details: { setupRecovery: true, setupUrl, setupFeatures: ["language"] } });
  });

  it("does not offer owner-email recovery for an operator-issued installation", async () => {
    await expect(managedInstallationWorkGate({
      GSV_OWNER_SIGNUP_URL: "https://accounts.example/owner/signup/?resume=1",
      INSTALLATION_DIRECTORY: directory({ found: true, installationId: "inst_operator", handle: "operator",
        canonicalOrigin: "https://operator.example", state: "provisioning" }),
    }, "inst_operator")).resolves.toEqual({ allowed: false, code: 503, message: "Finish setting up your Ship",
      details: { setupRecovery: true, setupFeatures: ["language"] } });
  });

  it("offers the profile choice at setup only where an open-network host can publish it", () => {
    expect(setupFeatures({})).toEqual(["language"]);
    expect(setupFeatures({ PDS: {} })).toEqual(["language", "profile"]);
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

describe("managed installation gate", () => {
  const active: InstallationDirectoryResult = {
    found: true, installationId: "inst_gate", handle: "gate", canonicalOrigin: "https://gate.example", state: "active",
  };
  const unreachable = { allowed: false, code: 503, message: "Ship is briefly unreachable; try again in a moment" };

  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  function gateWith(resolveInstallation: InstallationDirectoryService["resolveInstallation"]) {
    const service: InstallationDirectoryService = { resolveHostname: vi.fn(), resolveInstallation: vi.fn(resolveInstallation) };
    return { service, gate: new ManagedInstallationGate({ INSTALLATION_DIRECTORY: service }, () => "inst_gate") };
  }

  it("asks Accounts once a minute while the installation stays active", async () => {
    vi.useFakeTimers();
    const { service, gate } = gateWith(async () => active);
    await expect(gate.check()).resolves.toEqual({ allowed: true });
    await expect(gate.check()).resolves.toEqual({ allowed: true });
    expect(service.resolveInstallation).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_001);
    await expect(gate.check()).resolves.toEqual({ allowed: true });
    expect(service.resolveInstallation).toHaveBeenCalledTimes(2);
  });

  it("shares one lookup among requests that arrive together", async () => {
    const { service, gate } = gateWith(async () => active);
    await expect(Promise.all([gate.check(), gate.check(), gate.check()])).resolves.toEqual([
      { allowed: true }, { allowed: true }, { allowed: true },
    ]);
    expect(service.resolveInstallation).toHaveBeenCalledTimes(1);
  });

  it("never remembers a refusal", async () => {
    const { service, gate } = gateWith(async () => ({ ...active, state: "restricted" }));
    await expect(gate.check()).resolves.toMatchObject({ allowed: false, code: 423 });
    await expect(gate.check()).resolves.toMatchObject({ allowed: false, code: 423 });
    expect(service.resolveInstallation).toHaveBeenCalledTimes(2);
  });

  it("fails closed when Accounts cannot answer after the cache expires, and records why", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let failing = false;
    const { gate } = gateWith(async () => {
      if (failing) throw new Error("D1_ERROR: internal error");
      return active;
    });
    await expect(gate.check()).resolves.toEqual({ allowed: true });
    failing = true;
    vi.advanceTimersByTime(60_001);
    // An outage cannot be told apart from a suspension, so a stale active answer is never reused.
    await expect(gate.check()).resolves.toEqual(unreachable);
    expect(warn).toHaveBeenCalledWith(
      "[Installation gate] Accounts lookup failed:", expect.objectContaining({ exceptionMessage: "D1_ERROR: internal error" }),
    );
  });

  it("asks Accounts again after an invalidation and applies its refusal", async () => {
    let state: "active" | "retained" = "active";
    const { service, gate } = gateWith(async () => ({ ...active, state }));
    await expect(gate.check()).resolves.toEqual({ allowed: true });
    state = "retained";
    gate.invalidate();
    await expect(gate.check()).resolves.toEqual({ allowed: false, code: 503, message: "Managed installation is unavailable" });
    expect(service.resolveInstallation).toHaveBeenCalledTimes(2);
  });

  it("asks Accounts for a fresh answer before granting new authority", async () => {
    let state: "active" | "restricted" = "active";
    const { service, gate } = gateWith(async () => ({ ...active, state }));
    await expect(gate.check()).resolves.toEqual({ allowed: true });
    state = "restricted";
    await expect(gate.check()).resolves.toEqual({ allowed: true });
    await expect(gate.check({ fresh: true })).resolves.toMatchObject({ allowed: false, code: 423 });
    // The refusal also ends the remembered confirmation for ordinary traffic.
    await expect(gate.check()).resolves.toMatchObject({ allowed: false, code: 423 });
    expect(service.resolveInstallation).toHaveBeenCalledTimes(3);
  });

  it("reports a failed lookup as briefly unreachable without an earlier confirmation", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { gate } = gateWith(async () => { throw new Error("Network connection lost"); });
    await expect(gate.check()).resolves.toEqual(unreachable);
  });

  it("gives up on a hung lookup after two seconds", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { gate } = gateWith(() => new Promise(() => {}));
    const checked = gate.check();
    await vi.advanceTimersByTimeAsync(2_001);
    await expect(checked).resolves.toEqual(unreachable);
  });
});
