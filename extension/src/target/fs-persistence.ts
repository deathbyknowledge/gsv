const FS_DB_NAME = "gsv-extension-target-fs";
const FS_DB_VERSION = 1;
const FS_ENTRY_STORE = "entries";

import { storedFsMetadata, type StoredFsEntry, type StoredFsMetadata, type FilePersistence } from "@humansandmachines/gsv-browser/fs-persistence";
export { bytesFromStoredContent, bytesToArrayBuffer } from "@humansandmachines/gsv-browser/fs-persistence";
export type { StoredFsEntry } from "@humansandmachines/gsv-browser/fs-persistence";

export type FsPersistenceBackend =
  | { kind: "indexeddb"; db: IDBDatabase }
  | { kind: "memory" };

export async function openPersistenceBackend(): Promise<FsPersistenceBackend> {
  if (typeof indexedDB === "undefined") {
    return { kind: "memory" };
  }
  try {
    return { kind: "indexeddb", db: await openFsDatabase() };
  } catch (error) {
    console.warn("GSV browser target IndexedDB filesystem unavailable, using memory", error);
    return { kind: "memory" };
  }
}

export function openFsDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(FS_DB_NAME, FS_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(FS_ENTRY_STORE)) {
        db.createObjectStore(FS_ENTRY_STORE, { keyPath: "path" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Unable to open IndexedDB filesystem"));
    request.onblocked = () => reject(new Error("IndexedDB filesystem open blocked"));
  });
}

async function getPersistedMetadata(db: IDBDatabase): Promise<StoredFsMetadata[]> {
  return await withStore(db, "readonly", store => new Promise((resolve, reject) => {
    const entries: StoredFsMetadata[] = [];
    const request = store.openCursor();
    request.onerror = () => reject(request.error ?? new Error("Unable to list browser files"));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) { resolve(entries); return; }
      // SAFETY: The entries store is written exclusively through putPersistedEntry.
      entries.push(storedFsMetadata(cursor.value as StoredFsEntry));
      cursor.continue();
    };
  }));
}

export async function getPersistedEntry(db: IDBDatabase, path: string): Promise<StoredFsEntry | null> {
  const entry = await withStore<StoredFsEntry | undefined>(db, "readonly", (store) =>
    requestToPromise(store.get(path))
  );
  return entry ?? null;
}

export async function putPersistedEntry(db: IDBDatabase, entry: StoredFsEntry): Promise<void> {
  await withStore<void>(db, "readwrite", async (store) => {
    await requestToPromise(store.put(entry));
  });
}

export async function deletePersistedEntries(db: IDBDatabase, paths: string[]): Promise<void> {
  await withStore<void>(db, "readwrite", async (store) => {
    await Promise.all(paths.map((path) => requestToPromise(store.delete(path))));
  });
}

function withStore<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => Promise<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(FS_ENTRY_STORE, mode);
    const store = transaction.objectStore(FS_ENTRY_STORE);
    let result: T;

    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB filesystem transaction failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB filesystem transaction aborted"));

    run(store).then((value) => {
      result = value;
    }).catch((error) => {
      transaction.abort();
      reject(error);
    });
  });
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB filesystem request failed"));
  });
}


export async function openFilePersistence(): Promise<FilePersistence | null> {
  const backend = await openPersistenceBackend();
  if (backend.kind === "memory") return null;
  return {
    list: () => getPersistedMetadata(backend.db),
    stat: async (path) => {
      const entry = await getPersistedEntry(backend.db, path);
      return entry ? storedFsMetadata(entry) : null;
    },
    get: (path) => getPersistedEntry(backend.db, path),
    put: (entry) => putPersistedEntry(backend.db, entry),
    delete: (paths) => deletePersistedEntries(backend.db, paths),
  };
}
