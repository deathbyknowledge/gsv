import { Buffer } from "node:buffer";
import type { FilePersistence, StoredFsEntry } from "@humansandmachines/gsv-browser/fs-persistence";
import type { InstanceStore } from "./store";

export const MAX_BROWSER_FILE_BYTES = 16 * 1024 * 1024;

export function browserFilePersistence(store: InstanceStore, instanceId: string): FilePersistence {
  return {
    list: async () => store.sql.exec<{ entry: ArrayBuffer }>("SELECT entry FROM files WHERE instance_id = ?", instanceId).toArray().map(row => decodeEntry(row.entry)),
    get: async (path) => {
      const row = store.sql.exec<{ entry: ArrayBuffer }>("SELECT entry FROM files WHERE instance_id = ? AND path = ?", instanceId, path).toArray()[0];
      return row ? decodeEntry(row.entry) : null;
    },
    put: async (entry) => {
      if (JSON.parse(store.byId(instanceId).record).state !== "ready") throw new Error("Browser instance is no longer writable");
      const data = encodeEntry(entry);
      if (data.byteLength > MAX_BROWSER_FILE_BYTES) throw new Error("Browser file exceeds the 16 MiB limit");
      const total = store.sql.exec<{ bytes: number }>("SELECT COALESCE(SUM(length(entry)), 0) AS bytes FROM files WHERE instance_id = ? AND path != ?", instanceId, entry.path).one().bytes;
      if (total + data.byteLength > 64 * 1024 * 1024) throw new Error("Browser temporary storage limit reached");
      store.sql.exec("INSERT INTO files (instance_id, path, entry) VALUES (?, ?, ?) ON CONFLICT(instance_id, path) DO UPDATE SET entry = excluded.entry", instanceId, entry.path, data);
    },
    delete: async (paths) => {
      if (JSON.parse(store.byId(instanceId).record).state !== "ready") throw new Error("Browser instance is no longer writable");
      for (const path of paths) store.sql.exec("DELETE FROM files WHERE instance_id = ? AND path = ?", instanceId, path);
    },
  };
}

function encodeEntry(entry: StoredFsEntry): ArrayBuffer {
  const value = entry.kind === "file" ? { ...entry, content: Buffer.from(entry.content).toString("base64") } : entry;
  return new Uint8Array(new TextEncoder().encode(JSON.stringify(value))).buffer;
}
function decodeEntry(bytes: ArrayBuffer): StoredFsEntry {
  // SAFETY: encodeEntry is the sole writer; its file payload is base64 rather than an ArrayBuffer.
  const value = JSON.parse(new TextDecoder().decode(bytes)) as StoredFsEntry & { content?: string };
  if (value.kind === "file") return { ...value, content: new Uint8Array(Buffer.from(value.content, "base64")).buffer };
  return value;
}
