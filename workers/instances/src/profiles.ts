import type { CloudInstance } from "@humansandmachines/gsv/protocol";
import type { StorageState } from "./browser";
import { profile, type InstanceStore, type ProfileRow } from "./store";

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
    const bytes = new Uint8Array(await object.arrayBuffer());
    const data = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12), additionalData: new TextEncoder().encode(row.object_key) }, await this.key(row), bytes.slice(12));
    // SAFETY: Authenticated encryption binds these bytes to the exact revision saved from Playwright's storageState().
    return JSON.parse(new TextDecoder().decode(data)) as StorageState;
  }
  async save(instance: CloudInstance, state: StorageState, maxBytes: number): Promise<void> {
    if (!instance.profileId) return;
    const actor = { ownerUid: instance.ownerUid, human: false };
    const row = this.store.ownedProfile(actor, instance.profileId);
    if (!row || profile(row).state !== "active" || profile(row).activeInstanceId !== instance.instanceId) return;
    const data = new TextEncoder().encode(JSON.stringify(state));
    if (data.byteLength > maxBytes) throw new Error("Saved browser profile exceeds the storage allowance");
    const revision = row.saved_revision + 1;
    const address = `${this.prefix(row)}${revision}-${crypto.randomUUID()}`;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(address) }, await this.key(row), data));
    const bytes = new Uint8Array(12 + encrypted.byteLength); bytes.set(iv); bytes.set(encrypted, 12);
    await this.bucket.put(address, bytes, { httpMetadata: { contentType: "application/octet-stream" } });
    const current = this.store.ownedProfile(actor, instance.profileId);
    if (!current || profile(current).state !== "active" || profile(current).activeInstanceId !== instance.instanceId || current.saved_revision !== row.saved_revision) {
      await this.bucket.delete(address);
      return;
    }
    this.store.storage.transactionSync(() => {
      this.store.sql.exec("UPDATE profiles SET object_key = ?, saved_revision = ? WHERE id = ?", address, revision, row.id);
      this.store.putProfile({ ...profile(current), revision: profile(current).revision + 1, saveStatus: "saved", savedAt: Date.now(), diagnosticRef: undefined });
    });
    if (row.object_key) await this.bucket.delete(row.object_key);
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
