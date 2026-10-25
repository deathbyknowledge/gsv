import { createExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { InstallationState } from "@humansandmachines/gsv/services/directory";
import { GatewayAdmissionEntrypoint } from "./admission-entrypoint";

type DirectoryAnswer = { state: InstallationState; stateRevision?: number };

function fixture(authority: string | undefined, directoryAnswer: DirectoryAnswer | null = { state: "restricted", stateRevision: 3 }, held = 3) {
  const ctx = createExecutionContext();
  Object.defineProperty(ctx, "props", { value: authority ? { authority } : {} });
  const installationStateChanged = vi.fn(async () => held);
  const getByName = vi.fn(() => ({ installationStateChanged }));
  const resolveInstallation = vi.fn(async (installationId: string) => directoryAnswer
    ? { found: true, installationId, handle: "ship", canonicalOrigin: "https://ship.example", ...directoryAnswer }
    : { found: false });
  // SAFETY: The entrypoint reads only these binding props, trusted directory records and Kernel methods.
  const entrypoint = new GatewayAdmissionEntrypoint(ctx as never, { KERNEL: { getByName }, INSTALLATION_DIRECTORY: { resolveInstallation } } as never);
  return { entrypoint, getByName, installationStateChanged, resolveInstallation };
}

describe("installation admission notices", () => {
  const notice = { version: 1 as const, installationId: "inst_admission" };

  it.each([undefined, "installation-operator", "installation-deletion"])("refuses authority %s before resolving", async (authority) => {
    const f = fixture(authority);
    await expect(f.entrypoint.installationStateChanged(notice)).rejects.toThrow("authority");
    expect(f.resolveInstallation).not.toHaveBeenCalled();
    expect(f.getByName).not.toHaveBeenCalled();
  });

  it("rejects a malformed notice before resolving", async () => {
    const f = fixture("installation-admission");
    // SAFETY: the notice carries a state the contract forbids, so the entrypoint must reject it.
    await expect(f.entrypoint.installationStateChanged({ ...notice, state: "active" } as never)).rejects.toThrow();
    await expect(f.entrypoint.installationStateChanged({ version: 1, installationId: "../kernel" })).rejects.toThrow();
    expect(f.resolveInstallation).not.toHaveBeenCalled();
  });

  it("has the Kernel keep the state the directory holds, whatever the notice was for", async () => {
    for (const state of ["active", "restricted", "retained"] satisfies InstallationState[]) {
      const f = fixture("installation-admission", { state, stateRevision: 3 }, 5);
      await expect(f.entrypoint.installationStateChanged(notice)).resolves.toEqual({ found: true, stateRevision: 5 });
      expect(f.getByName).toHaveBeenCalledWith("inst_admission");
      expect(f.installationStateChanged).toHaveBeenCalledWith(expect.objectContaining({ installationId: "inst_admission", state, stateRevision: 3 }));
    }
  });

  it("never wakes a Kernel the directory doesn't hold, or in a state no Kernel keeps", async () => {
    const unknown = fixture("installation-admission", null);
    await expect(unknown.entrypoint.installationStateChanged(notice)).resolves.toEqual({ found: false });
    expect(unknown.getByName).not.toHaveBeenCalled();
    for (const state of ["reserved", "provisioning", "deleted"] satisfies InstallationState[]) {
      const f = fixture("installation-admission", { state, stateRevision: 2 });
      await expect(f.entrypoint.installationStateChanged(notice)).resolves.toEqual({ found: true, stateRevision: 2 });
      expect(f.getByName).not.toHaveBeenCalled();
    }
  });

  it("refuses to settle a notice when the directory reports no revision", async () => {
    const f = fixture("installation-admission", { state: "restricted" });
    await expect(f.entrypoint.installationStateChanged(notice)).rejects.toThrow("no state revision");
    expect(f.getByName).not.toHaveBeenCalled();
  });
});
