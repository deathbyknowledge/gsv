import { createExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { GatewayLifecycleEntrypoint } from "./deletion-entrypoint";
import type { InstallationDeletionRequest } from "@humansandmachines/gsv/services/lifecycle";

function fixture(authority: string | undefined = "installation-deletion", retiredState = "retained") {
  const ctx = createExecutionContext();
  Object.defineProperty(ctx, "props", { value: authority ? { authority } : {} });
  const inspectInstallationResource = vi.fn(async () => ({ name: "inst_other", empty: false }));
  const installationDeletionStatus = vi.fn(async (input: InstallationDeletionRequest) => ({ ...input, phase: "erased" as const }));
  const getByName = vi.fn(() => ({ inspectInstallationResource, installationDeletionStatus }));
  const resolveInstallation = vi.fn(async (installationId: string) => ({
    found: installationId === "inst_retired" || installationId === "inst_other", installationId,
    state: installationId === "inst_retired" ? retiredState : "active",
  }));
  const idFromString = vi.fn((value: string) => value);
  const idFromName = vi.fn((name: string) => ({ equals: (value: string) => name === "inst_other" && value === "a".repeat(64) }));
  // SAFETY: The entrypoint and discovery read only these authority, directory, and Kernel methods.
  const entrypoint = new GatewayLifecycleEntrypoint(ctx as never, { KERNEL: { getByName, idFromName, idFromString }, INSTALLATION_DIRECTORY: { resolveInstallation } } as never);
  return { entrypoint, getByName, resolveInstallation, installationDeletionStatus };
}

describe("installation deletion discovery authority", () => {
  const resource = { kind: "kernel" as const, objectId: "a".repeat(64) };

  it.each(["adapter", "installation-owner-recovery"])("rejects %s authority before directory or object access", async (authority) => {
    const f = fixture(authority);
    await expect(f.entrypoint.inspectInstallationDeletion({ installationId: "inst_retired", resources: [resource] })).rejects.toThrow("binding authority");
    expect(f.resolveInstallation).not.toHaveBeenCalled();
    expect(f.getByName).not.toHaveBeenCalled();
  });

  it("rejects unknown candidates and explicit Kernel names before allocating any object", async () => {
    for (const request of [
      { installationId: "inst_retired", candidateInstallationIds: ["inst_unknown"], resources: [resource] },
      { installationId: "inst_retired", resources: [{ ...resource, name: "inst_unknown" }] },
    ]) {
      const f = fixture();
      await expect(f.entrypoint.inspectInstallationDeletion(request)).rejects.toThrow("not in the installation directory");
      expect(f.getByName).not.toHaveBeenCalled();
    }
  });

  it("requires the target to be retired while allowing trusted candidates from another space", async () => {
    const f = fixture();
    await expect(f.entrypoint.inspectInstallationDeletion({ installationId: "inst_other", resources: [resource] })).rejects.toThrow("retained before discovery");
    expect(f.getByName).not.toHaveBeenCalled();
    const result = await f.entrypoint.inspectInstallationDeletion({ installationId: "inst_retired", candidateInstallationIds: ["inst_other"], resources: [resource] });
    expect(result.observations).toEqual([{ ...resource, name: "inst_other", installationId: "inst_other", outcome: "identified" }]);
    expect(f.getByName).toHaveBeenCalledExactlyOnceWith("inst_other");
  });

  it("validates every named Kernel before beginning an inventory import", async () => {
    const f = fixture();
    await expect(f.entrypoint.importInstallationDeletionInventory({ installationId: "inst_retired", discoverySha256: "b".repeat(64), resources: [{ ...resource, name: "inst_unknown" }] })).rejects.toThrow("not in the installation directory");
    expect(f.getByName).not.toHaveBeenCalled();
  });

  it.each(["retained", "deleting", "deleted"])("keeps the backup-expiry receipt available after directory state becomes %s", async (state) => {
    const f = fixture("installation-deletion", state);
    const request = { version: 1 as const, installationId: "inst_retired", operationId: "erase_retired" };
    await expect(f.entrypoint.installationDeletionStatus(request)).resolves.toEqual({ ...request, phase: "erased" });
    expect(f.installationDeletionStatus).toHaveBeenCalledExactlyOnceWith(request);
    expect(f.getByName).toHaveBeenCalledExactlyOnceWith(request.installationId);
    if (state !== "retained") {
      await expect(f.entrypoint.inspectInstallationDeletion({ installationId: request.installationId, resources: [resource] })).rejects.toThrow("retained before discovery");
      expect(f.getByName).toHaveBeenCalledTimes(1);
    }
  });

  it.each(["active", "restricted"])("does not allocate a Kernel for a lifecycle request against %s state", async (state) => {
    const f = fixture("installation-deletion", state);
    await expect(f.entrypoint.installationDeletionStatus({ version: 1, installationId: "inst_retired", operationId: "erase_retired" })).rejects.toThrow("retired before deletion");
    expect(f.getByName).not.toHaveBeenCalled();
  });
});
