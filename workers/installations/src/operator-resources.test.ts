import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { InstallationDeletionRequest, InstallationDeletionReceipt, InstallationDeletionService } from "@humansandmachines/gsv/services/lifecycle";
import { AccountStore } from "./store";
import { AccountsDeletionRuntime } from "./deletion-runtime";
import { InstallationDeletionHttp } from "./deletion-http";
import { AccountsOperatorResources } from "./operator-resources";
import { OPERATOR_RESOURCE_OWNER, operatorResourceCatalogSchema, operatorResourceDigest, operatorResourceManifestResources,
  operatorResourceSelector, type OperatorResourceAttestation, type OperatorResourceCapture, type OperatorResourceCatalog } from "./operator-resource-contracts";
import type { InstallationDeletionManifest } from "./deletion-inventory";

const catalog: OperatorResourceCatalog = [
  { id: "multipart", kind: "r2", namespace: "historical-bucket", source: "cloudflare-r2-multipart", scope: "installation", disposition: "live" },
  { id: "queue", kind: "queue", namespace: "mail-queue", source: "cloudflare-queue", scope: "deployment", disposition: "live" },
  { id: "provider", kind: "provider", namespace: "historical-provider", source: "ai-gateway", scope: "installation", disposition: "retained" },
];
const empty: OperatorResourceCapture["facts"] = { kind: "enumeration", pages: [{ requestedCursor: null, nextCursor: null, itemCount: 0, responseSha256: "a".repeat(64) }] };

async function fixture() {
  const db = env.INSTALLATIONS_DB;
  const directory = new AccountStore(db, "example.invalid");
  const unique = crypto.randomUUID();
  const principal = await directory.createPrincipal({ email: `${unique}@example.invalid`, displayName: "owner", verified: true });
  const space = await directory.reserveInstallation({ principalId: principal.id, operationId: unique, handle: `e${unique.slice(0, 8)}` });
  await db.prepare("UPDATE installations SET state = 'retained' WHERE id = ?").bind(space.installationId).run();
  let now = Date.now();
  const input: InstallationDeletionRequest = { version: 1, installationId: space.installationId, operationId: crypto.randomUUID() };
  const receipt = (request: InstallationDeletionRequest, phase: "quiesced" | "erased"): InstallationDeletionReceipt => ({ ...request,
    phase, updatedAt: now, pendingResources: 0, retainedCopies: [], outcome: phase === "erased" ? "complete" : "progress" });
  const owner: InstallationDeletionService = { quiesceInstallation: async (request) => receipt(request, "quiesced"),
    eraseInstallation: async (request) => receipt(request, "erased"), installationDeletionStatus: async (request) => receipt(request, "erased") };
  const runtime = new AccountsDeletionRuntime(db, { gateway: owner, inference: owner }, {
    verifyInstallationDeletionInventory: async ({ manifest, sha256 }) => ({ installationId: manifest.installationId, sha256, outcome: "verified", verifiedAt: now }),
  }, 20, () => now, {}, catalog);
  const manifest: InstallationDeletionManifest = { version: 1, installationId: space.installationId, capturedAt: now,
    owners: ["accounts", "gateway", "inference", OPERATOR_RESOURCE_OWNER].map((id) => ({ id,
      resources: id === OPERATOR_RESOURCE_OWNER ? operatorResourceManifestResources(catalog, space.installationId) : [],
      evidence: [{ id: "scope", reference: "fixture/scope", sha256: "b".repeat(64), capturedAt: now }] })) };
  const inventory = await runtime.registerInventory(input.installationId, manifest);
  await runtime.begin(input.installationId, { operationId: input.operationId, inventorySha256: inventory.sha256 });
  const resources = runtime.operatorResources!;
  async function attest(resourceId: string, facts: OperatorResourceCapture["facts"] = empty): Promise<OperatorResourceAttestation> {
    const resource = catalog.find((resource) => resource.id === resourceId)!;
    const capture: OperatorResourceCapture = { ...input, resourceId, source: resource.source, namespace: resource.namespace,
      selector: operatorResourceSelector(resource, input.installationId), capturedAt: ++now, reference: `captures/${resourceId}-${now}.json`, facts };
    return { capture, sha256: await operatorResourceDigest(capture) };
  }
  async function cleanApplications() { await runtime.retry(input.installationId); await runtime.retry(input.installationId); }
  return { db, directory, runtime, resources, input, manifest, cleanApplications, attest,
    tick(ms = 1) { now += ms; }, clock: () => now };
}

