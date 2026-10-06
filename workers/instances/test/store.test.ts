import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { instance, InstanceStore, profile } from "../src/store";
import { ProfileStorage } from "../src/profiles";
import { migrate } from "../src/schema";

const limits = { enabled: true, concurrentInstances: 2, periodSeconds: 1000, maxInstanceSeconds: 600, savedProfiles: 2, profileStorageBytes: 5242880 };
const actor = { ownerUid: 1000, human: true };
const namespace = env.INSTANCES;
const bucket = env.PROFILES;
function inStore<T>(work: (store: InstanceStore) => T | Promise<T>) {
  return runInDurableObject(namespace.getByName(crypto.randomUUID()), async (_object, ctx) => work(new InstanceStore(ctx.storage)));
}

describe("instance admission", () => {
  it("fences a stop that arrives before its start request", () => inStore(store => {
    store.cancelStart(actor, "late-start");
    expect(() => store.admit(actor, { requestId: "late-start", templateId: "browser" }, limits)).toThrow("cancelled before admission");
    expect(store.rows()).toHaveLength(0);
    expect(store.admit({ ownerUid: 1001, human: true }, { requestId: "late-start", templateId: "browser", lifetimeSeconds: 60 }, limits).state).toBe("starting");
  }));
  it("keeps a start receipt terminal and rejects reusing it with other arguments", () => inStore(store => {
    const args = { requestId: "start", templateId: "browser", lifetimeSeconds: 300 };
    const first = store.admit(actor, args, limits);
    store.terminal(first.instanceId, false);
    expect(store.admit(actor, args, limits)).toMatchObject({ instanceId: first.instanceId, state: "stopped" });
    expect(() => store.admit(actor, { ...args, lifetimeSeconds: 301 }, limits)).toThrow("different arguments");
    expect(store.rows()).toHaveLength(1);
  }));
  it("reserves allowance and concurrency across owners before provisioning", () => inStore(store => {
    store.admit(actor, { requestId: "one", templateId: "browser", lifetimeSeconds: 600 }, limits);
    expect(() => store.admit({ ownerUid: 1001, human: true }, { requestId: "two", templateId: "browser", lifetimeSeconds: 600 }, limits)).toThrow("allowance");
    store.admit(actor, { requestId: "two", templateId: "browser", lifetimeSeconds: 300 }, limits);
    expect(() => store.admit(actor, { requestId: "three", templateId: "browser", lifetimeSeconds: 60 }, limits)).toThrow("concurrency");
    expect(store.usage(limits)).toMatchObject({ reservedSeconds: 900, activeInstances: 2 });
  }));
  it("charges a confirmed lifetime once and retains another owner's isolation", () => inStore(store => {
    const started = store.admit(actor, { requestId: "one", templateId: "browser", lifetimeSeconds: 300 }, limits);
    store.update({ ...started, state: "ready", readyAt: started.createdAt + 1000 });
    store.terminal(started.instanceId, false, started.createdAt + 62000);
    store.terminal(started.instanceId, false, started.createdAt + 200000);
    expect(store.usage(limits)).toMatchObject({ usedSeconds: 61, reservedSeconds: 0, activeInstances: 0 });
    expect(store.owned({ ownerUid: 1001, human: true }, { instanceId: started.instanceId })).toBeNull();
    expect(store.owned({ ownerUid: 1001, human: true }, { startRequestId: "one" })).toBeNull();
  }));
  it("releases failed startup time after a known allocation is confirmed stopped", () => inStore(store => {
    const value = store.admit(actor, { requestId: "failed-start", templateId: "browser", lifetimeSeconds: 300 }, limits);
    store.sql.exec("UPDATE instances SET acquire_at = ?, session_id = ? WHERE id = ?", Date.now(), "known-session", value.instanceId);
    store.terminal(value.instanceId, true);
    expect(store.usage(limits)).toMatchObject({ usedSeconds: 0, reservedSeconds: 0, activeInstances: 0 });
  }));
  it("serializes saved profile leases and never releases a newer lease", () => inStore(store => {
    const saved = store.createProfile(actor, "saved", "Personal", limits);
    const first = store.admit(actor, { requestId: "one", templateId: "browser", profileId: saved.profileId, lifetimeSeconds: 300 }, limits);
    expect(() => store.admit(actor, { requestId: "two", templateId: "browser", profileId: saved.profileId, lifetimeSeconds: 300 }, limits)).toThrow("already in use");
    store.terminal(first.instanceId, false);
    const second = store.admit(actor, { requestId: "two", templateId: "browser", profileId: saved.profileId, lifetimeSeconds: 300 }, limits);
    store.terminal(first.instanceId, false);
    expect(profile(store.ownedProfile(actor, saved.profileId)!)).toMatchObject({ activeInstanceId: second.instanceId });
  }));
  it("keeps receipts and profile keys when migrations run again", () => inStore(store => {
    const saved = store.createProfile(actor, "saved", "Personal", limits);
    const first = store.admit(actor, { requestId: "one", templateId: "browser", lifetimeSeconds: 300 }, limits);
    migrate(store.storage);
    expect(instance(store.byId(first.instanceId))).toEqual(first);
    expect(store.ownedProfile(actor, saved.profileId)?.key?.byteLength).toBe(32);
  }));
});

describe("saved profile encryption", () => {
  it("never overwrites or deletes a concurrently committed revision", () => inStore(async store => {
    const saved = store.createProfile(actor, "profile", "Personal", limits);
    const started = store.admit(actor, { requestId: "start", templateId: "browser", profileId: saved.profileId, lifetimeSeconds: 300 }, limits);
    const storage = new ProfileStorage("concurrent", bucket, store);
    const states = ["one", "two"].map(value => ({ cookies: [], origins: [{ origin: "https://example.com", localStorage: [{ name: "session", value }] }] }));
    await Promise.all(states.map(state => storage.save(started, state, 10000)));
    const current = store.ownedProfile(actor, saved.profileId)!;
    expect(current.saved_revision).toBe(1);
    expect(states).toContainEqual(await storage.restore(current));
    expect((await bucket.list({ prefix: `concurrent/owners/1000/profiles/${saved.profileId}/` })).objects).toHaveLength(1);
  }));
  it("restores the committed state and rejects a different installation scope", () => inStore(async store => {
    const saved = store.createProfile(actor, "saved", "Personal", limits);
    const started = store.admit(actor, { requestId: "one", templateId: "browser", profileId: saved.profileId, lifetimeSeconds: 300 }, limits);
    const storage = new ProfileStorage("installation-a", bucket, store);
    const state = { cookies: [], origins: [{ origin: "https://example.com", localStorage: [{ name: "login", value: "test-secret" }] }] };
    await storage.save(started, state, 10000);
    const row = store.ownedProfile(actor, saved.profileId)!;
    const bytes = await (await bucket.get(row.object_key!))!.text();
    expect(bytes).not.toContain("test-secret");
    expect(await storage.restore(row)).toEqual(state);
    await expect(new ProfileStorage("installation-b", bucket, store).restore(row)).rejects.toThrow();
    store.putProfile({ ...profile(row), state: "deleting" });
    await storage.save(started, { cookies: [], origins: [] }, 10000);
    expect(store.ownedProfile(actor, saved.profileId)?.saved_revision).toBe(1);
    await storage.erase(store.ownedProfile(actor, saved.profileId)!);
    expect(await bucket.get(row.object_key!)).toBeNull();
    expect(store.ownedProfile(actor, saved.profileId)?.key).toBeNull();
    expect(profile(store.ownedProfile(actor, saved.profileId)!)).toMatchObject({ state: "deleted" });
  }));
});
