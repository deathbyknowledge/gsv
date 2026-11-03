import type { InstallationDirectoryResult } from "@humansandmachines/gsv/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayEnv } from "../runtime-env";
import { kernelForSettlement, kernelForWork } from "./admission";

function active(installationId: string): InstallationDirectoryResult {
  return { found: true, installationId, handle: "fixture", canonicalOrigin: "https://fixture.invalid", state: "active" };
}

function fixture(answer: (installationId: string) => Promise<InstallationDirectoryResult>) {
  const resolveInstallation = vi.fn(answer);
  const getByName = vi.fn((installationId: string) => ({ installationId }));
  // SAFETY: admission reads only the directory and the Kernel namespace.
  const env = {
    INSTALLATION_DIRECTORY: { resolveHostname: vi.fn(), resolveInstallation },
    KERNEL: { getByName },
  } as unknown as GatewayEnv;
  return { env, resolveInstallation, getByName };
}

describe("work admission", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("asks Accounts once a minute per installation while it stays active", async () => {
    vi.useFakeTimers();
    const f = fixture(async (installationId) => active(installationId));
    await expect(kernelForWork(f.env, { installationId: "inst_a" }))
      .resolves.toEqual({ allowed: true, kernel: { installationId: "inst_a" } });
    await kernelForWork(f.env, { installationId: "inst_a" });
    await kernelForWork(f.env, { installationId: "inst_b" });
    expect(f.resolveInstallation).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(60_001);
    await kernelForWork(f.env, { installationId: "inst_a" });
    expect(f.resolveInstallation).toHaveBeenCalledTimes(3);
    expect(f.getByName).toHaveBeenCalledTimes(4);
  });

  it("refuses work within a minute of a suspension", async () => {
    vi.useFakeTimers();
    let state: "active" | "restricted" = "active";
    const f = fixture(async (installationId) => ({ ...active(installationId), state }));
    await kernelForWork(f.env, { installationId: "inst_a" });
    state = "restricted";
    // Accounts tells no Gateway about a suspension; the remembered answer stands until it expires.
    await expect(kernelForWork(f.env, { installationId: "inst_a" })).resolves.toMatchObject({ allowed: true });
    vi.advanceTimersByTime(60_001);
    await expect(kernelForWork(f.env, { installationId: "inst_a" }))
      .resolves.toEqual({ allowed: false, code: 423, message: "Managed installation is suspended" });
  });

  it("asks Accounts on every call it refuses and never addresses that Kernel", async () => {
    const f = fixture(async (installationId) => ({ ...active(installationId), state: "restricted" }));
    const refusal = { allowed: false, code: 423, message: "Managed installation is suspended" };
    await expect(kernelForWork(f.env, { installationId: "inst_a" })).resolves.toEqual(refusal);
    await expect(kernelForWork(f.env, { installationId: "inst_a" })).resolves.toEqual(refusal);
    expect(f.resolveInstallation).toHaveBeenCalledTimes(2);
    expect(f.getByName).not.toHaveBeenCalled();
  });

  it("keeps each directory binding's answers apart", async () => {
    const first = fixture(async (installationId) => active(installationId));
    const second = fixture(async (installationId) => ({ ...active(installationId), state: "restricted" }));
    await kernelForWork(first.env, { installationId: "inst_a" });
    await expect(kernelForWork(second.env, { installationId: "inst_a" })).resolves.toMatchObject({ allowed: false });
    expect(second.getByName).not.toHaveBeenCalled();
  });

  it("forgets the oldest installation once it remembers 1,024", async () => {
    const f = fixture(async (installationId) => active(installationId));
    for (let index = 0; index <= 1_024; index += 1) {
      await kernelForWork(f.env, { installationId: `inst_${index}` });
    }
    await kernelForWork(f.env, { installationId: "inst_1024" });
    expect(f.resolveInstallation).toHaveBeenCalledTimes(1_025);
    await kernelForWork(f.env, { installationId: "inst_0" });
    expect(f.resolveInstallation).toHaveBeenCalledTimes(1_026);
  });

  it("rejects a malformed installation id before asking Accounts", async () => {
    const f = fixture(async (installationId) => active(installationId));
    await expect(kernelForWork(f.env, { installationId: "../foreign" })).rejects.toThrow("installationId is invalid");
    expect(f.resolveInstallation).not.toHaveBeenCalled();
  });
});

describe("settlement admission", () => {
  it("finds the Kernel in any lifecycle state", async () => {
    const f = fixture(async (installationId) => ({ ...active(installationId), state: "retained" }));
    await expect(kernelForSettlement(f.env, { installationId: "inst_a" })).resolves.toEqual({ installationId: "inst_a" });
  });

  it("settles nothing for an installation Accounts no longer has", async () => {
    const f = fixture(async () => ({ found: false }));
    await expect(kernelForSettlement(f.env, { installationId: "inst_a" })).resolves.toBeNull();
    expect(f.getByName).not.toHaveBeenCalled();
  });

  it("fails when Accounts names another installation", async () => {
    const f = fixture(async () => active("inst_other"));
    await expect(kernelForSettlement(f.env, { installationId: "inst_a" })).rejects.toThrow("does not match");
    expect(f.getByName).not.toHaveBeenCalled();
  });

  it("asks Accounts on every settlement", async () => {
    const f = fixture(async (installationId) => active(installationId));
    await kernelForSettlement(f.env, { installationId: "inst_a" });
    await kernelForSettlement(f.env, { installationId: "inst_a" });
    expect(f.resolveInstallation).toHaveBeenCalledTimes(2);
  });
});
