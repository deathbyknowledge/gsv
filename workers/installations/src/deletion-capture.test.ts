import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { captureInstallationDeletionObjects, deletionCaptureEpochSchema, deletionCaptureInspectionResultSchema,
  type DeletionCaptureAccounts, type DeletionCaptureConfiguration } from "../../../deployment/src/installation-deletion-capture.ts";
import { installationDeletionEvidenceIndexSchema } from "../../../deployment/src/installation-deletion-resolver.ts";
import type { InstallationDeletionDiscoveryService } from "@humansandmachines/gsv/services/lifecycle-discovery";
import { AccountStore } from "./store";
import { AccountsDeletionRuntime } from "./deletion-runtime";
import { InstallationDeletionHttp } from "./deletion-http";

describe("operator capture against Accounts HTTP and D1", () => {
  it("captures trusted epoch observations without registering an inventory or starting erasure", async () => {
    const db = env.INSTALLATIONS_DB;
    const directory = new AccountStore(db, "example.invalid");
    const fixtureId = crypto.randomUUID();
    const principal = await directory.createPrincipal({ email: `${fixtureId}@example.invalid`, displayName: "Capture", verified: true });
    const installation = await directory.reserveInstallation({ principalId: principal.id, operationId: fixtureId, handle: `capture${fixtureId.slice(0, 8)}` });
    await db.prepare("UPDATE installations SET state = 'retained' WHERE id = ?").bind(installation.installationId).run();
    const namespaceId = "a".repeat(32);
    const origin = "https://accounts.example.invalid";
    const configuration: DeletionCaptureConfiguration = { version: 1, accountId: "b".repeat(32), accountsOrigin: origin,
      installationId: installation.installationId, candidateInstallationIds: [installation.installationId],
      namespaces: [{ namespaceId, ownerId: "gateway", className: "Process", kind: "process" }] };
    const files = new Map<string, string>();
    const inspectInstallationDeletion = vi.fn<InstallationDeletionDiscoveryService["inspectInstallationDeletion"]>(async (input) => ({ installationId: input.installationId,
      observations: input.resources.map((resource) => ({ ...resource, outcome: "identified", installationId: input.installationId, name: `process-${resource.objectId}` })) }));
    const gateway = { inspectInstallationDeletion, importInstallationDeletionInventory: vi.fn<InstallationDeletionDiscoveryService["importInstallationDeletionInventory"]>() };
    const runtime = new AccountsDeletionRuntime(db, {}, undefined, 60_000, Date.now, { gateway, namespaces: { [namespaceId]: { ownerId: "gateway", kind: "process" } } });
    const http = new InstallationDeletionHttp(runtime, { allows: async (request: Request) => request.headers.get("authorization") === "Bearer test-operator" }, origin);
    const call = async (action: string, body?: string): Promise<Response> => {
      const response = await http.handle(new Request(`${origin}/admin/api/installations/${installation.installationId}/deletion/${action}`, {
        method: "POST", headers: { authorization: "Bearer test-operator", origin, "content-type": "application/json" }, body,
      }));
      expect(response?.ok).toBe(true);
      return response!;
    };
    const accounts: DeletionCaptureAccounts = {
      openInspection: async () => deletionCaptureEpochSchema.parse(await (await call("inspection")).json()),
      inspect: async (input) => deletionCaptureInspectionResultSchema.parse(await (await call("inspect", JSON.stringify(input))).json()),
    };
    const objectIds = ["c".repeat(64), "d".repeat(64)];
    const result = await captureInstallationDeletionObjects({ configuration, accounts,
      cloudflare: { listObjects: async ({ cursor }) => ({ success: true, result: cursor ? [] : objectIds.map((id) => ({ id, hasStoredData: true })),
        result_info: { count: cursor ? 0 : 2, cursor: cursor ? "" : "next" } }) },
      artifacts: { read: async (reference) => files.get(reference) ?? null, write: async (reference, body) => {
        if (files.has(reference)) expect(files.get(reference)).toBe(body);
        files.set(reference, body);
      } },
    });
    expect(result).toMatchObject({ outcome: "captured", storedObjects: 2, unidentifiedObjects: 0 });
    const index = installationDeletionEvidenceIndexSchema.parse(JSON.parse(files.get(result.indexReference)!));
    expect(await runtime.inspections.read({ installationId: installation.installationId, inspectionEpochId: result.inspectionEpochId, namespaceId,
      kind: "process", objectIds, beforeCapturedAt: index.namespaces[0].before.capturedAt, afterCapturedAt: index.namespaces[0].after.capturedAt })).toHaveLength(2);
    expect((await db.prepare("SELECT COUNT(*) AS count FROM installation_deletions WHERE installation_id = ?").bind(installation.installationId).first())?.count).toBe(0);
    expect((await db.prepare("SELECT state FROM installations WHERE id = ?").bind(installation.installationId).first())?.state).toBe("retained");
    expect(gateway.importInstallationDeletionInventory).not.toHaveBeenCalled();
    const persisted = await runtime.inspections.capture({ installationId: installation.installationId, inspectionEpochId: result.inspectionEpochId,
      candidateInstallationIds: configuration.candidateInstallationIds, resources: objectIds.map((objectId) => ({ objectId, namespaceId, kind: "process" })) }, {
      gateway, namespaces: { [namespaceId]: { ownerId: "gateway", kind: "process" } },
    });
    expect(persisted.observations).toHaveLength(2);
    expect(inspectInstallationDeletion).toHaveBeenCalledTimes(1);
  });
});
