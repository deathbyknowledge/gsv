import { describe, expect, it, vi } from "vitest";
import type { InstallationDeletionInspection, InstallationDeletionDiscoveryService } from "@humansandmachines/gsv/services/lifecycle-discovery";
import { inspectDeletionResources } from "./deletion-discovery";

const namespaceId = "a".repeat(32);
function owner() {
  const inspectInstallationDeletion = vi.fn<InstallationDeletionDiscoveryService["inspectInstallationDeletion"]>(async (input) => ({
    installationId: input.installationId, observations: input.resources.map((resource) => ({ ...resource, outcome: "empty" })),
  }));
  return { inspectInstallationDeletion, importInstallationDeletionInventory: vi.fn<InstallationDeletionDiscoveryService["importInstallationDeletionInventory"]>() };
}

describe("Accounts deletion discovery routing", () => {
  it("routes each resource to its configured owner and preserves candidate identities and request order", async () => {
    const gateway = owner(); const inference = owner(); const mail = owner(); const telegram = owner();
    const request: InstallationDeletionInspection = { installationId: "retired-space", candidateInstallationIds: ["other-space"], resources: [
      { kind: "kernel", objectId: "1".repeat(64) }, { kind: "inference-executor", objectId: "2".repeat(64) },
      { kind: "mail", objectId: "3".repeat(64) }, { kind: "adapter-peer", namespaceId, objectId: "4".repeat(64) },
      { kind: "ripgit", objectId: "5".repeat(64) }, { kind: "inference-installation", objectId: "6".repeat(64) },
    ] };
    const result = await inspectDeletionResources(request, { gateway, owners: { inference, mail, telegram },
      namespaces: { [namespaceId]: { ownerId: "telegram", kind: "adapter-peer" } } });
    expect(result.observations).toEqual(request.resources.map((resource) => ({ ...resource, outcome: "empty" })));
    expect(gateway.inspectInstallationDeletion.mock.calls[0][0]).toEqual({ ...request, resources: [request.resources[0], request.resources[4]] });
    expect(inference.inspectInstallationDeletion.mock.calls[0][0]).toEqual({ ...request, resources: [request.resources[1], request.resources[5]] });
    expect(mail.inspectInstallationDeletion).toHaveBeenCalledTimes(1);
    expect(telegram.inspectInstallationDeletion).toHaveBeenCalledTimes(1);
  });

  it("rejects absent or wrong namespace mappings before any owner is contacted", async () => {
    const gateway = owner(); const telegram = owner();
    const request: InstallationDeletionInspection = { installationId: "space", resources: [
      { kind: "kernel", objectId: "1".repeat(64) }, { kind: "adapter-peer", objectId: "2".repeat(64) },
    ] };
    await expect(inspectDeletionResources(request, { gateway })).rejects.toThrow("namespace");
    request.resources[1].namespaceId = namespaceId;
    await expect(inspectDeletionResources(request, { gateway, owners: { telegram },
      namespaces: { [namespaceId]: { ownerId: "telegram", kind: "adapter-pairing" } } })).rejects.toThrow("namespace");
    request.resources[1].kind = "inference-executor";
    await expect(inspectDeletionResources(request, { gateway, owners: { telegram },
      namespaces: { [namespaceId]: { ownerId: "telegram", kind: "inference-executor" } } })).rejects.toThrow("owner");
    expect(gateway.inspectInstallationDeletion).not.toHaveBeenCalled();
    expect(telegram.inspectInstallationDeletion).not.toHaveBeenCalled();
  });

  it("rejects missing bindings, wrong response scopes and incomplete or substituted observations", async () => {
    const request: InstallationDeletionInspection = { installationId: "space", resources: [{ kind: "mail", objectId: "a".repeat(64) }] };
    await expect(inspectDeletionResources(request, {})).rejects.toThrow("not configured");
    const mail = owner();
    mail.inspectInstallationDeletion.mockResolvedValueOnce({ installationId: "different", observations: [] });
    await expect(inspectDeletionResources(request, { owners: { mail } })).rejects.toThrow("response");
    mail.inspectInstallationDeletion.mockResolvedValueOnce({ installationId: "space", observations: [] });
    await expect(inspectDeletionResources(request, { owners: { mail } })).rejects.toThrow("response");
    mail.inspectInstallationDeletion.mockResolvedValueOnce({ installationId: "space", observations: [{ kind: "mail", objectId: "b".repeat(64), outcome: "empty" }] });
    await expect(inspectDeletionResources(request, { owners: { mail } })).rejects.toThrow("response");
  });
});