function pausePhaseUpdate(db: D1Database, timing: "before" | "after") {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let armed = true;
  const delayedDb = new Proxy(db, { get(target, property) {
    if (property === "prepare") return (sql: string) => {
      const statement = target.prepare(sql);
      if (!sql.includes("AND evidence_revision = ?")) return statement;
      function wrap(bound: D1PreparedStatement): D1PreparedStatement {
        return new Proxy(bound, { get(target, property) {
          if (property === "bind") return (...values: Parameters<D1PreparedStatement["bind"]>) => wrap(target.bind(...values));
          if (property === "run") return async () => {
            const pause = armed;
            armed = false;
            if (pause && timing === "before") { entered.resolve(); await release.promise; }
            const result = await target.run<Record<string, never>>();
            if (pause && timing === "after") { entered.resolve(); await release.promise; }
            return result;
          };
          // SAFETY: Forward platform statement members unchanged except the bound update being paused.
          const value = target[property as keyof D1PreparedStatement];
          return value instanceof Function ? value.bind(target) : value;
        } });
      }
      return wrap(statement);
    };
    // SAFETY: Forward platform database members unchanged except prepare for the update being paused.
    const value = target[property as keyof D1Database];
    return value instanceof Function ? value.bind(target) : value;
  } });
  return { db: delayedDb, entered: entered.promise, release: () => release.resolve() };
}

