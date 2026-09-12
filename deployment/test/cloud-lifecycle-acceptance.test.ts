import { describe, expect, it } from "vitest";
import { cloudLifecycleReport, prepareCloudLifecycle, runCloudLifecycle, type LifecycleConfiguration, type LifecycleDependencies, type LifecycleGateway, type LifecycleState } from "../src/cloud-lifecycle-acceptance.ts";

function fixture() {
  const config: LifecycleConfiguration = { version: 1, runId: "controlled-test", accountId: "test-account", databaseId: "test-database", accountsWorker: "test-accounts", accountsOrigin: "https://accounts.example.test",
    fixtures: { a: { installationId: "a", handle: "first", canonicalOrigin: "https://first.example.test" }, b: { installationId: "b", handle: "second", canonicalOrigin: "https://second.example.test" } },
    expectedSpaces: ["a", "b", "c", "d", "real-user"].map((id) => ({ id, handle: id === "a" ? "first" : id === "b" ? "second" : id, state: "active" })) };
  const credentials = { a: { username: "owner", password: "original-a-password", rootPassword: "original-a-root-password" }, b: { username: "owner", password: "original-b-password", rootPassword: "original-b-root-password" } };
  let rows = structuredClone(config.expectedSpaces);
  let persisted: LifecycleState;
  let replacement: Awaited<ReturnType<LifecycleDependencies["installation"]>> | null = null;
  let replacementCredentials: LifecycleGateway["credentials"] | null = null;
  let history = "existing welcome";
  let loseReset = false, loseSetup = false, failSave = false, deleted = false, erasing = false;
  const files = new Map<string, string>();
  const writes: { kind: string; id?: string; operationId?: string; handle?: string }[] = [];
  const route = (g: LifecycleGateway) => g.origin === config.fixtures.b.canonicalOrigin ? "b" : replacement ? "replacement" : "a";
  const deps: LifecycleDependencies = {
    async snapshot() { return structuredClone(rows); },
    async installation(id) {
      if (id === "replacement" && replacement) return structuredClone(replacement);
      const row = rows.find((item) => item.id === id)!;
      return { installationId: row.id, handle: row.handle, state: row.state, canonicalOrigin: row.id === "a" && replacement ? "https://retired.invalid" : config.fixtures[row.id === "a" ? "a" : "b"].canonicalOrigin, reset: null };
    },
    async history() { return history; },
    async read(g, path) { return files.get(`${route(g)}:${path}`) ?? null; },
    async write(g, path, content) { writes.push({ kind: "write", id: route(g) }); files.set(`${route(g)}:${path}`, content); },
    async login(g, root) {
      const expected = route(g) === "replacement" ? replacementCredentials : credentials[route(g) === "a" ? "a" : "b"];
      return Boolean(expected && (root ? g.credentials.rootPassword === expected.rootPassword : g.credentials.password === expected.password));
    },
    async reset(id, operationId, handle) {
      writes.push({ kind: "reset", id, operationId, handle });
      expect(persisted.phase).toBe("resetting"); expect(persisted.resetOperationId).toBe(operationId);
      if (!replacement) {
        rows = rows.map((row) => row.id === "a" ? { id: "a", handle: "reset-retired-a", state: "retained" } : row);
        rows.push({ id: "replacement", handle: "first", state: "provisioning" });
        replacement = { installationId: "replacement", handle: "first", canonicalOrigin: config.fixtures.a.canonicalOrigin, state: "provisioning", reset: { previousInstallationId: "a", dataDeletionState: "pending" } };
      }
      if (loseReset) { loseReset = false; throw new Error("lost reset reply"); }
      return { installation: structuredClone(replacement), onboarding: { installationId: "replacement", onboardingUrl: `${config.fixtures.a.canonicalOrigin}/onboarding#private-token`, expiresAt: Date.now() + 3600_000 } };
    },
    async setup(g) {
      writes.push({ kind: "setup" }); expect(persisted.phase).toBe("setting-up"); expect(persisted.credentials.replacement).toEqual(g.credentials);
      replacement!.state = "active"; rows = rows.map((row) => row.id === "replacement" ? { ...row, state: "active" } : row); replacementCredentials = structuredClone(g.credentials);
      if (loseSetup) { loseSetup = false; throw new Error("lost setup reply"); }
    },
    async retire(id, operationId, handle) { expect(persisted.deletionOperationId).toBe(operationId); writes.push({ kind: "retire", id, operationId, handle }); },
    async deletion(action, id, operationId) {
      if (action !== "deletion-status") writes.push({ kind: action, id, operationId });
      return { operationId, installationId: id, phase: deleted ? "live-erased" : erasing ? "erasing" : "quiescing", owners: [{ id: "accounts", outcome: deleted ? "retention-pending" : "progress", receipt: {
        version: 1, operationId, installationId: id, phase: deleted ? "live-erased" : erasing ? "erasing" : "quiescing", updatedAt: 1, pendingResources: deleted ? 0 : 1,
        outcome: deleted ? "retention-pending" : "progress", retainedCopies: deleted ? [{ id: "backup", kind: "backup", expiresAt: 9999999999999 }] : [],
      } }] };
    },
    async save(state) { if (failSave) throw new Error("disk unavailable"); persisted = structuredClone(state); },
  };
  return { config, credentials, deps, writes, files, saved: () => structuredClone(persisted),
    loseReset: () => { loseReset = true; }, loseSetup: () => { loseSetup = true; }, failSave: () => { failSave = true; },
    changeProtected: () => { rows.find((row) => row.id === "real-user")!.state = "restricted"; }, changeHistory: () => { history = "changed"; },
    eraseAccounts: () => { deleted = true; rows = rows.filter((row) => row.id !== "a"); replacement!.reset = null; },
    eraseResetLink: () => { erasing = true; replacement!.reset = null; },
    removeOriginal: () => { rows = rows.filter((row) => row.id !== "a"); },
  };
}
async function prepare(t: ReturnType<typeof fixture>) { return prepareCloudLifecycle(t.config, t.credentials, t.deps); }
async function step(t: ReturnType<typeof fixture>, action: Parameters<typeof runCloudLifecycle>[1], inventory?: string) {
  const state = t.saved(); return runCloudLifecycle(state, action, state.approvalSha256, t.deps, inventory);
}
async function setup(t: ReturnType<typeof fixture>) { await prepare(t); await step(t, "seed"); await step(t, "reset"); await step(t, "setup"); await step(t, "verify"); }

