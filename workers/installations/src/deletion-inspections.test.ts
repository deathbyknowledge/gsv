import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type { InstallationDeletionDiscoveryService } from "@humansandmachines/gsv/services/lifecycle-discovery";
import { AccountStore } from "./store";
import { AccountsDeletionInspections } from "./deletion-inspections";
import { InstallationDeletionInventories, type InstallationDeletionInventoryResolver, type InstallationDeletionManifest } from "./deletion-inventory";
import { AccountsDeletionRuntime } from "./deletion-runtime";
import type { InstallationDeletionService } from "@humansandmachines/gsv/services/lifecycle";
import { InstallationDeletionHttp } from "./deletion-http";

const namespaceId = "a".repeat(32);
async function fixture() {
  const db = env.INSTALLATIONS_DB;
  const directory = new AccountStore(db, "example.invalid");
  const id = crypto.randomUUID();
  const principal = await directory.createPrincipal({ email: `${id}@example.invalid`, displayName: "owner", verified: true });
  const a = await directory.reserveInstallation({ principalId: principal.id, operationId: `a-${id}`, handle: `a${id.slice(0, 8)}` });
  const b = await directory.reserveInstallation({ principalId: principal.id, operationId: `b-${id}`, handle: `b${id.slice(0, 8)}` });
  await db.prepare("UPDATE installations SET state = CASE WHEN id = ? THEN 'retained' ELSE 'active' END WHERE id IN (?, ?)")
    .bind(a.installationId, a.installationId, b.installationId).run();
  let now = Date.now();
  const store = new AccountsDeletionInspections(db, () => now);
  const inspectInstallationDeletion = vi.fn<InstallationDeletionDiscoveryService["inspectInstallationDeletion"]>(async (request) => ({
    installationId: request.installationId, observations: request.resources.map((resource) => ({ ...resource, outcome: "empty" })),
  }));
  const gateway = { inspectInstallationDeletion, importInstallationDeletionInventory: vi.fn<InstallationDeletionDiscoveryService["importInstallationDeletionInventory"]>() };
  const configuration = { gateway, namespaces: { [namespaceId]: { ownerId: "gateway", kind: "process" as const } } };
  const epoch = await store.open(a.installationId);
  const resources = [{ namespaceId, kind: "process" as const, objectId: "b".repeat(64) }];
  const input = { installationId: a.installationId, inspectionEpochId: epoch.id, resources };
  const read = () => ({ installationId: a.installationId, inspectionEpochId: epoch.id, namespaceId, kind: "process" as const,
    objectIds: resources.map((resource) => resource.objectId), beforeCapturedAt: epoch.createdAt, afterCapturedAt: now });
  const manifest: InstallationDeletionManifest = { version: 1, installationId: a.installationId, capturedAt: now,
    owners: ["accounts", "gateway", "inference"].map((id) => ({ id, resources: [{ kind: "d1", namespace: id, resourceId: a.installationId }],
      evidence: [{ id: "evidence", reference: `test://${id}`, sha256: "c".repeat(64), capturedAt: now }] })) };
  const resolver: InstallationDeletionInventoryResolver = { verifyInstallationDeletionInventory: async ({ manifest, sha256 }) => ({
    installationId: manifest.installationId, sha256, outcome: "verified", verifiedAt: now, inspectionEpochId: epoch.id,
  }) };
  return { db, a, b, store, configuration, epoch, input, read, manifest, resolver, clock: () => now, tick: () => { now += 10; } };
}