describe("operator resource evidence", () => {
  it("cleans application owners independently while external live scopes remain unknown", async () => {
    const state = await fixture();
    await state.cleanApplications();
    const progress = await state.runtime.status(state.input.installationId);
    expect(progress.phase).toBe("erasing");
    expect(progress.owners.find((owner) => owner.id === "gateway")?.receipt?.phase).toBe("erased");
    expect(progress.owners.find((owner) => owner.id === OPERATOR_RESOURCE_OWNER)).toMatchObject({ provenance: "operator-attested",
      receipt: { phase: "erasing", pendingResources: 2, retainedCopies: [{ id: "provider", expiresAt: null }] } });
    expect((await state.resources.inspect(state.input.installationId)).resources.every((resource) => resource.state === "unknown")).toBe(true);
    expect(await state.directory.resolveInstallation(state.input.installationId)).toMatchObject({ state: "retained" });
  });

  it("requires every page empty, preserves unknown expiry and resumes after reconstruction", async () => {
    const state = await fixture();
    await state.cleanApplications();
    await state.resources.record(state.input.installationId, await state.attest("multipart", { kind: "enumeration", pages: [
      { requestedCursor: null, nextCursor: "last", itemCount: 1, responseSha256: "c".repeat(64) },
      { requestedCursor: "last", nextCursor: null, itemCount: 0, responseSha256: "d".repeat(64) },
    ] }));
    expect((await state.resources.inspect(state.input.installationId)).resources.find((resource) => resource.id === "multipart")?.state).toBe("pending");
    await state.resources.record(state.input.installationId, await state.attest("multipart", { kind: "enumeration", pages: [
      { requestedCursor: null, nextCursor: "unfinished", itemCount: 0, responseSha256: "d".repeat(64) },
    ] }));
    expect((await state.resources.inspect(state.input.installationId)).resources.find((resource) => resource.id === "multipart")?.state).toBe("pending");
    await state.resources.record(state.input.installationId, await state.attest("multipart"));
    await state.resources.record(state.input.installationId, await state.attest("queue"));
    const unenforced = await state.attest("provider", { kind: "retention-policy", enforced: false, retentionMs: 1000, policySha256: "e".repeat(64) });
    await state.resources.record(state.input.installationId, unenforced);
    const rebuilt = new AccountsOperatorResources(state.db, catalog, state.clock);
    expect(await rebuilt.eraseInstallation(state.input)).toMatchObject({ phase: "live-erased", pendingResources: 0, retainedCopies: [{ expiresAt: null }] });
    state.tick(1_000_000);
    expect(await rebuilt.installationDeletionStatus(state.input)).toMatchObject({ phase: "live-erased", retainedCopies: [{ expiresAt: null }] });
    const fixed = await state.attest("provider", { kind: "retention-policy", enforced: true, retentionMs: 1000, policySha256: "f".repeat(64) });
    await rebuilt.record(state.input.installationId, fixed);
    const retained = await rebuilt.eraseInstallation(state.input);
    expect(retained.retainedCopies).toEqual([{ id: "provider", kind: "provider", expiresAt: state.clock() + 1000 }]);
    state.tick(1001);
    expect(await rebuilt.installationDeletionStatus(state.input)).toMatchObject({ phase: "erased", retainedCopies: [] });
    expect(await state.db.prepare("SELECT COUNT(*) AS count FROM installation_operator_resource_evidence WHERE installation_id = ?").bind(state.input.installationId).first()).toEqual({ count: 0 });
    expect(await state.db.prepare("SELECT catalog_json FROM installation_operator_resources WHERE installation_id = ?").bind(state.input.installationId).first()).toEqual({ catalog_json: "[]" });
    await expect(rebuilt.record(state.input.installationId, fixed)).rejects.toThrow("unfinished");
    await expect(rebuilt.eraseInstallation({ ...state.input, operationId: "another" })).rejects.toThrow("does not match");
  });

  it("rejects wrong scope, changed hashes, stale capture, incomplete pagination and aggregate assertions", async () => {
    const state = await fixture();
    const early = await state.attest("multipart");
    await expect(state.resources.record(state.input.installationId, early)).rejects.toThrow("unfinished");
    await state.cleanApplications();
    const valid = await state.attest("multipart");
    for (const patch of [{ namespace: "other-bucket" }, { operationId: "other-operation" }, { installationId: "other-space" }, { selector: "*" }]) {
      const capture = { ...valid.capture, ...patch };
      await expect(state.resources.record(state.input.installationId, { capture, sha256: await operatorResourceDigest(capture) })).rejects.toThrow("scope");
    }
    await expect(state.resources.record(state.input.installationId, { ...valid, sha256: "0".repeat(64) })).rejects.toThrow("hash");
    const future = { ...valid.capture, capturedAt: state.clock() + 1000 };
    await expect(state.resources.record(state.input.installationId, { capture: future, sha256: await operatorResourceDigest(future) })).rejects.toThrow("time");
    await state.resources.record(state.input.installationId, valid);
    await state.resources.record(state.input.installationId, valid);
    const conflicting = { ...valid.capture, reference: "captures/changed.json" };
    await expect(state.resources.record(state.input.installationId, { capture: conflicting, sha256: await operatorResourceDigest(conflicting) })).rejects.toThrow("stale");
    const broken = await state.attest("queue", { kind: "enumeration", pages: [{ requestedCursor: "missing-first-page", nextCursor: null, itemCount: 0, responseSha256: "a".repeat(64) }] });
    await expect(state.resources.record(state.input.installationId, broken)).rejects.toThrow("pagination");
    const policy = await state.attest("queue", { kind: "retention-policy", enforced: true, retentionMs: 1, policySha256: "a".repeat(64) });
    await expect(state.resources.record(state.input.installationId, policy)).rejects.toThrow("empty enumeration");
    const invalidCatalog = catalog.map((entry) => ({ ...entry, disposition: "retained" as const }));
    expect(() => operatorResourceCatalogSchema.parse(invalidCatalog)).toThrow("live cleanup");
  });

  it("requires operator authentication and origin checks for every evidence write", async () => {
    const state = await fixture();
    await state.cleanApplications();
    const input = await state.attest("queue");
    const origin = "https://admin.example.invalid";
    const url = `${origin}/admin/api/installations/${state.input.installationId}/deletion/operator-resources`;
    for (const [allowed, requestOrigin] of [[false, origin], [true, "https://space.example.invalid"]] as const) {
      const http = new InstallationDeletionHttp(state.runtime, { allows: async () => allowed }, origin);
      expect((await http.handle(new Request(url, { method: "POST", headers: { origin: requestOrigin, "content-type": "application/json" }, body: JSON.stringify(input) })))?.status).toBe(403);
    }
    const http = new InstallationDeletionHttp(state.runtime, { allows: async () => true }, origin);
    expect((await http.handle(new Request(url, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ complete: true }) })))?.status).toBe(400);
    const recorded = await http.handle(new Request(url, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(input) }));
    expect(recorded?.status).toBe(201);
    expect(await recorded?.json()).toMatchObject({ provenance: "operator-attested", resources: expect.arrayContaining([
      expect.objectContaining({ id: "queue", state: "cleared", evidence: expect.objectContaining({ provenance: "operator-attested", sha256: input.sha256 }) }),
    ]) });
    const changedCatalog = catalog.map((resource) => resource.id === "queue" ? { ...resource, namespace: "changed-queue" } : resource);
    await expect(new AccountsOperatorResources(state.db, changedCatalog, state.clock).eraseInstallation(state.input)).rejects.toThrow("catalog changed");
  });

  it("does not overwrite newer nonempty evidence after the phase update commits", async () => {
    const state = await fixture();
    await state.cleanApplications();
    await state.resources.record(state.input.installationId, await state.attest("multipart"));
    await state.resources.record(state.input.installationId, await state.attest("queue"));
    const delayed = pausePhaseUpdate(state.db, "after");
    const advancing = new AccountsOperatorResources(delayed.db, catalog, state.clock).eraseInstallation(state.input);
    await delayed.entered;
    await state.resources.record(state.input.installationId, await state.attest("queue", {
      kind: "enumeration", pages: [{ requestedCursor: null, nextCursor: null, itemCount: 1, responseSha256: "c".repeat(64) }],
    }));
    delayed.release();
    expect(await advancing).toMatchObject({ phase: "erasing", pendingResources: 1 });
    expect(await state.db.prepare("SELECT phase FROM installation_operator_resources WHERE installation_id = ?")
      .bind(state.input.installationId).first()).toEqual({ phase: "erasing" });
  });

  it("does not regress finalizing when a concurrent advance finishes retention", async () => {
    const state = await fixture();
    await state.cleanApplications();
    for (let index = 0; index < 103; index++) await state.resources.record(state.input.installationId, await state.attest("multipart"));
    await state.resources.record(state.input.installationId, await state.attest("queue"));
    await state.resources.record(state.input.installationId, await state.attest("provider", {
      kind: "retention-policy", enforced: true, retentionMs: 1000, policySha256: "f".repeat(64),
    }));
    const delayed = pausePhaseUpdate(state.db, "before");
    const advancing = new AccountsOperatorResources(delayed.db, catalog, state.clock).eraseInstallation(state.input);
    await delayed.entered;
    state.tick(1001);
    expect(await state.resources.eraseInstallation(state.input)).toMatchObject({ phase: "live-erased", pendingResources: 0 });
    delayed.release();
    expect(await advancing).toMatchObject({ phase: "live-erased", pendingResources: 0 });
    expect(await state.db.prepare("SELECT phase FROM installation_operator_resources WHERE installation_id = ?")
      .bind(state.input.installationId).first()).toEqual({ phase: "finalizing" });
    expect(await state.db.prepare("SELECT COUNT(*) AS count FROM installation_operator_resource_evidence WHERE installation_id = ?")
      .bind(state.input.installationId).first()).toEqual({ count: 5 });
    expect(await state.resources.eraseInstallation(state.input)).toMatchObject({ phase: "erased" });
  });

  it("resumes bounded evidence cleanup without losing completion proof or another space", async () => {
    const state = await fixture();
    const other = await fixture();
    await state.cleanApplications(); await other.cleanApplications();
    await other.resources.record(other.input.installationId, await other.attest("queue"));
    for (let index = 0; index < 103; index++) await state.resources.record(state.input.installationId, await state.attest("multipart"));
    await state.resources.record(state.input.installationId, await state.attest("queue"));
    await state.resources.record(state.input.installationId, await state.attest("provider"));
    expect(await state.resources.eraseInstallation(state.input)).toMatchObject({ phase: "live-erased", pendingResources: 0 });
    expect(await state.db.prepare("SELECT COUNT(*) AS count FROM installation_operator_resource_evidence WHERE installation_id = ?")
      .bind(state.input.installationId).first()).toEqual({ count: 5 });
    await expect(state.resources.record(state.input.installationId, await state.attest("multipart"))).rejects.toThrow("unfinished");
    expect(await new AccountsOperatorResources(state.db, catalog, state.clock).eraseInstallation(state.input)).toMatchObject({ phase: "erased" });
    expect((await other.resources.inspect(other.input.installationId)).resources.find((resource) => resource.id === "queue")?.state).toBe("cleared");
  });
});
