/** The fallback avoids arrays with one JavaScript entry per input byte. */
export function encodeBrowserBinary(array) {
  const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength), parts = [];
  for (let offset = 0; offset < bytes.byteLength; offset += 12288) {
    parts.push(btoa(String.fromCharCode(...bytes.subarray(offset, offset + 12288))));
  }
  return parts.join("");
}

/** Serialized into Playwright's isolated export page; keep dependencies local. */
export async function collectBrowserStorage(recordIndexedDB, maxBytes = 32 * 1024 * 1024) {
  const size = value => new TextEncoder().encode(JSON.stringify(value)).byteLength;
  const result = { localStorage: [], indexedDB: [] };
  let used = size({ origin: this._global.location.origin, ...result });
  const exceeded = minimum => {
    const error = new Error("Browser storage exceeds the remaining byte allowance");
    error.name = "StorageBudgetExceeded"; error.minimumBytes = minimum; throw error;
  };
  const charge = bytes => { used += bytes; if (used > maxBytes) exceeded(used); };
  // Check a lower bound before the codec can copy a large binary value or graph.
  const preflight = (value, metadata = false) => {
    let minimum = used;
    const seen = new Set();
    const visit = item => {
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- IndexedDB's structured-clone boundary admits strings and object graphs.
      if (typeof item === "string") {
        minimum += 2;
        for (let offset = 0; offset < item.length;) {
          let end = Math.min(offset + 16384, item.length);
          if (end < item.length && item.charCodeAt(end - 1) >= 0xd800 && item.charCodeAt(end - 1) <= 0xdbff && item.charCodeAt(end) >= 0xdc00 && item.charCodeAt(end) <= 0xdfff) end--;
          minimum += size(item.slice(offset, end)) - 2; offset = end;
          if (minimum > maxBytes) exceeded(minimum);
        }
      }
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Measure structured-clone graphs before the codec allocates their JSON representation.
      else if (item && typeof item === "object") {
        minimum += 2;
        // The codec emits these atomic values in full at each reference.
        if (item instanceof ArrayBuffer || ArrayBuffer.isView(item)) minimum += 4 * Math.ceil(item.byteLength / 3);
        else if (item instanceof Date) visit(item.toJSON());
        else if (item instanceof URL) visit(item.href);
        else if (item instanceof RegExp) { visit(item.source); visit(item.flags); }
        else if (item instanceof Error) {
          visit(item.name); visit(item.message); visit(item.stack ?? "");
          if (!item.stack?.startsWith(`${item.name}: ${item.message}`)) { visit(item.name); visit(item.message); }
        } else {
          if (seen.has(item)) return;
          seen.add(item);
          if (item instanceof Map) { for (const [key, value] of item) { visit(key); visit(value); } }
          else if (item instanceof Set || Array.isArray(item)) { for (const value of item) visit(value); }
          else for (const key of Object.keys(item)) {
            if (metadata && item[key] === undefined) continue;
            visit(key); visit(item[key]);
          }
        }
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Bound a BigInt's decimal conversion before the structured-clone codec allocates it.
      } else if (typeof item === "bigint") {
        const remaining = maxBytes - minimum;
        if (remaining < 10 || BigInt.asIntN(Math.floor(remaining) * 4, item) !== item) exceeded(maxBytes + 1);
        minimum += item.toString().length + 9;
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- The codec represents undefined and symbols with an explicit JSON sentinel.
      } else if (item === undefined || typeof item === "symbol") minimum += 17;
      else minimum += size(item);
      if (minimum > maxBytes) exceeded(minimum);
    };
    visit(value);
  };
  for (let index = 0; index < this._global.localStorage.length; index++) {
    const name = this._global.localStorage.key(index), value = this._global.localStorage.getItem(name);
    const entry = { name, value }; preflight(entry, true);
    charge(size(entry) + (result.localStorage.length ? 1 : 0)); result.localStorage.push(entry);
  }
  if (!recordIndexedDB) return { localStorage: result.localStorage };
  for (const info of await this._global.indexedDB.databases()) {
    if (!info.name || !info.version) throw new Error("Database name or version is unset");
    const database = { name: info.name, version: info.version, stores: [] }; preflight(database, true);
    charge(size(database) + (result.indexedDB.length ? 1 : 0));
    const db = await this._idbRequestToPromise(this._global.indexedDB.open(info.name));
    try {
      for (const storeName of db.objectStoreNames) {
        const transaction = db.transaction(storeName, "readonly"), objectStore = transaction.objectStore(storeName);
        const store = { name: storeName, records: [], indexes: [], autoIncrement: objectStore.autoIncrement,
          // oxlint-disable-next-line anti-slop/no-runtime-typeof -- The IndexedDB API defines keyPath as string, string array or null.
          keyPath: typeof objectStore.keyPath === "string" ? objectStore.keyPath : undefined,
          keyPathArray: Array.isArray(objectStore.keyPath) ? objectStore.keyPath : undefined };
        for (const indexName of objectStore.indexNames) {
          const index = objectStore.index(indexName);
          // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Preserve the IndexedDB API's distinct scalar and compound key paths.
          store.indexes.push({ name: index.name, keyPath: typeof index.keyPath === "string" ? index.keyPath : undefined,
            keyPathArray: Array.isArray(index.keyPath) ? index.keyPath : undefined, multiEntry: index.multiEntry, unique: index.unique });
        }
        preflight(store, true); charge(size(store) + (database.stores.length ? 1 : 0));
        await new Promise((resolve, reject) => {
          const request = objectStore.openCursor();
          request.onerror = () => reject(request.error);
          transaction.onabort = () => reject(transaction.error || new Error("IndexedDB export aborted"));
          request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) { resolve(); return; }
            try {
              const record = {};
              if (objectStore.keyPath === null) {
                const rawKey = cursor.key; preflight(rawKey);
                const key = this._trySerialize(rawKey);
                if (key.trivial) record.key = key.trivial; else record.keyEncoded = key.encoded;
              }
              const rawValue = cursor.value; preflight(rawValue);
              const value = this._trySerialize(rawValue);
              if (value.trivial) record.value = value.trivial; else record.valueEncoded = value.encoded;
              charge(size(record) + (store.records.length ? 1 : 0));
              store.records.push(record); cursor.continue();
            } catch (error) { reject(error); transaction.abort(); }
          };
        });
        database.stores.push(store);
      }
      result.indexedDB.push(database);
    } finally { db.close(); }
  }
  return result;
}