describe("persisted deletion inspection epochs", () => {
  it("requires retirement, target ownership and namespace identity before contacting an owner", async () => {
    const state = await fixture();
    await expect(state.store.open(state.b.installationId)).rejects.toThrow("retirement");
    await expect(state.store.capture({ ...state.input, installationId: state.b.installationId }, state.configuration)).rejects.toThrow("unavailable");
    await expect(state.store.capture({ ...state.input, resources: [{ kind: "process", objectId: "b".repeat(64) }] }, state.configuration)).rejects.toThrow("namespace");
    await expect(state.store.capture(state.input, { ...state.configuration, namespaces: {} })).rejects.toThrow("namespace");
    expect(state.configuration.gateway.inspectInstallationDeletion).not.toHaveBeenCalled();
  });

  it("persists trusted observations across runtime instances and checks exact scope, kind and snapshot interval", async () => {
    const state = await fixture(); state.tick();
    await state.store.capture(state.input, state.configuration);
    state.tick();
    const reader = new AccountsDeletionInspections(state.db, state.clock);
    expect(await reader.read(state.read())).toEqual(state.input.resources.map((resource) => ({ ...resource, outcome: "empty" })));
    await expect(reader.read({ ...state.read(), inspectionEpochId: crypto.randomUUID() })).rejects.toThrow("unavailable");
    await expect(reader.read({ ...state.read(), installationId: state.b.installationId })).rejects.toThrow("unavailable");
    await expect(reader.read({ ...state.read(), namespaceId: "f".repeat(32) })).rejects.toThrow("missing");
    await expect(reader.read({ ...state.read(), objectIds: ["f".repeat(64)] })).rejects.toThrow("missing");
    await expect(reader.read({ ...state.read(), kind: "kernel" })).rejects.toThrow("kind");
    await expect(reader.read({ ...state.read(), beforeCapturedAt: state.clock() })).rejects.toThrow("interval");
    await expect(reader.read({ ...state.read(), afterCapturedAt: state.epoch.createdAt })).rejects.toThrow("interval");
    expect(state.configuration.gateway.inspectInstallationDeletion).toHaveBeenCalledTimes(1);
  });

  it("replays a lost capture response without a new probe and probes only missing resources", async () => {
    const state = await fixture();
    const original = await state.store.capture(state.input, state.configuration);
    state.tick();
    expect(await state.store.capture(state.input, state.configuration)).toEqual(original);
    expect(state.configuration.gateway.inspectInstallationDeletion).toHaveBeenCalledTimes(1);
    const added = { ...state.input.resources[0], objectId: "d".repeat(64) };
    await state.store.capture({ ...state.input, resources: [...state.input.resources, added] }, state.configuration);
    expect(state.configuration.gateway.inspectInstallationDeletion.mock.calls[1][0].resources).toEqual([added]);
    await expect(state.store.capture({ ...state.input, candidateInstallationIds: [state.b.installationId] }, state.configuration)).rejects.toThrow("request changed");
    await expect(state.store.capture({ ...state.input, resources: [{ ...state.input.resources[0], name: "changed-name" }] }, state.configuration)).rejects.toThrow("request changed");
    expect(state.configuration.gateway.inspectInstallationDeletion).toHaveBeenCalledTimes(2);
    expect((await state.store.read(state.read()))[0].outcome).toBe("empty");
  });

  it("atomically seals the target epoch with verified registration and rejects further captures", async () => {
    const state = await fixture();
    await state.store.capture(state.input, state.configuration);
    const inventories = new InstallationDeletionInventories(state.db, state.resolver, state.clock);
    const registered = await inventories.register(state.manifest);
    expect(registered.outcome).toBe("verified");
    expect(await state.db.prepare("SELECT sealed_manifest_sha256 FROM installation_deletion_inspections WHERE id = ?")
      .bind(state.epoch.id).first()).toEqual({ sealed_manifest_sha256: registered.sha256 });
    await state.store.capture(state.input, state.configuration);
    await expect(state.store.capture({ ...state.input, resources: [{ ...state.input.resources[0], objectId: "d".repeat(64) }] }, state.configuration)).rejects.toThrow("sealed");
    expect((await inventories.register(state.manifest)).outcome).toBe("verified");
    expect((await state.store.read(state.read()))[0].outcome).toBe("empty");
    expect(state.configuration.gateway.inspectInstallationDeletion).toHaveBeenCalledTimes(1);
    expect((await inventories.register({ ...state.manifest, capturedAt: state.manifest.capturedAt - 1 })).outcome).toBe("missing-inventory");
  });

  it("does not persist a probe that completes after registration seals the epoch", async () => {
    const state = await fixture();
    await state.store.capture(state.input, state.configuration);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const resource = { ...state.input.resources[0], objectId: "d".repeat(64) };
    state.configuration.gateway.inspectInstallationDeletion.mockImplementationOnce(async (request) => {
      entered.resolve();
      await release.promise;
      return { installationId: request.installationId, observations: request.resources.map((resource) => ({ ...resource, outcome: "empty" })) };
    });
    const pending = state.store.capture({ ...state.input, resources: [resource] }, state.configuration);
    await entered.promise;
    const inventories = new InstallationDeletionInventories(state.db, state.resolver, state.clock);
    expect((await inventories.register(state.manifest)).outcome).toBe("verified");
    release.resolve();
    await expect(pending).rejects.toThrow("sealed");
    expect(await state.db.prepare("SELECT object_id FROM installation_deletion_observations WHERE inspection_id = ? AND object_id = ?")
      .bind(state.epoch.id, resource.objectId).first()).toBeNull();
  });

  it("does not register another installation against the target epoch or seal a failed verification", async () => {
    const state = await fixture();
    const inventories = new InstallationDeletionInventories(state.db, state.resolver, state.clock);
    expect((await inventories.register({ ...state.manifest, installationId: state.b.installationId })).outcome).toBe("missing-inventory");
    const failed = new InstallationDeletionInventories(state.db, { verifyInstallationDeletionInventory: async ({ manifest, sha256 }) => ({
      installationId: manifest.installationId, sha256, outcome: "missing-inventory", verifiedAt: state.clock(), inspectionEpochId: state.epoch.id,
    }) }, state.clock);
    expect((await failed.register(state.manifest)).outcome).toBe("missing-inventory");
    expect((await state.db.prepare("SELECT sealed_at FROM installation_deletion_inspections WHERE id = ?").bind(state.epoch.id).first())?.sealed_at).toBeNull();
    await state.store.capture(state.input, state.configuration);
  });

  it("protects epoch opening and capture behind operator authentication and origin validation", async () => {
    const state = await fixture();
    const runtime = new AccountsDeletionRuntime(state.db, {}, undefined, 20, state.clock, state.configuration);
    const endpoint = `https://admin.example.invalid/admin/api/installations/${state.a.installationId}/deletion/inspection`;
    const denied = new InstallationDeletionHttp(runtime, { allows: async () => false }, "https://admin.example.invalid");
    expect((await denied.handle(new Request(endpoint, { method: "POST" })))?.status).toBe(403);
    const allowed = new InstallationDeletionHttp(runtime, { allows: async () => true }, "https://admin.example.invalid");
    expect((await allowed.handle(new Request(endpoint, { method: "POST", headers: { origin: "https://foreign.example.invalid" } })))?.status).toBe(403);
    expect((await allowed.handle(new Request(endpoint, { method: "POST", headers: { origin: "https://admin.example.invalid" } })))?.status).toBe(201);
  });

  it("accepts the bounded candidate list above the ordinary JSON body limit", async () => {
    const state = await fixture();
    const runtime = new AccountsDeletionRuntime(state.db, {}, undefined, 20, state.clock, state.configuration);
    const http = new InstallationDeletionHttp(runtime, { allows: async () => true }, "https://admin.example.invalid");
    const candidates = Array.from({ length: 500 }, (_, index) => `${String(index).padStart(3, "0")}-${"a".repeat(120)}`);
    const body = JSON.stringify({ ...state.input, candidateInstallationIds: candidates });
    expect(body.length).toBeGreaterThan(32 * 1024);
    const response = await http.handle(new Request(`https://admin.example.invalid/admin/api/installations/${state.a.installationId}/deletion/inspect`, {
      method: "POST", headers: { origin: "https://admin.example.invalid", "content-type": "application/json" }, body,
    }));
    expect(response?.status).toBe(200);
    expect(state.configuration.gateway.inspectInstallationDeletion.mock.calls[0][0].candidateInstallationIds).toEqual(candidates);
  });

  it("erases capture metadata in bounded batches while preserving another installation", async () => {
    const state = await fixture();
    await state.db.prepare("UPDATE installations SET state = 'retained' WHERE id = ?").bind(state.b.installationId).run();
    const other = await state.store.open(state.b.installationId);
    for (let offset = 0; offset < 205; offset += 32) await state.store.capture({ ...state.input,
      resources: Array.from({ length: Math.min(32, 205 - offset) }, (_, index) => ({ namespaceId, kind: "process" as const,
        objectId: (offset + index + 1).toString(16).padStart(64, "0") })) }, state.configuration);
    await state.store.capture({ ...state.input, installationId: state.b.installationId, inspectionEpochId: other.id }, state.configuration);
    const owner: InstallationDeletionService = {
      quiesceInstallation: async (input) => ({ ...input, phase: "quiesced", outcome: "progress", updatedAt: state.clock(), pendingResources: 0, retainedCopies: [] }),
      eraseInstallation: async (input) => ({ ...input, phase: "erased", outcome: "complete", updatedAt: state.clock(), pendingResources: 0, retainedCopies: [] }),
      installationDeletionStatus: async (input) => ({ ...input, phase: "erased", outcome: "complete", updatedAt: state.clock(), pendingResources: 0, retainedCopies: [] }),
    };
    const runtime = new AccountsDeletionRuntime(state.db, { gateway: owner, inference: owner }, state.resolver, 20, state.clock);
    const inventory = await runtime.registerInventory(state.a.installationId, state.manifest);
    await runtime.begin(state.a.installationId, { operationId: `delete-${state.epoch.id}`, inventorySha256: inventory.sha256 });
    for (let step = 0; step < 8; step++) await runtime.retry(state.a.installationId);
    expect((await state.db.prepare("SELECT COUNT(*) AS count FROM installation_deletion_observations WHERE installation_id = ?").bind(state.a.installationId).first())?.count).toBe(0);
    expect((await state.db.prepare("SELECT COUNT(*) AS count FROM installation_deletion_inspections WHERE installation_id = ?").bind(state.a.installationId).first())?.count).toBe(0);
    expect((await state.db.prepare("SELECT COUNT(*) AS count FROM installation_deletion_observations WHERE installation_id = ?").bind(state.b.installationId).first())?.count).toBe(1);
    expect(await state.db.prepare("SELECT id FROM installation_deletion_inspections WHERE id = ?").bind(other.id).first()).toEqual({ id: other.id });
  });
});
