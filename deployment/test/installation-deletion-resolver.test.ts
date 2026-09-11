import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createInstallationDeletionInventoryResolver } from "../src/installation-deletion-resolver.ts";
import type { DeletionResourceProbe } from "../src/installation-deletion-evidence.ts";
import type { InstallationDeletionEvidence, InstallationDeletionManifest } from "../../workers/installations/src/deletion-inventory.ts";
type FixtureArtifact = z.infer<ReturnType<typeof z.json>>;

async function fixture() {
  const namespaceId = "a".repeat(32);
  const objectId = "b".repeat(64);
  const installationId = "inst-one";
  const name = "inst-one/proc-one";
  const evidence: InstallationDeletionEvidence = [];
  const add = async (reference: string, value: FixtureArtifact) => {
    const body = JSON.stringify(value);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
    const sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    evidence.push({ reference, body, sha256 });
  };
  for (const phase of ["before", "after"]) {
    await add(`${phase}-page`, { requestedCursor: null, response: { success: true, result: [{ id: objectId, hasStoredData: true }], result_info: { count: 1, cursor: "next" } } });
    await add(`${phase}-end`, { requestedCursor: "next", response: { success: true, result: [], result_info: { count: 0, cursor: "" } } });
  }
  await add("observations", [{ objectId, outcome: "empty" }]);
  await add("index", {
    version: 1, kind: "cloudflare-durable-objects", installationId, capturedAt: 300,
    namespaces: [{ namespaceId, ownerId: "gateway", before: { capturedAt: 100, pages: ["before-page", "before-end"] },
      after: { capturedAt: 200, pages: ["after-page", "after-end"] }, observations: ["observations"] }],
  });
  const scopes = { accounts: [{ kind: "d1" as const, namespace: "accounts-db", resourceId: installationId }],
    gateway: [{ kind: "r2" as const, namespace: "files", resourceId: `installations/${installationId}/` }], inference: [] };
  const manifest: InstallationDeletionManifest = {
    version: 1, installationId, capturedAt: 400,
    owners: Object.entries(scopes).map(([id, resources]) => ({ id, resources: structuredClone(resources),
      evidence: evidence.map((record) => ({ id: record.reference, reference: record.reference, sha256: record.sha256, capturedAt: 300 })) })),
  };
  manifest.owners.find((owner) => owner.id === "gateway")!.resources.push({ kind: "durable-object", namespace: namespaceId, resourceId: objectId, name });
  const inspect = vi.fn<DeletionResourceProbe["inspect"]>(async () => [{ objectId, outcome: "identified", installationId, name }]);
  const resolver = createInstallationDeletionInventoryResolver({ namespaces: [{ namespaceId, ownerId: "gateway", className: "Process" }],
    resources: () => scopes, probe: { inspect } }, () => 500);
  return { resolver, inspect, input: { manifest, evidence, sha256: "c".repeat(64) } };
}

describe("operator deletion inventory resolver", () => {
  it("assembles chunked evidence and verifies live ownership instead of uploaded observations", async () => {
    const { resolver, inspect, input } = await fixture();
    expect(await resolver.verifyInstallationDeletionInventory(input)).toMatchObject({ outcome: "verified", verifiedAt: 500 });
    expect(inspect).toHaveBeenCalledOnce();
    inspect.mockResolvedValue([{ objectId: "b".repeat(64), outcome: "unidentified", installationId: "inst-one", name: "inst-one/proc-one" }]);
    expect(await resolver.verifyInstallationDeletionInventory(input)).toMatchObject({ outcome: "missing-inventory" });
  });

  it("rejects missing owners and non-DO scopes belonging to another space", async () => {
    const { resolver, inspect, input } = await fixture();
    input.manifest.owners.find((owner) => owner.id === "gateway")!.resources[0].resourceId = "installations/another-space/";
    expect(await resolver.verifyInstallationDeletionInventory(input)).toMatchObject({ outcome: "missing-inventory" });
    input.manifest.owners.pop();
    expect(await resolver.verifyInstallationDeletionInventory(input)).toMatchObject({ outcome: "missing-inventory" });
    expect(inspect).not.toHaveBeenCalled();
  });

  it("rejects changed evidence before reaching an owner", async () => {
    const { resolver, inspect, input } = await fixture();
    input.evidence[0].body = "{}";
    expect(await resolver.verifyInstallationDeletionInventory(input)).toMatchObject({ outcome: "missing-inventory" });
    expect(inspect).not.toHaveBeenCalled();
  });
});