describe("guarded cloud lifecycle acceptance", () => {
  it("prepares read-only and binds approval to exact fixtures", async () => {
    const t = fixture(), state = await prepare(t); expect(t.writes).toEqual([]);
    expect(state.credentials.replacement.rootPassword).not.toBe(t.credentials.a.rootPassword);
    await expect(runCloudLifecycle(state, "seed", "wrong", t.deps)).rejects.toThrow("approval digest");
    state.configuration.fixtures.a.installationId = "real-user";
    await expect(runCloudLifecycle(state, "reset", state.approvalSha256, t.deps)).rejects.toThrow("approval digest"); expect(t.writes).toEqual([]);
  });
  it("rejects wrong inventory, duplicate fixtures and path collisions before writes", async () => {
    const wrong = fixture(); wrong.config.expectedSpaces[4].id = "another"; await expect(prepare(wrong)).rejects.toThrow("registry differs");
    const duplicate = fixture(); duplicate.config.fixtures.b = duplicate.config.fixtures.a; await expect(prepare(duplicate)).rejects.toThrow("distinct identities");
    const collision = fixture(); collision.files.set("a:/home/owner/.gsv-acceptance-controlled-test.txt", "user file"); await expect(prepare(collision)).rejects.toThrow("already exists");
    expect([...wrong.writes, ...duplicate.writes, ...collision.writes]).toEqual([]);
  });
  it("requires durable checkpoints before seed or reset", async () => {
    const t = fixture(); await prepare(t); t.failSave(); await expect(step(t, "seed")).rejects.toThrow("disk unavailable"); expect(t.writes).toEqual([]);
    const r = fixture(); await prepare(r); await step(r, "seed"); r.failSave(); await expect(step(r, "reset")).rejects.toThrow("disk unavailable"); expect(r.writes.some((x) => x.kind === "reset")).toBe(false);
  });
  it("replays the exact saved reset operation after a lost reply", async () => {
    const t = fixture(); await prepare(t); await step(t, "seed"); t.loseReset(); await expect(step(t, "reset")).rejects.toThrow("lost reset reply");
    expect(t.saved().phase).toBe("resetting"); await step(t, "reset"); await step(t, "setup"); await step(t, "verify");
    const calls = t.writes.filter((x) => x.kind === "reset"); expect(calls).toHaveLength(2); expect(new Set(calls.map((x) => x.operationId)).size).toBe(1);
    expect(t.saved().replacementId).toBe("replacement"); await expect(step(t, "reset")).rejects.toThrow("cannot replay after setup");
  });
  it("recovers lost setup reply with saved root/human credentials and no second setup", async () => {
    const t = fixture(); await prepare(t); await step(t, "seed"); await step(t, "reset"); const expected = t.saved().credentials.replacement;
    t.loseSetup(); await expect(step(t, "setup")).rejects.toThrow("lost setup reply"); await step(t, "setup"); await step(t, "verify");
    expect(t.writes.filter((x) => x.kind === "setup")).toHaveLength(1); expect(t.saved().credentials.replacement).toEqual(expected);
    expect(cloudLifecycleReport(t.saved())).toMatchObject({ phase: "verified", protectedSpaces: 4, replacementWasEmpty: true, deletionComplete: false });
    expect(JSON.stringify(cloudLifecycleReport(t.saved()))).not.toContain(expected.password);
  });
  it("stops before reset if any protected identity or B conversation drifts", async () => {
    for (const change of ["changeProtected", "changeHistory"] as const) {
      const t = fixture(); await prepare(t); await step(t, "seed"); t[change](); await expect(step(t, "reset")).rejects.toThrow(/protected space|conversation changed/);
      expect(t.writes.some((x) => x.kind === "reset")).toBe(false);
    }
  });
  it("pins retirement to old immutable ID and its retired handle, refusing pre-existing B drift", async () => {
    const t = fixture(); await setup(t); await step(t, "retire");
    expect(t.writes.at(-1)).toEqual({ kind: "retire", id: "a", operationId: t.saved().deletionOperationId, handle: "reset-retired-a" });
    t.changeHistory(); await expect(step(t, "delete", "a".repeat(64))).rejects.toThrow("conversation changed"); expect(t.writes.some((x) => x.kind === "delete")).toBe(false);
  });
  it("accepts removed original/reset linkage only with current Accounts proof and keeps backups pending", async () => {
    const t = fixture(); await setup(t); await step(t, "retire"); await step(t, "delete", "a".repeat(64)); t.eraseAccounts();
    await step(t, "deletion-status"); await step(t, "verify"); expect(cloudLifecycleReport(t.saved())).toMatchObject({ phase: "verified", deletionPhase: "live-erased", deletionComplete: false });
    expect(t.files.get(`b:${t.saved().path}`)).toBe(t.saved().markers.b); expect(t.files.get(`replacement:${t.saved().path}`)).toBe(t.saved().markers.replacement);
  });
  it("resumes a bounded Accounts erasing batch after its reset link is removed while the old row remains", async () => {
    const t = fixture(); await setup(t); await step(t, "retire"); await step(t, "delete", "a".repeat(64)); t.eraseResetLink();
    await step(t, "deletion-retry");
    expect(cloudLifecycleReport(t.saved())).toMatchObject({ phase: "verified", deletionPhase: "erasing", deletionComplete: false });
    t.removeOriginal(); await expect(step(t, "deletion-status")).rejects.toThrow("without Accounts erasure proof");
  });
  it("rejects deletion progress for another operation even when it claims erasure", async () => {
    const t = fixture(); await setup(t); await step(t, "retire"); await step(t, "delete", "a".repeat(64)); t.eraseAccounts();
    const original = t.deps.deletion;
    t.deps.deletion = async (...args) => ({ ...await original(...args), operationId: "foreign-operation" });
    await expect(step(t, "deletion-status")).rejects.toThrow("another operation");
  });
  it("rejects disappearance without proof and changes to the pinned inventory", async () => {
    const t = fixture(); await setup(t); await step(t, "retire"); await step(t, "delete", "a".repeat(64));
    await expect(step(t, "delete", "b".repeat(64))).rejects.toThrow("immutable inventory"); t.removeOriginal(); await expect(step(t, "deletion-status")).rejects.toThrow("without Accounts erasure proof");
  });
});
