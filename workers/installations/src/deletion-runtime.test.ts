import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { JsonValue } from "./http";
import type { InstallationDeletionReceipt, InstallationDeletionRequest, InstallationDeletionService } from "@humansandmachines/gsv/services/lifecycle";
import { AccountStore } from "./store";
import { AccountsDeletionRuntime } from "./deletion-runtime";
import { InstallationDeletionHttp } from "./deletion-http";
import type { InstallationDeletionManifest, InstallationDeletionInventoryResolver } from "./deletion-inventory";
import type { InstallationDeletionDiscoveryService, InstallationDeletionInventoryImport } from "@humansandmachines/gsv/services/lifecycle-discovery";

class ExternalOwner implements InstallationDeletionService {
  fail = false;
  private receipt(input: InstallationDeletionRequest, phase: "quiesced" | "erased"): InstallationDeletionReceipt {
    if (this.fail) throw new Error("owner interrupted");
    return { ...input, phase, updatedAt: Date.now(), pendingResources: 0,
      outcome: phase === "erased" ? "complete" : "progress", retainedCopies: [] };
  }
  async quiesceInstallation(input: InstallationDeletionRequest) { return this.receipt(input, "quiesced"); }
  async eraseInstallation(input: InstallationDeletionRequest) { return this.receipt(input, "erased"); }
  async installationDeletionStatus(input: InstallationDeletionRequest) { return this.receipt(input, "erased"); }
}

async function fixture() {
  const db = env.INSTALLATIONS_DB;
  const accounts = new AccountStore(db, "example.com");
  const id = crypto.randomUUID();
  const principal = await accounts.createPrincipal({ email: `${id}@example.com`, displayName: "shared owner", verified: true });
  const createOperationId = `create-${id}`;
  const old = await accounts.reserveInstallation({ principalId: principal.id, operationId: createOperationId, handle: `a${id.slice(0, 8)}` });
  const second = await accounts.reserveInstallation({ principalId: principal.id, operationId: `second-${id}`, handle: `b${id.slice(0, 8)}` });
  await db.batch([
    db.prepare("UPDATE installations SET state = 'active' WHERE id IN (?, ?)").bind(old.installationId, second.installationId),
    db.prepare("UPDATE hostnames SET state = 'active' WHERE installation_id IN (?, ?)").bind(old.installationId, second.installationId),
    db.prepare(`INSERT INTO installation_owner_attempts (id, installation_id, purpose, expected_owner_id, state, created_at, expires_at)
      SELECT ? || value, ?, 'link', ?, 'pending', 1, 9999999999999 FROM json_each(?)`)
      .bind(`attempt-${id}-`, old.installationId, principal.id, JSON.stringify(Array.from({ length: 205 }, (_, index) => index))),
  ]);
  let now = Date.now();
  const owners = { gateway: new ExternalOwner(), inference: new ExternalOwner() };
  const resolver: InstallationDeletionInventoryResolver = {
    verifyInstallationDeletionInventory: vi.fn(async ({ manifest, sha256 }) => ({ installationId: manifest.installationId, sha256, outcome: "verified" as const, verifiedAt: now })),
  };
  const makeRuntime = (configuredResolver: InstallationDeletionInventoryResolver | undefined = resolver) =>
    new AccountsDeletionRuntime(db, owners, configuredResolver, 20, () => now);
  const manifest: InstallationDeletionManifest = { version: 1, installationId: old.installationId, capturedAt: now,
    owners: ["accounts", "gateway", "inference"].map((id) => ({ id,
      resources: [{ kind: "d1", namespace: `test-${id}`, resourceId: old.installationId }],
      evidence: [{ id: `scan-${id}`, reference: `test://scan/${id}`, sha256: "a".repeat(64), capturedAt: now }],
    })) };
  return { db, accounts, old, second, principal, createOperationId, owners, resolver, makeRuntime, manifest,
    tick: () => { now += 21; }, operationId: `delete-${id}` };
}

