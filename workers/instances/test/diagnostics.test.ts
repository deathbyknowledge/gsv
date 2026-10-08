import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { InstanceStore, profile } from "../src/store";
import { migrate } from "../src/schema";

const actor = { ownerUid: 1000, human: true };
const limits = { enabled: true, concurrentInstances: 2, periodSeconds: 1000, maxInstanceSeconds: 600, savedProfiles: 2, profileStorageBytes: 5242880 };
function inStore(work: (store: InstanceStore) => void) {
  return runInDurableObject(env.INSTANCES.getByName(crypto.randomUUID()), async (_object, ctx) => work(new InstanceStore(ctx.storage)));
}

describe("private browser diagnostics", () => {
  it("reuses matching failures within an instance and bounds detail and cause traversal", () => inStore(store => {
    const error = new Error("Site storage failed", { cause: new Error("Unsupported value") });
    const ref = store.diagnostic("one", error);
    store.sql.exec("UPDATE diagnostics SET occurred_at = 0");
    expect(store.diagnostic("one", error)).toBe(ref);
    expect(store.sql.exec<{ occurred_at: number }>("SELECT occurred_at FROM diagnostics WHERE id = ?", ref).one().occurred_at).toBeGreaterThan(0);
    expect(store.diagnostic("two", error)).not.toBe(ref);
    const global = store.diagnostic(null, error);
    expect(store.diagnostic(null, error)).toBe(global);
    const large = store.diagnostic("one", new Error("😀".repeat(10000)));
    const detail = store.sql.exec<{ detail: string }>("SELECT detail FROM diagnostics WHERE id = ?", large).one().detail;
    expect(detail.length).toBeLessThanOrEqual(4096);
    expect(detail).toContain("[truncated]");
    let deep = new Error("root");
    for (let i = 0; i < 20; i++) { deep = new Error(`level-${i}`, { cause: deep }); deep.stack = ""; }
    const deepRef = store.diagnostic("one", deep);
    const chain = store.sql.exec<{ detail: string }>("SELECT detail FROM diagnostics WHERE id = ?", deepRef).one().detail;
    expect(chain.match(/level-/g)).toHaveLength(8);
    expect(chain).toContain("[truncated]");
    const cyclic = new Error("cycle"); cyclic.cause = cyclic;
    expect(store.diagnostic("one", cyclic)).toBeDefined();
  }));

  it("retains all live references and pending saves, then trims only obsolete history", () => inStore(store => {
    const instance = store.admit(actor, { requestId: "start", templateId: "browser" }, limits);
    const saved = profile(store.ownedProfile(actor, instance.profileId!)!);
    const refs = Array.from({ length: 6 }, (_, i) => store.diagnostic(instance.instanceId, `referenced-${i}`));
    const issue = (ref: string) => ({ origin: "https://example.com", reason: "unavailable" as const, message: "Storage unavailable", diagnosticRef: ref });
    store.update({ ...instance, diagnosticRef: refs[0], persistence: { saveStatus: "partial", diagnosticRef: refs[1], issues: [issue(refs[2]!)] } });
    store.putProfile({ ...saved, diagnosticRef: refs[3], issues: [issue(refs[4]!)] });
    store.putHandoff({ instanceId: instance.instanceId, requestId: "login", tabId: 1, purpose: "Sign in", site: "https://example.com", state: "failed", revision: 1, createdAt: 1, expiresAt: 2, diagnosticRef: refs[5] });
    const pending = Array.from({ length: 128 }, (_, i) => store.diagnostic("pending-save", `pending-${i}`));
    for (let i = 0; i < 200; i++) store.diagnostic(null, `obsolete-${i}`);
    store.pruneDiagnostics(["pending-save"]);
    const ids = () => store.sql.exec<{ id: string }>("SELECT id FROM diagnostics").toArray().map(row => row.id);
    expect(ids()).toHaveLength(6 + 128 + 64);
    for (const ref of [...refs, ...pending]) expect(ids()).toContain(ref);
    store.pruneDiagnostics();
    expect(ids()).toHaveLength(6 + 64);
    for (const ref of refs) expect(ids()).toContain(ref);
    store.update(instance); store.putProfile(saved); store.sql.exec("DELETE FROM handoffs");
    store.pruneDiagnostics();
    expect(ids()).toHaveLength(64);
    for (const ref of refs) expect(ids()).not.toContain(ref);
  }));

  it("preserves diagnostic identities when reopening the schema", () => inStore(store => {
    const ref = store.diagnostic("existing", "old failure");
    migrate(store.storage); migrate(store.storage);
    expect(store.diagnostic("existing", "old failure")).toBe(ref);
    expect(store.sql.exec("SELECT id FROM diagnostics").toArray()).toHaveLength(1);
  }));
});
