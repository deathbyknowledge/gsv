export type StorageCall = {
  method: "head" | "get" | "put" | "delete" | "list";
  key: string;
  started: number;
  settled?: number;
};

/** Records each storage call with the order in which it started and settled. */
export function recordStorageCalls(bucket: R2Bucket) {
  const calls: StorageCall[] = [];
  let clock = 0;
  const record = <T>(method: StorageCall["method"], key: string, call: () => Promise<T>): Promise<T> => {
    const entry: StorageCall = { method, key, started: clock++ };
    calls.push(entry);
    return call().finally(() => {
      entry.settled = clock++;
    });
  };
  const recorded: R2Bucket = {
    head: (key) => record("head", key, () => bucket.head(key)),
    get: (key: string, options?: R2GetOptions) => record("get", key, () => bucket.get(key, options)),
    put: (key: string, value: Parameters<R2Bucket["put"]>[1], options?: R2PutOptions) =>
      record("put", key, () => bucket.put(key, value, options)),
    delete: (keys) => record("delete", [keys].flat().join(","), () => bucket.delete(keys)),
    list: (options) => record("list", options?.prefix ?? "", () => bucket.list(options)),
    createMultipartUpload: (key, options) => bucket.createMultipartUpload(key, options),
    resumeMultipartUpload: (key, uploadId) => bucket.resumeMultipartUpload(key, uploadId),
  };
  return { bucket: recorded, calls };
}
