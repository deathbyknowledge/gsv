const FS_DB_NAME = "gsv-extension-target-fs";
const FS_DB_VERSION = 1;
const FS_ENTRY_STORE = "entries";

const textEncoder = new TextEncoder();

export type StoredFsEntry =
  | { path: string; kind: "directory"; updatedAt: number }
  | { path: string; kind: "file"; content: ArrayBuffer; updatedAt: number };

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

export async function getPersistedEntries(db: IDBDatabase): Promise<StoredFsEntry[]> {
  return await withStore<StoredFsEntry[]>(db, "readonly", (store) => requestToPromise(store.getAll()));
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

export function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export function bytesFromStoredContent(content: unknown): Uint8Array {
  if (content instanceof Uint8Array) {
    return copyBytes(content);
  }
  if (content instanceof ArrayBuffer) {
    return new Uint8Array(content.slice(0));
  }
  if (ArrayBuffer.isView(content)) {
    const view = new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
    return copyBytes(view);
  }
  return textEncoder.encode(String(content ?? ""));
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

function copyBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}
