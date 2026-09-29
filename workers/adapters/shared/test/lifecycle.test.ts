import { describe, expect, it, vi } from "vitest";
import { AdapterLifecycle, type AdapterDeletionCoordinator, type AdapterDeletionNamespace } from "../src/lifecycle";
import type { InstallationDirectoryService, InstallationState } from "../../../../packages/gsv/src/services/directory.js";
import type { InstallationDeletionReceipt, InstallationDeletionRequest } from "../../../../packages/gsv/src/services/lifecycle.js";

const installationId = "retired-fixture";
const objectId = "a".repeat(64);
const resource = { kind: "adapter-account" as const, objectId, namespaceId: "b".repeat(32) };
const request = { version: 1 as const, installationId, operationId: "delete-fixture" };
function identity(name: string): DurableObjectId {
  return { name, toString: () => objectId, equals: (other) => other.toString() === objectId };
}
function receipt(input: InstallationDeletionRequest): InstallationDeletionReceipt {
  return { ...input, phase: "quiesced", outcome: "progress", updatedAt: 1, pendingResources: 0, retainedCopies: [] };
}
function fixture(state: InstallationState = "retained", authority: string | undefined = "installation-deletion") {
  const resolveInstallation = vi.fn<InstallationDirectoryService["resolveInstallation"]>(async (id) => {
    if (id === "unknown") return { found: false };
    return { found: true, installationId: id === "mismatch" ? "another" : id, state: id === installationId ? state : "active", handle: "fixture", canonicalOrigin: "https://fixture.gsv.space" };
  });
  const inspect = vi.fn<ReturnType<AdapterDeletionNamespace["get"]>["inspectInstallationResource"]>(async () => ({ name: "account:known:default", outcome: "unrelated" }));
  const namespace: AdapterDeletionNamespace = { idFromName: identity, idFromString: identity, get: () => ({ inspectInstallationResource: inspect }) };
  const coordinator: AdapterDeletionCoordinator = {
    inspectInstallationResource: vi.fn<AdapterDeletionCoordinator["inspectInstallationResource"]>(async () => ({ name: installationId, outcome: "identified", installationId })),
    registeredResource: async () => null,
    importInstallationDeletionInventory: vi.fn<AdapterDeletionCoordinator["importInstallationDeletionInventory"]>(async (input) => ({ installationId, discoverySha256: input.discoverySha256, outcome: "verified", verifiedAt: 1 })),
    quiesceInstallation: vi.fn(async (input) => receipt(input)), eraseInstallation: vi.fn(async (input) => receipt(input)), installationDeletionStatus: vi.fn(async (input) => receipt(input)),
  };
  const service = new AdapterLifecycle({ authority, directory: { resolveInstallation, resolveHostname: async () => ({ found: false }) }, coordinator: () => coordinator, coordinatorId: () => "c".repeat(64), namespace: () => namespace });
  return { service, coordinator, inspect, resolveInstallation };
}

describe("adapter lifecycle authority and historical identity candidates", () => {
  it("passes only exact directory-verified candidates to the physical account owner", async () => {
    const f = fixture();
    expect(await f.service.inspectInstallationDeletion({ installationId, resources: [resource], candidateInstallationIds: ["unknown", "known", "mismatch", "known", installationId] })).toEqual({ installationId, observations: [{ ...resource, name: "account:known:default", outcome: "unrelated" }] });
    expect(f.inspect).toHaveBeenCalledWith(installationId, [installationId, "known"]);
    expect(f.resolveInstallation.mock.calls.filter(([id]) => id === "known")).toHaveLength(1);
  });

  it("requires capture to precede deletion and leaves terminal status available", async () => {
    for (const state of ["active", "deleting", "deleted"] as const) {
      const f = fixture(state);
      await expect(f.service.inspectInstallationDeletion({ installationId, resources: [] })).rejects.toThrow("retired");
      await expect(f.service.importInstallationDeletionInventory({ installationId, discoverySha256: "d".repeat(64), resources: [] })).rejects.toThrow("retired");
      expect(f.coordinator.inspectInstallationResource).not.toHaveBeenCalled();
      expect(f.coordinator.importInstallationDeletionInventory).not.toHaveBeenCalled();
      if (state !== "active") await expect(f.service.installationDeletionStatus(request)).resolves.toMatchObject({ installationId, operationId: request.operationId });
    }
  });

  it("rejects an unprivileged binding before directory reads or object allocation", async () => {
    const f = fixture("retained", "");
    await expect(f.service.inspectInstallationDeletion({ installationId, resources: [resource] })).rejects.toThrow("authority");
    await expect(f.service.eraseInstallation(request)).rejects.toThrow("authority");
    expect(f.resolveInstallation).not.toHaveBeenCalled();
    expect(f.coordinator.inspectInstallationResource).not.toHaveBeenCalled();
  });
});
