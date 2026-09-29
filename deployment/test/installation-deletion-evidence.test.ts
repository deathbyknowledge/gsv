import { describe, expect, it } from "vitest";
import {
  validateInstallationDeletionEvidence,
  type InstallationDeletionEvidence,
  type DeletionManifestForEvidence,
} from "../src/installation-deletion-evidence.ts";

const namespaceId = "a".repeat(32);
const firstId = "1".repeat(64);
const secondId = "2".repeat(64);
const expected = [{ namespaceId, ownerId: "gateway", className: "Process" }];

type EvidenceFixture = { evidence: InstallationDeletionEvidence; manifest: DeletionManifestForEvidence };

function fixture(): EvidenceFixture {
  const snapshot = {
    capturedAt: 1,
    pages: [
      { requestedCursor: null, response: { success: true as const, result: [{ id: firstId, hasStoredData: true }, { id: secondId, hasStoredData: true }], result_info: { count: 2, cursor: "continue" } } },
      { requestedCursor: "continue", response: { success: true as const, result: [], result_info: { count: 0, cursor: "" } } },
    ],
  };
  return {
    evidence: {
      version: 1, installationId: "retired", capturedAt: 3,
      namespaces: [{ namespaceId, ownerId: "gateway", before: structuredClone(snapshot), after: { ...structuredClone(snapshot), capturedAt: 2 }, observations: [
        { objectId: firstId, outcome: "identified", installationId: "retired", name: "process:retired:proc%3Aone" },
        { objectId: secondId, outcome: "identified", installationId: "replacement", name: "process:replacement:proc%3Aone" },
      ] }],
    },
    manifest: { installationId: "retired", owners: [{ id: "gateway", resources: [
      { kind: "durable-object", namespace: namespaceId, resourceId: firstId, name: "process:retired:proc%3Aone" },
      { kind: "r2", namespace: "storage", resourceId: "installations/retired/" },
    ] }] },
  };
}

describe("installation deletion enumeration evidence", () => {
  it("selects only the retired installation and explicitly verifies the DO scope", async () => {
    const { evidence, manifest } = fixture();
    const result = await validateInstallationDeletionEvidence(evidence, expected, manifest);
    expect(result.outcome).toBe("verified");
    expect(result.scope).toBe("durable-objects");
    expect(result.resources.map((resource) => resource.resourceId)).toEqual([firstId]);
  });

  it("requires the actual final empty Cloudflare page", async () => {
    const { evidence, manifest } = fixture();
    evidence.namespaces[0].before.pages.pop();
    await expect(validateInstallationDeletionEvidence(evidence, expected, manifest)).rejects.toThrow("final empty page");
  });

  it("rejects cursor gaps and invented page counts", async () => {
    const { evidence, manifest } = fixture();
    evidence.namespaces[0].before.pages[1].requestedCursor = "skipped";
    await expect(validateInstallationDeletionEvidence(evidence, expected, manifest)).rejects.toThrow("page chain");
    evidence.namespaces[0].before.pages[1].requestedCursor = "continue";
    evidence.namespaces[0].before.pages[0].response.result_info.count = 0;
    await expect(validateInstallationDeletionEvidence(evidence, expected, manifest)).rejects.toThrow("page chain");
  });

  it("rejects a namespace that changes during discovery", async () => {
    const { evidence, manifest } = fixture();
    evidence.namespaces[0].after.pages[0].response.result[0].hasStoredData = false;
    await expect(validateInstallationDeletionEvidence(evidence, expected, manifest)).rejects.toThrow("changed while ownership");
  });

  it("cannot certify any unidentified stored object as belonging elsewhere", async () => {
    const { evidence, manifest } = fixture();
    evidence.namespaces[0].observations[1] = { objectId: secondId, outcome: "unidentified" };
    expect(await validateInstallationDeletionEvidence(evidence, expected, manifest)).toMatchObject({ outcome: "missing-inventory", unidentifiedObjects: 1 });
  });

  it("accepts an inspected content-free orphan and requires exact observation coverage", async () => {
    const { evidence, manifest } = fixture();
    evidence.namespaces[0].observations[1] = { objectId: secondId, outcome: "empty" };
    expect((await validateInstallationDeletionEvidence(evidence, expected, manifest)).outcome).toBe("verified");
    evidence.namespaces[0].observations.pop();
    await expect(validateInstallationDeletionEvidence(evidence, expected, manifest)).rejects.toThrow("cover exactly");
  });

  it("rejects omitted resources and resources copied from the replacement installation", async () => {
    const { evidence, manifest } = fixture();
    manifest.owners[0].resources.shift();
    expect((await validateInstallationDeletionEvidence(evidence, expected, manifest)).outcome).toBe("missing-inventory");
    manifest.owners[0].resources.push({ kind: "durable-object", namespace: namespaceId, resourceId: secondId, name: "process:replacement:proc%3Aone" });
    expect((await validateInstallationDeletionEvidence(evidence, expected, manifest)).outcome).toBe("missing-inventory");
  });

  it("refreshes uploaded observations through the deployment-owned probe", async () => {
    const { evidence, manifest } = fixture();
    evidence.namespaces[0].observations = [];
    const result = await validateInstallationDeletionEvidence(evidence, expected, manifest, {
      async inspect(input) {
        expect(input).toEqual({ namespaceId, ownerId: "gateway", className: "Process", objectIds: [firstId, secondId], beforeCapturedAt: 1, afterCapturedAt: 2 });
        return [{ objectId: firstId, outcome: "identified", installationId: "retired", name: "process:retired:proc%3Aone" }, { objectId: secondId, outcome: "empty" }];
      },
    });
    expect(result.outcome).toBe("verified");
  });

  it("accepts inspected shared state without target data and rejects contradictory ownership", async () => {
    const { evidence, manifest } = fixture();
    evidence.namespaces[0].observations[1] = { objectId: secondId, outcome: "unrelated", name: "operator-workspace" };
    expect((await validateInstallationDeletionEvidence(evidence, expected, manifest)).outcome).toBe("verified");
    evidence.namespaces[0].observations[1].installationId = evidence.installationId;
    await expect(validateInstallationDeletionEvidence(evidence, expected, manifest)).rejects.toThrow("claims target");
  });

  it("uses the operator namespace inventory rather than request-selected namespaces", async () => {
    const { evidence, manifest } = fixture();
    evidence.namespaces[0].namespaceId = "b".repeat(32);
    await expect(validateInstallationDeletionEvidence(evidence, expected, manifest)).rejects.toThrow("unconfigured");
  });
});
