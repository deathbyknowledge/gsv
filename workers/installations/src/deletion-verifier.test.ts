import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { AccountStore } from "./store";
import { AccountsDeletionInspections } from "./deletion-inspections";
import { InstallationDeletionInventories, type InstallationDeletionEvidence, type InstallationDeletionManifest } from "./deletion-inventory";
import { configuredDeletionEnvironment } from "./deletion-verifier";
import type { InstallationDeletionDiscoveryService } from "@humansandmachines/gsv/services/lifecycle-discovery";
import type { JsonValue } from "./http";

describe("configured deletion verification", () => {
  it("uses persisted owner observations and seals the epoch without another remote probe", async () => {
    const db = env.INSTALLATIONS_DB;
    const directory = new AccountStore(db, "example.invalid");
    const unique = crypto.randomUUID();
    const principal = await directory.createPrincipal({ email: `${unique}@example.invalid`, displayName: "owner", verified: true });
    const space = await directory.reserveInstallation({ principalId: principal.id, operationId: unique, handle: `v${unique.slice(0, 8)}` });
    const installationId = space.installationId;
    await db.prepare("UPDATE installations SET state = 'retained' WHERE id = ?").bind(installationId).run();
    const inspections = new AccountsDeletionInspections(db);
    const before = Date.now();
    const epoch = await inspections.open(installationId);
    const namespaceId = "a".repeat(32), objectId = "b".repeat(64);
    const namespaces = { [namespaceId]: { ownerId: "gateway", kind: "process" as const } };
    const inspectInstallationDeletion = vi.fn<InstallationDeletionDiscoveryService["inspectInstallationDeletion"]>(async (request) => ({
      installationId, observations: request.resources.map((resource) => ({ ...resource, name: "owned-process", installationId, outcome: "identified" })),
    }));
    await inspections.capture({ installationId, inspectionEpochId: epoch.id, resources: [{ namespaceId, objectId, kind: "process" }] }, {
      namespaces, gateway: { inspectInstallationDeletion, importInstallationDeletionInventory: vi.fn() },
    });
    const after = Date.now();
    const evidence: InstallationDeletionEvidence = [];
    async function add(reference: string, value: JsonValue) {
      const body = JSON.stringify(value);
      const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)));
      evidence.push({ reference, body, sha256: Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("") });
    }
    await add("page", { requestedCursor: null, response: { success: true, result: [{ id: objectId, hasStoredData: true }], result_info: { count: 1, cursor: "end" } } });
    await add("end", { requestedCursor: "end", response: { success: true, result: [], result_info: { count: 0, cursor: "" } } });
    // Uploaded observations deliberately lie. Only the server-side probe is authoritative.
    await add("observations", [{ objectId, outcome: "empty" }]);
    await add("index", { version: 1, kind: "cloudflare-durable-objects", installationId, inspectionEpochId: epoch.id, capturedAt: after,
      namespaces: [{ namespaceId, ownerId: "gateway", before: { capturedAt: before, pages: ["page", "end"] },
        after: { capturedAt: after, pages: ["page", "end"] }, observations: ["observations"] }] });
    const manifest: InstallationDeletionManifest = { version: 1, installationId, capturedAt: after,
      owners: ["accounts", "gateway", "inference"].map((id) => ({ id, resources: [], evidence: evidence.map((item) => ({
        id: item.reference, reference: item.reference, sha256: item.sha256, capturedAt: after,
      })) })) };
    manifest.owners[1].resources.push({ kind: "durable-object", namespace: namespaceId, resourceId: objectId, name: "owned-process" });
    const additional = { verifyAdditionalEvidence: vi.fn(async () => true) };
    const config = { DELETION_DISCOVERY_NAMESPACES: namespaces, DELETION_RESOURCE_SCOPES: { accounts: [], gateway: [], inference: [] },
      DELETION_ADDITIONAL_EVIDENCE: additional };
    const resolver = configuredDeletionEnvironment(db, config).DELETION_INVENTORY;
    const registered = await new InstallationDeletionInventories(db, resolver).register(manifest, evidence);
    expect(registered).toMatchObject({ outcome: "verified", inspectionEpochId: epoch.id });
    expect(inspectInstallationDeletion).toHaveBeenCalledOnce();
    expect(await db.prepare("SELECT sealed_manifest_sha256 FROM installation_deletion_inspections WHERE id = ?").bind(epoch.id).first())
      .toEqual({ sealed_manifest_sha256: registered.sha256 });
    additional.verifyAdditionalEvidence.mockResolvedValue(false);
    expect((await new InstallationDeletionInventories(db, resolver).register(manifest, evidence)).outcome).toBe("missing-inventory");
    expect(configuredDeletionEnvironment(db, { DELETION_DISCOVERY_NAMESPACES: namespaces }).DELETION_INVENTORY).toBeUndefined();
  });
});
