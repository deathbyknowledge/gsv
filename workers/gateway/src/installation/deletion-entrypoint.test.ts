import { createExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { GatewayLifecycleEntrypoint } from "./deletion-entrypoint";

function fixture(authority: string | undefined = "installation-deletion") {
  const ctx = createExecutionContext();
  Object.defineProperty(ctx, "props", { value: authority ? { authority } : {} });
  const inspectInstallationResource = vi.fn(async () => ({ name: "inst_other", empty: false }));
  const getByName = vi.fn(() => ({ inspectInstallationResource }));
  const resolveInstallation = vi.fn(async (installationId: string) => ({
    found: installationId === "inst_retired" || installationId === "inst_other", installationId,
    state: installationId === "inst_retired" ? "retained" : "active",
  }));
  const idFromString = vi.fn((value: string) => value);
  const idFromName = vi.fn((name: string) => ({ equals: (value: string) => name === "inst_other" && value === "a".repeat(64) }));
  // SAFETY: The entrypoint and discovery read only these authority, directory, and Kernel methods.
  const entrypoint = new GatewayLifecycleEntrypoint(ctx as never, { KERNEL: { getByName, idFromName, idFromString }, INSTALLATION_DIRECTORY: { resolveInstallation } } as never);
  return { entrypoint, getByName, resolveInstallation };
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
});
