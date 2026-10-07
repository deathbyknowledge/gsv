import type { BrowserPersistence, BrowserStorageIssue, BrowserStorageUsage, CloudInstance } from "@humansandmachines/gsv/protocol";
import { gzipSync, gunzipSync } from "node:zlib";
import type { StorageState } from "./browser";
import { profile, type InstanceStore, type ProfileRow } from "./store";
import { BrowserStorageError, MAX_PROFILE_BYTES } from "./browser-storage";

const FORMAT = new Uint8Array([71, 83, 86, 2]);

/** One installation coordinator owns every lease and revision committed here. */
export class ProfileStorage {
  constructor(private readonly installationId: string, private readonly bucket: R2Bucket, private readonly store: InstanceStore) {}
  private prefix(row: ProfileRow): string { return `${this.installationId}/owners/${row.owner_uid}/profiles/${row.id}/`; }
  private async key(row: ProfileRow): Promise<CryptoKey> {
    if (!row.key) throw new Error("Profile key has been erased");
    return crypto.subtle.importKey("raw", row.key, "AES-GCM", false, ["encrypt", "decrypt"]);
  }
  async restore(row: ProfileRow): Promise<StorageState | undefined> {
    if (!row.object_key) return undefined;
    if (!row.object_key.startsWith(this.prefix(row))) throw new Error("Saved profile scope mismatch");
    const object = await this.bucket.get(row.object_key);
    if (!object) throw new Error("Saved profile object is missing");
    if (object.size > MAX_PROFILE_BYTES + 65536) { await object.body.cancel(); throw new Error("Saved browser data exceeds the restore size limit"); }
    const bytes = new Uint8Array(await object.arrayBuffer());
    const data = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12), additionalData: new TextEncoder().encode(row.object_key) }, await this.key(row), bytes.slice(12));
    const payload = new Uint8Array(data);
    const compressed = FORMAT.every((value, index) => payload[index] === value);
    // Existing encrypted JSON snapshots remain readable and migrate on the next save.
    const decoded = compressed ? gunzipSync(payload.subarray(FORMAT.length), { maxOutputLength: MAX_PROFILE_BYTES }) : payload;
    if (decoded.byteLength > MAX_PROFILE_BYTES) throw new Error("Saved browser data exceeds the restore size limit");
    // SAFETY: Authenticated encryption binds these bytes to the exact revision saved from Playwright's storageState().
    const state = JSON.parse(new TextDecoder().decode(decoded)) as StorageState;
    if (!Array.isArray(state.cookies) || !Array.isArray(state.origins)) throw new Error("Invalid saved browser state");
    return state;
  }
  async save(instance: CloudInstance, state: StorageState, maxBytes: number, signal?: AbortSignal, usage?: BrowserStorageUsage, issues: BrowserStorageIssue[] = []): Promise<void> {
    signal?.throwIfAborted();
    if (!instance.profileId) return;
    const actor = { ownerUid: instance.ownerUid, human: false };
    const row = this.store.ownedProfile(actor, instance.profileId);
    if (!row || profile(row).state !== "active" || profile(row).activeInstanceId !== instance.instanceId) return;
    const previous = profile(row);
    const savedAt = Date.now();
    if (usage) usage = { ...usage, sites: usage.sites.map(site => ({ ...site, savedAt })) };
    if (issues.length) {
      const prior = await this.restore(row);
      signal?.throwIfAborted();
      const failed = new Set(issues.map(issue => issue.origin));
      const retained = prior?.origins.filter(site => failed.has(site.origin)) ?? [];
      issues = issues.map(issue => {
        const earlier = previous.issues?.find(old => old.origin === issue.origin);
        const retainedAt = retained.some(site => site.origin === issue.origin)
          ? earlier ? earlier.retainedAt : previous.usage?.sites.find(site => site.origin === issue.origin)?.savedAt ?? previous.savedAt
          : undefined;
        return { ...issue, retainedAt };
      });
      const hosts = issues.map(issue => new URL(issue.origin).hostname);
      // Keep cookies usable by a failed origin with its retained storage. Parent
      // domain cookies may also be shared by that site's other subdomains.
      const affected = (cookie: StorageState["cookies"][number]) => hosts.some(host => cookie.domain.startsWith(".")
        ? host === cookie.domain.slice(1) || host.endsWith(cookie.domain) : host === cookie.domain);
      state = {
        cookies: [...state.cookies.filter(cookie => !affected(cookie)), ...(prior?.cookies.filter(affected) ?? [])],
        origins: [...state.origins.filter(site => !failed.has(site.origin)), ...retained].sort((a, b) => a.origin.localeCompare(b.origin)),
      };
    }
    const data = new TextEncoder().encode(JSON.stringify(state));
    if (data.byteLength > Math.min(maxBytes, MAX_PROFILE_BYTES)) throw new BrowserStorageError(`Saved browser data needs ${data.byteLength} bytes; allowance is ${Math.min(maxBytes, MAX_PROFILE_BYTES)} bytes`, usage);
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", data)), byte => byte.toString(16).padStart(2, "0")).join("");
    signal?.throwIfAborted();
    const persistence: BrowserPersistence = { saveStatus: issues.length ? "partial" : "saved", savedAt, bytes: data.byteLength, limitBytes: maxBytes, issues: issues.length ? issues : undefined, error: undefined, diagnosticRef: undefined };
    if (row.object_key && profile(row).contentHash === hash) {
      const current = this.store.ownedProfile(actor, instance.profileId);
      if (current && profile(current).state === "active" && profile(current).activeInstanceId === instance.instanceId && current.saved_revision === row.saved_revision) {
        this.store.putProfile({ ...profile(current), revision: profile(current).revision + 1, ...persistence, usage });
      }
      return;
    }
    const revision = row.saved_revision + 1;
    const address = `${this.prefix(row)}${revision}-${crypto.randomUUID()}`;
    const compressed = gzipSync(data);
    const payload = new Uint8Array(FORMAT.length + compressed.byteLength); payload.set(FORMAT); payload.set(compressed, FORMAT.length);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(address) }, await this.key(row), payload));
    const bytes = new Uint8Array(12 + encrypted.byteLength); bytes.set(iv); bytes.set(encrypted, 12);
    signal?.throwIfAborted();
    await this.bucket.put(address, bytes, { httpMetadata: { contentType: "application/octet-stream" } });
    const current = this.store.ownedProfile(actor, instance.profileId);
    if (signal?.aborted || !current || profile(current).state !== "active" || profile(current).activeInstanceId !== instance.instanceId || current.saved_revision !== row.saved_revision) {
      await this.bucket.delete(address);
      signal?.throwIfAborted();
      return;
    }
    this.store.storage.transactionSync(() => {
      this.store.sql.exec("UPDATE profiles SET object_key = ?, saved_revision = ? WHERE id = ?", address, revision, row.id);
      this.store.putProfile({ ...profile(current), revision: profile(current).revision + 1, ...persistence, storedBytes: bytes.byteLength, contentHash: hash, usage });
    });
    if (row.object_key) await this.bucket.delete(row.object_key).catch(cause => this.store.diagnostic(instance.instanceId, cause));
  }
  async read(row: ProfileRow): Promise<R2ObjectBody | null> {
    if (!row.object_key) return null;
    if (!row.object_key.startsWith(this.prefix(row))) throw new Error("Saved profile scope mismatch");
    return this.bucket.get(row.object_key);
  }
  async erase(row: ProfileRow): Promise<void> {
    const prefix = `${this.installationId}/owners/${row.owner_uid}/profiles/${row.id}/`;
    let cursor: string | undefined;
    do {
      const listed = await this.bucket.list({ prefix, cursor });
      if (listed.objects.length) await this.bucket.delete(listed.objects.map(object => object.key));
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
    this.store.sql.exec("UPDATE profiles SET key = NULL, object_key = NULL WHERE id = ?", row.id);
    this.store.putProfile({ ...profile(row), state: "deleted", activeInstanceId: undefined, revision: profile(row).revision + 1 });
  }
}
