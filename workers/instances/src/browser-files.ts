import { Buffer } from "node:buffer";
import { storedFsMetadata, type FilePersistence, type StoredFsEntry, type StoredFsMetadata } from "@humansandmachines/gsv-browser/fs-persistence";
import type { InstanceStore } from "./store";

export const MAX_BROWSER_FILE_BYTES = 16 * 1024 * 1024;
const CHUNK_BYTES = 1024 * 1024;

export function browserFilePersistence(store: InstanceStore, instanceId: string): FilePersistence {
  return {
    list: async () => store.sql.exec<{ metadata: string }>("SELECT metadata FROM files WHERE instance_id = ?", instanceId).toArray().map(row => decodeMetadata(row.metadata)),
    stat: async (path) => {
      const row = store.sql.exec<{ metadata: string }>("SELECT metadata FROM files WHERE instance_id = ? AND path = ?", instanceId, path).toArray()[0];
      return row ? decodeMetadata(row.metadata) : null;
    },
    get: async (path) => {
      const row = store.sql.exec<{ encoded_size: number }>("SELECT encoded_size FROM files WHERE instance_id = ? AND path = ?", instanceId, path).toArray()[0];
      if (!row) return null;
      const data = new Uint8Array(row.encoded_size);
      for (const chunk of store.sql.exec<{ part: number; data: ArrayBuffer }>("SELECT part, data FROM file_chunks WHERE instance_id = ? AND path = ? ORDER BY part", instanceId, path)) {
        data.set(new Uint8Array(chunk.data), chunk.part * CHUNK_BYTES);
      }
      return decodeEntry(data.buffer);
    },
    put: async (entry) => {
      if (JSON.parse(store.byId(instanceId).record).state !== "ready") throw new Error("Browser instance is no longer writable");
      const header = JSON.stringify(entry.kind === "file" ? { ...entry, content: "" } : entry);
      const encodedSize = new TextEncoder().encode(header).byteLength + (entry.kind === "file" ? 4 * Math.ceil(entry.content.byteLength / 3) : 0);
      if (encodedSize > MAX_BROWSER_FILE_BYTES) throw new Error("Browser file exceeds the 16 MiB limit");
      const data = encodeEntry(entry);
      const total = store.sql.exec<{ bytes: number }>("SELECT COALESCE(SUM(encoded_size), 0) AS bytes FROM files WHERE instance_id = ? AND path != ?", instanceId, entry.path).one().bytes;
      if (total + data.byteLength > 64 * 1024 * 1024) throw new Error("Browser temporary storage limit reached");
      store.storage.transactionSync(() => {
        store.sql.exec("DELETE FROM file_chunks WHERE instance_id = ? AND path = ?", instanceId, entry.path);
        store.sql.exec("INSERT INTO files (instance_id, path, encoded_size, metadata) VALUES (?, ?, ?, ?) ON CONFLICT(instance_id, path) DO UPDATE SET encoded_size = excluded.encoded_size, metadata = excluded.metadata", instanceId, entry.path, data.byteLength, JSON.stringify(storedFsMetadata(entry)));
        for (let offset = 0; offset < data.byteLength; offset += CHUNK_BYTES) {
          store.sql.exec("INSERT INTO file_chunks (instance_id, path, part, data) VALUES (?, ?, ?, ?)", instanceId, entry.path, offset / CHUNK_BYTES, data.subarray(offset, offset + CHUNK_BYTES));
        }
      });
    },
    delete: async (paths) => {
      if (JSON.parse(store.byId(instanceId).record).state !== "ready") throw new Error("Browser instance is no longer writable");
      store.storage.transactionSync(() => {
        for (const path of paths) {
          store.sql.exec("DELETE FROM file_chunks WHERE instance_id = ? AND path = ?", instanceId, path);
          store.sql.exec("DELETE FROM files WHERE instance_id = ? AND path = ?", instanceId, path);
        }
      });
    },
  };
}

function decodeMetadata(value: string): StoredFsMetadata {
  // SAFETY: Metadata is committed with each entry or derived by the versioned migration.
  return JSON.parse(value) as StoredFsMetadata;
}

function encodeEntry(entry: StoredFsEntry): Uint8Array {
  const value = entry.kind === "file" ? { ...entry, content: Buffer.from(entry.content).toString("base64") } : entry;
  return new TextEncoder().encode(JSON.stringify(value));
}
function decodeEntry(bytes: ArrayBuffer): StoredFsEntry {
  // SAFETY: encodeEntry is the sole writer; its file payload is base64 rather than an ArrayBuffer.
  const value = JSON.parse(new TextDecoder().decode(bytes)) as StoredFsEntry & { content?: string };
  if (value.kind === "file") return { ...value, content: new Uint8Array(Buffer.from(value.content, "base64")).buffer };
  return value;
}
