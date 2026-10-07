import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { instance, InstanceStore, profile } from "../src/store";
import { ProfileStorage } from "../src/profiles";
import { migrate } from "../src/schema";
import type { StorageState } from "../src/browser";

const limits = { enabled: true, concurrentInstances: 2, periodSeconds: 1000, maxInstanceSeconds: 600, savedProfiles: 2, profileStorageBytes: 5242880 };
const actor = { ownerUid: 1000, human: true };
const namespace = env.INSTANCES;
const bucket = env.PROFILES;
function inStore<T>(work: (store: InstanceStore) => T | Promise<T>) {
  return runInDurableObject(namespace.getByName(crypto.randomUUID()), async (_object, ctx) => work(new InstanceStore(ctx.storage)));
}

describe("instance admission", () => {
  it("reuses a starting browser, remembers every request, and keeps one allowance and login store", () => inStore(store => {
    const first = store.admit(actor, { requestId: "human", templateId: "browser", lifetimeSeconds: 300 }, limits);
    const second = store.admit({ ...actor, human: false, processId: "ship" }, { requestId: "ship", templateId: "browser" }, limits);
    expect(second.instanceId).toBe(first.instanceId);
    expect(first.targetId).toMatch(/^[0-9a-f]{8}$/);
    expect(first.profileId).toBeDefined();
    expect(store.profiles(actor.ownerUid)).toHaveLength(1);
    expect(store.usage(limits)).toMatchObject({ activeInstances: 1, reservedSeconds: 300 });
    expect(store.owned(actor, { startRequestId: "ship" })?.id).toBe(first.instanceId);
    store.terminal(first.instanceId, false);
    expect(store.admit(actor, { requestId: "ship", templateId: "browser" }, limits).state).toBe("stopped");
    const next = store.admit(actor, { requestId: "later", templateId: "browser", lifetimeSeconds: 300 }, limits);
    expect(next.instanceId).not.toBe(first.instanceId);
    expect(next.profileId).toBe(first.profileId);
  }));
  it("creates an explicit isolated browser without replacing the default or sharing its logins", () => inStore(store => {
    const primary = store.admit(actor, { requestId: "primary", templateId: "browser", lifetimeSeconds: 300 }, limits);
    const isolated = store.admit(actor, { requestId: "isolated", templateId: "browser", fresh: true, lifetimeSeconds: 300 }, limits);
    expect(isolated.instanceId).not.toBe(primary.instanceId);
    expect(isolated.label).not.toBe(primary.label);
    expect(isolated.profileId).toBeUndefined();
    expect(store.admit(actor, { requestId: "ordinary", templateId: "browser", lifetimeSeconds: 300 }, limits).instanceId).toBe(primary.instanceId);
  }));
  it("migrates original start receipts without changing their replay semantics", () => inStore(store => {
    const args = { requestId: "before-upgrade", templateId: "browser", lifetimeSeconds: 300 };
    const first = store.admit(actor, args, limits);
    store.sql.exec("DROP TABLE start_requests");
    store.sql.exec("DELETE FROM instance_schema WHERE id = 4");
    store.sql.exec("UPDATE instances SET fingerprint = json_remove(fingerprint, '$[4]')");
    migrate(store.storage);
    expect(store.admit(actor, args, limits).instanceId).toBe(first.instanceId);
    expect(() => store.admit(actor, { ...args, fresh: true }, limits)).toThrow("different arguments");
  }));
  it("fences a stop that arrives before its start request", () => inStore(store => {
    store.cancelStart(actor, "late-start");
    expect(() => store.admit(actor, { requestId: "late-start", templateId: "browser" }, limits)).toThrow("cancelled before admission");
    expect(store.rows()).toHaveLength(0);
    expect(store.admit({ ownerUid: 1001, human: true }, { requestId: "late-start", templateId: "browser", lifetimeSeconds: 60 }, limits).state).toBe("starting");
  }));
  it("adds provider recovery state without changing existing sessions or leases", () => inStore(store => {
    const first = store.admit(actor, { requestId: "before-health-upgrade", templateId: "browser", lifetimeSeconds: 300 }, limits);
    store.sql.exec("UPDATE instances SET session_id = ? WHERE id = ?", "surviving-session", first.instanceId);
    store.sql.exec("ALTER TABLE instances DROP COLUMN provider_failed_at");
    store.sql.exec("DELETE FROM instance_schema WHERE id = 5");
    migrate(store.storage);
    expect(store.byId(first.instanceId)).toMatchObject({ session_id: "surviving-session", provider_failed_at: null });
    expect(instance(store.byId(first.instanceId))).toEqual(first);
    expect(profile(store.ownedProfile(actor, first.profileId!)!).activeInstanceId).toBe(first.instanceId);
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
    store.admit(actor, { requestId: "two", templateId: "browser", fresh: true, lifetimeSeconds: 300 }, limits);
    expect(() => store.admit(actor, { requestId: "three", templateId: "browser", fresh: true, lifetimeSeconds: 60 }, limits)).toThrow("concurrency");
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
    expect(() => store.admit(actor, { requestId: "two", templateId: "browser", fresh: true, profileId: saved.profileId, lifetimeSeconds: 300 }, limits)).toThrow("already in use");
    store.terminal(first.instanceId, false);
    const second = store.admit(actor, { requestId: "two", templateId: "browser", fresh: true, profileId: saved.profileId, lifetimeSeconds: 300 }, limits);
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
  it("saves healthy sites while retaining a failed site's storage, cookies and original save time", () => inStore(async store => {
    const started = store.admit(actor, { requestId: "partial", templateId: "browser" }, limits);
    const storage = new ProfileStorage("partial", bucket, store);
    const cookie = (domain: string, value: string): StorageState["cookies"][number] => ({ name: "session", domain, value, path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" });
    const site = (origin: string, value: string) => ({ origin, localStorage: [{ name: "session", value }] });
    const bad = "https://app.example.com", good = "https://shop.example.org";
    await storage.save(started, { cookies: [cookie(".example.com", "old"), cookie("shop.example.org", "old")], origins: [site(bad, "old"), site(good, "old")] }, 10000);
    const originalTime = profile(store.ownedProfile(actor, started.profileId!)!).savedAt;
    const state = { cookies: [cookie(".example.com", "unsafe-new"), cookie("shop.example.org", "new"), cookie("notexample.com", "unrelated")], origins: [site(good, "new")] };
    const issues = [{ origin: bad, reason: "unsupported" as const, message: "Unsupported CryptoKey", diagnosticRef: "diagnostic" }];
    await storage.save(started, state, 10000, undefined, undefined, issues);
    const first = store.ownedProfile(actor, started.profileId!)!;
    expect(profile(first)).toMatchObject({ saveStatus: "partial", issues: [{ ...issues[0], retainedAt: originalTime }] });
    const restored = await storage.restore(first);
    expect(restored?.origins).toEqual([site(bad, "old"), site(good, "new")]);
    expect(restored?.cookies).toEqual([cookie("shop.example.org", "new"), cookie("notexample.com", "unrelated"), cookie(".example.com", "old")]);
    await storage.save(started, state, 10000, undefined, undefined, issues);
    const repeated = store.ownedProfile(actor, started.profileId!)!;
    expect(repeated.object_key).toBe(first.object_key);
    expect(profile(repeated).issues?.[0]?.retainedAt).toBe(originalTime);
    await storage.save(started, restored!, 10000);
    const recovered = store.ownedProfile(actor, started.profileId!)!;
    expect(recovered.object_key).toBe(first.object_key);
    expect(profile(recovered).saveStatus).toBe("saved");
    expect(profile(recovered).issues).toBeUndefined();
  }));
  it("reports a new unsavable site without claiming an older copy exists", () => inStore(async store => {
    const started = store.admit(actor, { requestId: "new-partial", templateId: "browser" }, limits);
    const storage = new ProfileStorage("new-partial", bucket, store);
    const state = { cookies: [], origins: [{ origin: "https://good.example", localStorage: [{ name: "session", value: "new" }] }] };
    await storage.save(started, state, 10000, undefined, undefined, [{ origin: "https://bad.example", reason: "unavailable", message: "Site storage timed out" }]);
    const row = store.ownedProfile(actor, started.profileId!)!;
    expect(profile(row).saveStatus).toBe("partial");
    expect(profile(row).issues?.[0]?.retainedAt).toBeUndefined();
    expect(await storage.restore(row)).toEqual(state);
  }));
  it("removes a late upload after cancellation instead of replacing the last good revision", () => inStore(async store => {
    const started = store.admit(actor, { requestId: "late", templateId: "browser" }, limits);
    const storage = new ProfileStorage("late", bucket, store);
    const state = { cookies: [], origins: [] };
    await storage.save(started, state, 10000);
    const before = store.ownedProfile(actor, started.profileId!)!;
    let release!: () => void;
    const put = bucket.put.bind(bucket);
    const uploading = vi.fn(async (...args: Parameters<R2Bucket["put"]>) => {
      const result = await put(...args);
      await new Promise<void>(resolve => { release = resolve; });
      return result;
    });
    const delayed: R2Bucket = {
      // SAFETY: The delayed put delegates every overload to the real bucket and
      // preserves its result, delaying only the completion notification.
      put: uploading as R2Bucket["put"],
      get: bucket.get.bind(bucket), head: bucket.head.bind(bucket),
      delete: bucket.delete.bind(bucket), list: bucket.list.bind(bucket),
      createMultipartUpload: bucket.createMultipartUpload.bind(bucket),
      resumeMultipartUpload: bucket.resumeMultipartUpload.bind(bucket),
    };
    const abort = new AbortController();
    const saving = new ProfileStorage("late", delayed, store).save(started, { cookies: [], origins: [{ origin: "https://example.com", localStorage: [] }] }, 10000, abort.signal);
    const rejected = expect(saving).rejects.toThrow("Cancelled");
    await vi.waitFor(() => expect(release).toBeDefined());
    abort.abort(new Error("Cancelled")); release(); await rejected;
    expect(store.ownedProfile(actor, started.profileId!)?.object_key).toBe(before.object_key);
    expect((await bucket.list({ prefix: `late/owners/1000/profiles/${started.profileId}/` })).objects.map(object => object.key)).toEqual([before.object_key]);
  }));
  it.each(["cancelled", "lease-lost", "deleting", "upload-error"] as const)("retains cleanup for a rejected %s upload when deletion fails", reason => inStore(async store => {
    const started = store.admit(actor, { requestId: "rejected-upload", templateId: "browser" }, limits);
    const storage = new ProfileStorage("rejected-upload", bucket, store);
    const prior = { cookies: [], origins: [] };
    await storage.save(started, prior, 10000);
    const before = store.ownedProfile(actor, started.profileId!)!;
    const abort = new AbortController();
    let uploaded!: string;
    const put = async (...args: Parameters<R2Bucket["put"]>) => {
      const result = await bucket.put(...args); uploaded = args[0];
      if (reason === "cancelled") abort.abort(new Error("Cancelled"));
      else if (reason === "lease-lost") store.putProfile({ ...profile(before), activeInstanceId: undefined });
      else if (reason === "deleting") store.putProfile({ ...profile(before), state: "deleting" });
      else throw new Error("Upload response lost");
      return result;
    };
    const failing: R2Bucket = {
      // SAFETY: Every put overload delegates to R2 before the fixture rejects the save.
      put: put as R2Bucket["put"],
      get: bucket.get.bind(bucket), head: bucket.head.bind(bucket),
      delete: async () => { throw new Error("Storage deletion unavailable"); }, list: bucket.list.bind(bucket),
      createMultipartUpload: bucket.createMultipartUpload.bind(bucket), resumeMultipartUpload: bucket.resumeMultipartUpload.bind(bucket),
    };
    const saving = new ProfileStorage("rejected-upload", failing, store).save(started,
      { cookies: [], origins: [{ origin: "https://example.com", localStorage: [] }] }, 10000, abort.signal);
    if (reason === "cancelled" || reason === "upload-error") await expect(saving).rejects.toThrow(reason === "cancelled" ? "Cancelled" : "Upload response lost");
    else await saving;
    expect(store.ownedProfile(actor, started.profileId!)?.object_key).toBe(before.object_key);
    expect(store.sql.exec("SELECT object_key FROM obsolete_profile_objects").toArray()).toEqual([{ object_key: uploaded }]);
    expect(await bucket.head(uploaded)).not.toBeNull();
    const reopened = new ProfileStorage("rejected-upload", bucket, new InstanceStore(store.storage));
    await reopened.cleanup();
    expect(reopened.hasPendingCleanup()).toBe(false);
    expect(await bucket.head(uploaded)).toBeNull();
    expect(await reopened.restore(store.ownedProfile(actor, started.profileId!)!)).toEqual(prior);
  }));
  it("compresses large state, skips unchanged uploads, and retains it after an oversized save", () => inStore(async store => {
    const started = store.admit(actor, { requestId: "large", templateId: "browser" }, limits);
    const storage = new ProfileStorage("large", bucket, store);
    const state = { cookies: [], origins: [{ origin: "https://example.com", localStorage: [{ name: "cache", value: "x".repeat(8 * 1024 * 1024) }] }] };
    await storage.save(started, state, 16 * 1024 * 1024);
    const row = store.ownedProfile(actor, started.profileId!)!;
    expect(profile(row).bytes).toBeGreaterThan(8 * 1024 * 1024);
    expect(profile(row).storedBytes).toBeLessThan(16000);
    expect(await storage.restore(row)).toEqual(state);
    await storage.save(started, state, 16 * 1024 * 1024);
    expect(store.ownedProfile(actor, started.profileId!)?.object_key).toBe(row.object_key);
    await expect(storage.save(started, state, 5 * 1024 * 1024)).rejects.toThrow("allowance");
    expect(await storage.restore(store.ownedProfile(actor, started.profileId!)!)).toEqual(state);
  }));
  it("reads legacy encrypted JSON then upgrades it on the next save", () => inStore(async store => {
    const started = store.admit(actor, { requestId: "legacy", templateId: "browser" }, limits);
    const row = store.ownedProfile(actor, started.profileId!)!;
    const address = `legacy/owners/${actor.ownerUid}/profiles/${row.id}/1-old`;
    const state = { cookies: [], origins: [{ origin: "https://example.com", localStorage: [{ name: "session", value: "legacy" }] }] };
    const key = await crypto.subtle.importKey("raw", row.key!, "AES-GCM", false, ["encrypt"]);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(address) }, key, new TextEncoder().encode(JSON.stringify(state))));
    const bytes = new Uint8Array(12 + encrypted.length); bytes.set(iv); bytes.set(encrypted, 12);
    await bucket.put(address, bytes);
    store.sql.exec("UPDATE profiles SET object_key = ?, saved_revision = 1 WHERE id = ?", address, row.id);
    const storage = new ProfileStorage("legacy", bucket, store);
    expect(await storage.restore(store.ownedProfile(actor, row.id)!)).toEqual(state);
    await storage.save(started, state, 10000);
    expect(store.ownedProfile(actor, row.id)?.saved_revision).toBe(2);
    await storage.cleanup();
    expect(await bucket.get(address)).toBeNull();
  }));
  it("retains obsolete snapshot cleanup across reconstruction without changing the committed save", () => inStore(async store => {
    const started = store.admit(actor, { requestId: "cleanup", templateId: "browser" }, limits);
    const storage = new ProfileStorage("cleanup", bucket, store);
    await storage.save(started, { cookies: [], origins: [] }, 10000);
    const oldKey = store.ownedProfile(actor, started.profileId!)!.object_key!;
    const state = { cookies: [], origins: [{ origin: "https://example.com", localStorage: [{ name: "login", value: "new" }] }] };
    await storage.save(started, state, 10000);
    expect(storage.hasPendingCleanup()).toBe(true);
    const reopened = new ProfileStorage("cleanup", bucket, new InstanceStore(store.storage));
    const current = store.ownedProfile(actor, started.profileId!)!;
    expect(profile(current).saveStatus).toBe("saved");
    expect(await reopened.restore(current)).toEqual(state);
    await reopened.cleanup();
    expect(await bucket.head(oldKey)).toBeNull();
    expect(await bucket.head(current.object_key!)).not.toBeNull();
    expect(reopened.hasPendingCleanup()).toBe(false);
  }));
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