describe("Accounts deletion runtime", () => {
  it("drains owner verification records in bounded batches while retaining global owner access", async () => {
    const f = await fixture();
    const attempt = await f.db.prepare("SELECT id FROM installation_owner_attempts WHERE installation_id = ? LIMIT 1")
      .bind(f.old.installationId).first<{ id: string }>();
    if (!attempt) throw new Error("Missing fixture attempt");
    const secondAttempt = crypto.randomUUID();
    await f.db.batch([
      f.db.prepare(`INSERT INTO installation_owner_attempts (id, installation_id, purpose, expected_owner_id, state, created_at, expires_at)
        VALUES (?, ?, 'recover', ?, 'pending', 1, 9999999999999)`).bind(secondAttempt, f.second.installationId, f.principal.id),
      f.db.prepare(`INSERT INTO principal_email_credentials (email_normalized, principal_id, created_at) VALUES (?, ?, 1)`)
        .bind(f.principal.email, f.principal.id),
      f.db.prepare(`INSERT INTO owner_auth_sessions (token_hash, principal_id, authenticated_at, expires_at) VALUES (?, ?, 1, 9999999999999)`)
        .bind(`session-${f.principal.id}`, f.principal.id),
      f.db.prepare(`INSERT INTO owner_auth_challenges (id, email, purpose, owner_attempt_id, browser_secret_hash, code_generation, code_verifier,
        created_at, expires_at, delivery_id, delivery_status, delivery_lease_until)
        SELECT ? || value, 'fixture@example.com', 'link', ?, 'browser', 'generation', 'verifier', 1, 9999999999999, 'delivery', 'sent', 1 FROM json_each(?)`)
        .bind(`challenge-${attempt.id}-`, attempt.id, JSON.stringify(Array.from({ length: 205 }, (_, index) => index))),
      f.db.prepare(`INSERT INTO owner_auth_challenges (id, email, purpose, owner_attempt_id, browser_secret_hash, code_generation, code_verifier,
        created_at, expires_at, delivery_id, delivery_status, delivery_lease_until)
        VALUES (?, 'fixture@example.com', 'recover', ?, 'browser', 'generation', 'verifier', 1, 9999999999999, 'delivery', 'sent', 1)`)
        .bind(`challenge-${secondAttempt}`, secondAttempt),
    ]);
    const runtime = f.makeRuntime();
    await runtime.retire(f.old.installationId, { operationId: f.operationId, confirmHandle: f.old.handle });
    const inventory = await runtime.registerInventory(f.old.installationId, f.manifest);
    await runtime.begin(f.old.installationId, { operationId: f.operationId, inventorySha256: inventory.sha256 });
    const count = async () => (await f.db.prepare("SELECT COUNT(*) AS count FROM owner_auth_challenges WHERE owner_attempt_id = ?")
      .bind(attempt.id).first<{ count: number }>())!.count;
    let previous = await count();
    let status = await runtime.status(f.old.installationId);
    for (let index = 0; index < 15 && status.phase !== "live-erased"; index++) {
      status = await runtime.retry(f.old.installationId);
      const remaining = await count();
      expect(previous - remaining).toBeLessThanOrEqual(100);
      previous = remaining;
    }
    expect(status.phase).toBe("live-erased");
    expect(previous).toBe(0);
    expect(await f.db.prepare("SELECT id FROM owner_auth_challenges WHERE owner_attempt_id = ?").bind(secondAttempt).first()).not.toBeNull();
    expect(await f.db.prepare("SELECT principal_id FROM principal_email_credentials WHERE principal_id = ?").bind(f.principal.id).first()).not.toBeNull();
    expect(await f.db.prepare("SELECT principal_id FROM owner_auth_sessions WHERE principal_id = ?").bind(f.principal.id).first()).not.toBeNull();
    expect(await f.accounts.resolveInstallation(f.second.installationId)).toMatchObject({ state: "active" });
  });

  it("resumes explicit deletion, erases bounded rows, preserves another space and reports D1 retention", async () => {
    const state = await fixture();
    let runtime = state.makeRuntime();
    const http = new InstallationDeletionHttp(runtime, { allows: async () => true }, "https://admin.example.com");
    const url = `https://admin.example.com/admin/api/installations/${state.old.installationId}/deletion`;
    const post = (suffix: string, body: JsonValue) => http.handle(new Request(url + suffix, {
      method: "POST", headers: { origin: "https://admin.example.com", "content-type": "application/json" }, body: JSON.stringify(body),
    }));
    expect((await post("/retire", { operationId: state.operationId, confirmHandle: state.old.handle }))?.status).toBe(200);
    expect((await state.accounts.resolveInstallation(state.old.installationId))).toMatchObject({ found: true, state: "retained" });
    const registered = z.object({ sha256: z.string() }).parse(await (await post("/inventory", state.manifest))!.json());
    expect((await post("", { operationId: state.operationId, inventorySha256: registered.sha256 }))?.status).toBe(201);
    state.owners.gateway.fail = true;
    expect((await runtime.retry(state.old.installationId)).phase).toBe("quiescing");
    expect((await state.db.prepare("SELECT COUNT(*) AS count FROM installation_owner_attempts WHERE installation_id = ?").bind(state.old.installationId).first())?.count).toBe(205);
    runtime = state.makeRuntime();
    state.owners.gateway.fail = false;
    await runtime.resumePending();
    expect((await runtime.status(state.old.installationId)).phase).toBe("erasing");
    await runtime.retry(state.old.installationId);
    await runtime.retry(state.old.installationId);
    expect((await state.db.prepare("SELECT COUNT(*) AS count FROM installation_owner_attempts WHERE installation_id = ?").bind(state.old.installationId).first())?.count).toBe(105);
    await runtime.retry(state.old.installationId);
    const retained = await runtime.retry(state.old.installationId);
    expect(retained.phase).toBe("live-erased");
    expect(retained.owners.find((owner) => owner.id === "accounts")?.receipt?.retainedCopies).toEqual([
      { id: "accounts-d1-time-travel", kind: "backup", expiresAt: expect.any(Number) },
    ]);
    expect(await state.db.prepare("SELECT * FROM installations WHERE id = ?").bind(state.old.installationId).first()).toBeNull();
    expect(await state.db.prepare("SELECT * FROM installation_deletion_inventories WHERE installation_id = ?").bind(state.old.installationId).first()).toBeNull();
    expect(await state.accounts.resolveInstallation(state.old.installationId)).toMatchObject({ found: true, state: "deleted" });
    expect(await state.accounts.resolveInstallation(state.second.installationId)).toMatchObject({ found: true, state: "active" });
    expect(await state.accounts.getPrincipal(state.principal.id)).not.toBeNull();
    await expect(state.db.prepare(`INSERT INTO memberships (installation_id, principal_id, state, created_at) VALUES (?, ?, 'active', 1)`)
      .bind(state.old.installationId, state.principal.id).run()).rejects.toThrow();
    await expect(state.accounts.reserveInstallation({ principalId: state.principal.id, operationId: state.createOperationId, handle: state.old.handle })).rejects.toThrow();
    state.tick();
    expect(await state.makeRuntime().retry(state.old.installationId)).toMatchObject({ phase: "erased", owners: [] });
    expect(await state.db.prepare("SELECT * FROM installation_reset_operations WHERE previous_installation_id = ?").bind(state.old.installationId).first()).toBeNull();
  });

  it("denies unauthenticated and cross-origin administration without retiring the space", async () => {
    const state = await fixture();
    const url = `https://admin.example.com/admin/api/installations/${state.old.installationId}/deletion/retire`;
    const input = { operationId: state.operationId, confirmHandle: state.old.handle };
    for (const [allowed, origin] of [[false, "https://admin.example.com"], [true, "https://evil.example.com"]] as const) {
      const api = new InstallationDeletionHttp(state.makeRuntime(), { allows: async () => allowed }, "https://admin.example.com");
      expect((await api.handle(new Request(url, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(input) })))?.status).toBe(403);
    }
    expect(await state.accounts.resolveInstallation(state.old.installationId)).toMatchObject({ state: "active" });
  });

  it("requires verified discovery and does not start pending reset erasure before service preparation", async () => {
    const state = await fixture();
    const reset = await state.accounts.resetInstallation({ installationId: state.old.installationId, operationId: `reset-${state.operationId}`,
      confirmHandle: state.old.handle, participants: ["inference"] });
    const runtime = state.makeRuntime();
    const missing = new AccountsDeletionRuntime(state.db, state.owners, undefined, 20);
    expect((await missing.registerInventory(state.old.installationId, state.manifest)).outcome).toBe("missing-inventory");
    const registered = await runtime.registerInventory(state.old.installationId, state.manifest);
    await expect(runtime.begin(state.old.installationId, { operationId: state.operationId, inventorySha256: registered.sha256 })).rejects.toThrow("reset preparation");
    await runtime.resumePending();
    expect(await state.db.prepare("SELECT * FROM installation_deletions WHERE installation_id = ?").bind(state.old.installationId).first()).toBeNull();
    await state.db.prepare("UPDATE installation_reset_participants SET state = 'prepared' WHERE operation_id = ?").bind(`reset-${state.operationId}`).run();
    await runtime.resumePending();
    expect((await runtime.status(state.old.installationId)).phase).toBe("erasing");
    expect(await state.accounts.resolveInstallation(reset.installationId)).toMatchObject({ state: "reserved" });
  });

  it("binds uploaded evidence bytes to immutable reviewed references", async () => {
    const state = await fixture();
    const runtime = state.makeRuntime();
    await runtime.retire(state.old.installationId, { operationId: state.operationId, confirmHandle: state.old.handle });
    const body = JSON.stringify({ namespace: "test", objects: [], cursor: null });
    const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body))), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const reference = "test://actual-enumeration";
    for (const owner of state.manifest.owners) owner.evidence = [{ id: "enumeration", reference, sha256, capturedAt: state.manifest.capturedAt }];
    await expect(runtime.registerInventory(state.old.installationId, state.manifest, [{ reference, sha256, body: "changed" }])).rejects.toThrow("does not match");
    expect(state.resolver.verifyInstallationDeletionInventory).not.toHaveBeenCalled();
    const registered = await runtime.registerInventory(state.old.installationId, state.manifest, [{ reference, sha256, body }]);
    expect(registered.outcome).toBe("verified");
    expect((await state.db.prepare("SELECT body FROM installation_deletion_evidence WHERE manifest_sha256 = ?")
      .bind(registered.sha256).first())?.body).toBe(body);
    expect((await runtime.registerInventory(state.old.installationId, state.manifest, [])).outcome).toBe("missing-inventory");
    const invalidResolver: InstallationDeletionInventoryResolver = { verifyInstallationDeletionInventory: async ({ sha256 }) => ({
      installationId: state.second.installationId, sha256, outcome: "verified", verifiedAt: Date.now(),
    }) };
    expect((await state.makeRuntime(invalidResolver).registerInventory(state.old.installationId, state.manifest, [{ reference, sha256, body }])).outcome).toBe("missing-inventory");
  });

  it("requires the exact verified DO list and finished owner import before admission", async () => {
    const state = await fixture();
    const importInventory = vi.fn<InstallationDeletionDiscoveryService["importInstallationDeletionInventory"]>(async (input) => ({
      installationId: input.installationId, discoverySha256: input.discoverySha256, outcome: "missing-inventory", verifiedAt: Date.now(),
    }));
    const discovery: InstallationDeletionDiscoveryService = { importInstallationDeletionInventory: importInventory,
      inspectInstallationDeletion: vi.fn(async (input) => ({ installationId: input.installationId, observations: [] })) };
    const runtime = new AccountsDeletionRuntime(state.db, state.owners, state.resolver, 20, Date.now, { gateway: discovery });
    await runtime.retire(state.old.installationId, { operationId: state.operationId, confirmHandle: state.old.handle });
    const resources: InstallationDeletionInventoryImport["resources"] = [
      { kind: "kernel", objectId: "a".repeat(64), name: state.old.installationId },
      { kind: "process", objectId: "b".repeat(64), name: `${state.old.installationId}:process:one` },
    ];
    state.manifest.owners.find((owner) => owner.id === "gateway")!.resources = resources.map((resource) => ({
      kind: "durable-object", namespace: resource.kind, resourceId: resource.objectId, name: resource.name,
    }));
    const registered = await runtime.registerInventory(state.old.installationId, state.manifest);
    const input = { installationId: state.old.installationId, discoverySha256: registered.sha256, resources };
    const begin = () => runtime.begin(state.old.installationId, { operationId: state.operationId, inventorySha256: registered.sha256 });
    await expect(begin()).rejects.toThrow("missing-inventory import");
    await expect(runtime.importInventory(state.old.installationId, { ...input, resources: resources.slice(0, 1) })).rejects.toThrow("outside");
    await expect(runtime.importInventory(state.old.installationId, { ...input, resources: [resources[0], { ...resources[1], name: "another-space" }] })).rejects.toThrow("outside");
    expect(importInventory).not.toHaveBeenCalled();
    expect((await runtime.importInventory(state.old.installationId, input)).outcome).toBe("missing-inventory");
    await expect(begin()).rejects.toThrow("missing-inventory import");
    importInventory.mockImplementation(async (request) => ({ installationId: request.installationId, discoverySha256: request.discoverySha256,
      outcome: "verified", verifiedAt: Date.now() }));
    expect((await runtime.importInventory(state.old.installationId, input)).outcome).toBe("verified");
    expect((await begin()).phase).toBe("quiescing");
    await runtime.importInventory(state.old.installationId, input);
    expect(importInventory).toHaveBeenCalledTimes(2);
  });
  it("imports complete adapter inventories from the verified manifest and waits for each durable acknowledgement", async () => {
    const state = await fixture();
    const namespaceId = "a".repeat(32);
    const gateway: InstallationDeletionDiscoveryService = {
      inspectInstallationDeletion: vi.fn(),
      importInstallationDeletionInventory: vi.fn<InstallationDeletionDiscoveryService["importInstallationDeletionInventory"]>(async (input) => ({ installationId: input.installationId,
        discoverySha256: input.discoverySha256, outcome: "verified", verifiedAt: Date.now() })),
    };
    const importAdapter = vi.fn<InstallationDeletionDiscoveryService["importInstallationDeletionInventory"]>(async (input) => ({
      installationId: input.installationId, discoverySha256: input.discoverySha256, outcome: "missing-inventory", verifiedAt: Date.now(),
    }));
    const telegram = { inspectInstallationDeletion: vi.fn<InstallationDeletionDiscoveryService["inspectInstallationDeletion"]>(),
      importInstallationDeletionInventory: importAdapter };
    const runtime = new AccountsDeletionRuntime(state.db, { ...state.owners, telegram: new ExternalOwner() }, state.resolver, 20, Date.now,
      { gateway, owners: { telegram }, namespaces: { [namespaceId]: { ownerId: "telegram", kind: "adapter-peer" } } });
    await runtime.retire(state.old.installationId, { operationId: state.operationId, confirmHandle: state.old.handle });
    state.manifest.owners.push({ id: "telegram", resources: [{ kind: "durable-object", namespace: namespaceId, resourceId: "b".repeat(64), name: "actor:123:generation:1" }],
      evidence: [{ id: "telegram", reference: "test://telegram", sha256: "a".repeat(64), capturedAt: state.manifest.capturedAt }] });
    const inventory = await runtime.registerInventory(state.old.installationId, state.manifest);
    const input = { installationId: state.old.installationId, discoverySha256: inventory.sha256, resources: [] };
    const begin = () => runtime.begin(state.old.installationId, { operationId: state.operationId, inventorySha256: inventory.sha256 });
    await expect(begin()).rejects.toThrow("missing-inventory import");
    expect((await runtime.importInventory(state.old.installationId, input)).outcome).toBe("missing-inventory");
    await expect(begin()).rejects.toThrow("missing-inventory import");
    const expected = { ...input, resources: [{ kind: "adapter-peer", namespaceId, objectId: "b".repeat(64), name: "actor:123:generation:1" }] };
    expect(importAdapter).toHaveBeenLastCalledWith(expected);
    importAdapter.mockImplementation(async (input) => ({ installationId: input.installationId, discoverySha256: input.discoverySha256,
      outcome: "verified", verifiedAt: Date.now() }));
    expect((await runtime.importInventory(state.old.installationId, input)).outcome).toBe("verified");
    expect(importAdapter).toHaveBeenLastCalledWith(expected);
    expect(gateway.importInstallationDeletionInventory).toHaveBeenCalledTimes(1);
    expect((await runtime.importInventory(state.old.installationId, input)).outcome).toBe("verified");
    expect(importAdapter).toHaveBeenCalledTimes(2);
    expect((await begin()).phase).toBe("quiescing");
  });

  it("requires adapter acknowledgement even for an empty configured namespace and rejects a mismatched owner response", async () => {
    const state = await fixture();
    const gateway: InstallationDeletionDiscoveryService = { inspectInstallationDeletion: vi.fn(),
      importInstallationDeletionInventory: vi.fn<InstallationDeletionDiscoveryService["importInstallationDeletionInventory"]>(async (input) => ({ installationId: input.installationId,
        discoverySha256: input.discoverySha256, outcome: "verified", verifiedAt: Date.now() })) };
    const importAdapter = vi.fn<InstallationDeletionDiscoveryService["importInstallationDeletionInventory"]>(async (input) => ({
      installationId: state.second.installationId, discoverySha256: input.discoverySha256, outcome: "verified", verifiedAt: Date.now(),
    }));
    const telegram = { inspectInstallationDeletion: vi.fn<InstallationDeletionDiscoveryService["inspectInstallationDeletion"]>(), importInstallationDeletionInventory: importAdapter };
    const runtime = new AccountsDeletionRuntime(state.db, { ...state.owners, telegram: new ExternalOwner() }, state.resolver, 20, Date.now,
      { gateway, owners: { telegram }, namespaces: { ["a".repeat(32)]: { ownerId: "telegram", kind: "adapter-pairing" } } });
    await runtime.retire(state.old.installationId, { operationId: state.operationId, confirmHandle: state.old.handle });
    state.manifest.owners.push({ id: "telegram", resources: [],
      evidence: [{ id: "telegram", reference: "test://telegram", sha256: "a".repeat(64), capturedAt: state.manifest.capturedAt }] });
    const inventory = await runtime.registerInventory(state.old.installationId, state.manifest);
    const input = { installationId: state.old.installationId, discoverySha256: inventory.sha256, resources: [] };
    await expect(runtime.importInventory(state.old.installationId, input)).rejects.toThrow("response does not match");
    expect(importAdapter).toHaveBeenCalledWith(input);
    expect(await state.db.prepare("SELECT owner_id FROM installation_deletion_owner_imports WHERE manifest_sha256 = ?").bind(inventory.sha256).first()).toBeNull();
    await expect(runtime.begin(state.old.installationId, { operationId: state.operationId, inventorySha256: inventory.sha256 })).rejects.toThrow("missing-inventory import");
  });

  it("preflights each configured adapter once before opening its capture epoch", async () => {
    const state = await fixture();
    const inspect = vi.fn<InstallationDeletionDiscoveryService["inspectInstallationDeletion"]>(async (input) => {
      expect(await state.db.prepare("SELECT id FROM installation_deletion_inspections WHERE installation_id = ?").bind(input.installationId).first()).toBeNull();
      return { installationId: input.installationId, observations: [] };
    });
    const runtime = new AccountsDeletionRuntime(state.db, state.owners, state.resolver, 20, Date.now, {
      owners: { telegram: { inspectInstallationDeletion: inspect } }, namespaces: {
        ["a".repeat(32)]: { ownerId: "telegram", kind: "adapter-peer" },
        ["b".repeat(32)]: { ownerId: "telegram", kind: "adapter-installation" },
      },
    });
    await expect(runtime.openInspection(state.old.installationId)).rejects.toThrow("retirement");
    expect(inspect).not.toHaveBeenCalled();
    await runtime.retire(state.old.installationId, { operationId: state.operationId, confirmHandle: state.old.handle });
    const epoch = await runtime.openInspection(state.old.installationId);
    expect(epoch.installationId).toBe(state.old.installationId);
    expect(inspect).toHaveBeenCalledExactlyOnceWith({ installationId: state.old.installationId, resources: [] });
    expect(await state.db.prepare("SELECT id FROM installation_deletion_inspections WHERE id = ?").bind(epoch.id).first()).toEqual({ id: epoch.id });
  });

});
