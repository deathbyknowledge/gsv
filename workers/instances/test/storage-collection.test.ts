import { describe, expect, it, vi } from "vitest";
import { collectBrowserStorage, encodeBrowserBinary } from "../../../tools/instances/storage-collection.mjs";
import { Buffer } from "node:buffer";

type RecordValue = string | Uint8Array | bigint | number[];
type CursorRequest = { result: { key: string; value: RecordValue; continue: () => void } | null; onsuccess?: () => void };

function fixture(values: RecordValue[]) {
  const close = vi.fn(), abort = vi.fn(), serialize = vi.fn(value => ({ trivial: value }));
  let reads = 0;
  const transaction = { objectStore: () => objectStore, abort };
  const objectStore = { autoIncrement: false, keyPath: null, indexNames: [], openCursor: () => {
    let index = 0;
    const request: CursorRequest = { result: null };
    const advance = () => queueMicrotask(() => {
      request.result = index < values.length ? { key: `key-${index}`, value: values[index]!, continue: () => { index++; advance(); } } : null;
      if (request.result) reads++;
      request.onsuccess?.();
    });
    advance(); return request;
  } };
  const db = { objectStoreNames: ["records"], transaction: () => transaction, close };
  const codec = { _global: { location: { origin: "https://example.com" }, localStorage: { length: 0 }, indexedDB: { databases: async () => [{ name: "records", version: 1 }], open: () => db } },
    _idbRequestToPromise: async () => db, _trySerialize: serialize };
  return { collect: (limit: number) => collectBrowserStorage.call(codec, true, limit), close, abort, serialize, reads: () => reads };
}

describe("incremental IndexedDB collection", () => {
  it("encodes binary fallback chunks without padding between chunks or reading beyond a view", () => {
    const data = new Uint8Array(100001);
    for (let i = 0; i < data.length; i++) data[i] = i % 256;
    for (const end of [0, 1, 2, 12288, 12289, 99999]) {
      const view = data.subarray(1, end + 1);
      expect(encodeBrowserBinary(view)).toBe(Buffer.from(view).toString("base64"));
    }
  });
  it("stops a large database at its budget without reading the remaining records", async () => {
    const db = fixture(Array.from({ length: 1000 }, () => "x".repeat(1024)));
    await expect(db.collect(4096)).rejects.toMatchObject({ name: "StorageBudgetExceeded", minimumBytes: expect.any(Number) });
    expect(db.reads()).toBeGreaterThan(1); expect(db.reads()).toBeLessThan(5);
    expect(db.abort).toHaveBeenCalledOnce(); expect(db.close).toHaveBeenCalledOnce();
  });
  it("rejects a large binary record before copying it through the serialization codec", async () => {
    const large = new Uint8Array(8192), db = fixture([large]);
    await expect(db.collect(4096)).rejects.toMatchObject({ name: "StorageBudgetExceeded" });
    expect(db.serialize.mock.calls.some(([value]) => value === large)).toBe(false);
    expect(db.close).toHaveBeenCalledOnce();
  });
  it.each(["\u0000".repeat(1024), "界".repeat(2048), new Uint8Array(3500), 1n << 16384n, Array.from({ length: 1024 }, () => Number.MAX_VALUE)])("accounts for encoded expansion before the codec copies a value", async large => {
    const db = fixture([large]);
    await expect(db.collect(4096)).rejects.toMatchObject({ name: "StorageBudgetExceeded" });
    expect(db.serialize.mock.calls.some(([value]) => value === large)).toBe(false);
    expect(db.close).toHaveBeenCalledOnce();
  });
  it("collects a fitting database exactly and closes its connection", async () => {
    const db = fixture(["first", "second"]);
    const result = await db.collect(4096);
    expect(result.indexedDB[0].stores[0].records).toEqual([{ key: "key-0", value: "first" }, { key: "key-1", value: "second" }]);
    const exact = new TextEncoder().encode(JSON.stringify({ origin: "https://example.com", ...result })).byteLength;
    expect(await fixture(["first", "second"]).collect(exact)).toEqual(result);
    await expect(fixture(["first", "second"]).collect(exact - 1)).rejects.toMatchObject({ name: "StorageBudgetExceeded" });
    expect(db.abort).not.toHaveBeenCalled(); expect(db.close).toHaveBeenCalledOnce();
  });
  it.each([[], ["x".repeat(16383) + "😀"], ["\ud800", "界"]].map(values => ({ values })))("accepts exact byte budgets with optional metadata and Unicode boundaries", async ({ values }) => {
    const result = await fixture(values).collect(1024 * 1024);
    const exact = new TextEncoder().encode(JSON.stringify({ origin: "https://example.com", ...result })).byteLength;
    expect(await fixture(values).collect(exact)).toEqual(result);
  });
});
