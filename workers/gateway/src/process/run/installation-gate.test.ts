import { afterEach, describe, expect, it, vi } from "vitest";
import type { Process } from "../do";
import * as utils from "../../shared/utils";
import { ProcessKernelClient } from "../kernel-client";
import { ProcessRun } from "./runtime";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("a Process's installation gate", () => {
  it("asks its Kernel rather than Accounts, and keeps an active answer for a minute", async () => {
    vi.useFakeTimers();
    const installationWorkGate = vi.fn(async () => ({ allowed: true as const }));
    const resolveInstallation = vi.fn(async (installationId: string) => ({
      found: true, installationId, handle: "process", canonicalOrigin: "https://process.example", state: "active",
    }));
    // SAFETY: the gate reads only the Process's Kernel client, and a directory it must not use.
    const host = {} as Process;
    Object.assign(host, { installationId: "inst_process", kernel: { installationWorkGate },
      env: { INSTALLATION_DIRECTORY: { resolveInstallation, resolveHostname: vi.fn() } } });
    const run = new ProcessRun(host);
    await expect(run.managedWorkGate()).resolves.toEqual({ allowed: true });
    await expect(run.managedWorkGate()).resolves.toEqual({ allowed: true });
    vi.advanceTimersByTime(60_001);
    await expect(run.managedWorkGate()).resolves.toEqual({ allowed: true });
    expect(installationWorkGate).toHaveBeenCalledTimes(2);
    expect(resolveInstallation).not.toHaveBeenCalled();
  });

  it("fails closed when its Kernel can't answer, and records why", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(utils, "getKernelPtr").mockRejectedValue(new Error("Durable Object reset"));
    // SAFETY: the client reads only the Process's installation id.
    const host = {} as Process;
    Object.assign(host, { installationId: "inst_process" });
    const client = new ProcessKernelClient(host);
    await expect(client.installationWorkGate()).resolves.toEqual({
      allowed: false, code: 503, message: "Ship is briefly unreachable; try again in a moment",
    });
    expect(warn).toHaveBeenCalledWith("[Installation gate] Kernel lookup failed:", expect.objectContaining({ exceptionMessage: "Durable Object reset" }));
  });
});
