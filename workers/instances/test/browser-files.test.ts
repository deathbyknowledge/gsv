import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { BrowserFsDriver, BrowserTargetFileSystem } from "@humansandmachines/gsv-browser/fs";
import type { TargetFileSystem } from "@humansandmachines/gsv-browser/types";
import type { FilePersistence } from "@humansandmachines/gsv-browser/fs-persistence";
import { browserFilePersistence, MAX_BROWSER_FILE_BYTES } from "../src/browser-files";
import { InstanceStore } from "../src/store";

async function fixture(work: (fs: BrowserTargetFileSystem, reopen: () => BrowserTargetFileSystem, persistence: FilePersistence, store: InstanceStore) => Promise<void>) {
  await runInDurableObject(env.INSTANCES.getByName(crypto.randomUUID()), async (_object, ctx) => {
    const store = new InstanceStore(ctx.storage);
    const value = store.admit({ ownerUid: 1000, human: true }, { requestId: "files", templateId: "browser" }, {
      enabled: true, concurrentInstances: 1, periodSeconds: 1000, maxInstanceSeconds: 600, savedProfiles: 1, profileStorageBytes: 1024,
    });
    store.update({ ...value, state: "ready" });
    // SAFETY: These writable-path tests consult only runtime existence.
    const runtime = { exists: async () => false } as TargetFileSystem;
    const persistence = browserFilePersistence(store, value.instanceId);
    const reopen = () => new BrowserTargetFileSystem(runtime, async () => persistence, MAX_BROWSER_FILE_BYTES);
    await work(reopen(), reopen, persistence, store);
  });
}

describe("cloud browser files", () => {
  it("reopens near-quota storage using metadata and reads only the requested file", () => fixture(async (fs, reopen, persistence, store) => {
    const get = vi.spyOn(persistence, "get");
    const bytes = new Uint8Array(9 * 1024 * 1024);
    for (let i = 0; i < 5; i++) await fs.write(`/tmp/file-${i}`, bytes, "application/pdf");
    const recovered = reopen();
    expect((await recovered.list("/tmp")).files).toHaveLength(5);
    expect(await recovered.stat("/tmp/file-4")).toMatchObject({ size: bytes.byteLength, contentType: "application/pdf" });
    expect(JSON.stringify(await persistence.list()).length).toBeLessThan(2048);
    expect(get).not.toHaveBeenCalled();
    expect((await recovered.read("/tmp/file-4")).byteLength).toBe(bytes.byteLength);
    expect(get).toHaveBeenCalledExactlyOnceWith("/tmp/file-4");
    await expect(fs.write("/tmp/overflow", new Uint8Array(4 * 1024 * 1024))).rejects.toThrow("temporary storage limit");
    expect(await recovered.exists("/tmp/overflow")).toBe(false);
    await recovered.delete("/tmp/file-4");
    expect(store.sql.exec("SELECT 1 FROM file_chunks WHERE path = ?", "/tmp/file-4").toArray()).toHaveLength(0);
    store.terminal(store.activeRows()[0]!.id, false);
    expect(store.sql.exec("SELECT 1 FROM file_chunks").toArray()).toHaveLength(0);
    expect(store.sql.exec("SELECT 1 FROM files").toArray()).toHaveLength(0);
  }));

  it("reopens chunked entries without changing binary sizes or directories", () => fixture(async (fs, reopen, persistence, store) => {
    for (let size = 0; size < 6; size++) await fs.write(`/tmp/files/${size}`, new Uint8Array(size), "image/png");
    const large = new Uint8Array(1024 * 1024); large[0] = 1; large[large.length - 1] = 2;
    await fs.write("/tmp/files/large", large);
    const recovered = reopen();
    for (let size = 0; size < 6; size++) {
      expect(await recovered.stat(`/tmp/files/${size}`)).toMatchObject({ size, contentType: "image/png" });
      expect((await recovered.read(`/tmp/files/${size}`)).byteLength).toBe(size);
    }
    expect(await recovered.stat("/tmp/files")).toMatchObject({ isDirectory: true });
    const restored = await recovered.read("/tmp/files/large");
    expect(restored.byteLength).toBe(large.byteLength);
    expect([restored[0], restored[restored.length - 1]]).toEqual([1, 2]);
    expect(store.sql.exec<{ bytes: number }>("SELECT MAX(length(data)) AS bytes FROM file_chunks").one().bytes).toBe(1024 * 1024);
    expect((await persistence.list()).every(entry => !("content" in entry))).toBe(true);
  }));

  it("rejects an oversized transfer before pulling bytes", () => fixture(async fs => {
    const pull = vi.fn(), cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
    const response = await new BrowserFsDriver(fs).handle("fs.transfer.receive", { path: "/tmp/large" }, { stream, length: MAX_BROWSER_FILE_BYTES + 1 });
    expect(response.data).toMatchObject({ ok: false, error: expect.stringContaining("byte limit") });
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    expect(await fs.exists("/tmp/large")).toBe(false);
  }));

  it("does not publish a file rejected by the encoded-entry quota", () => fixture(async (fs, reopen) => {
    await expect(fs.write("/tmp/large", new Uint8Array(12 * 1024 * 1024))).rejects.toThrow("16 MiB limit");
    expect(await fs.exists("/tmp/large")).toBe(false);
    await expect(fs.read("/tmp/large")).rejects.toThrow("No such file");
    expect(await reopen().exists("/tmp/large")).toBe(false);
  }));

  it("retains committed binary contents and MIME types after reconstruction", () => fixture(async (fs, reopen) => {
    const bytes = new Uint8Array([0, 255, 128, 42]);
    await fs.write("/tmp/report", bytes, "application/pdf");
    expect(await reopen().read("/tmp/report")).toEqual(bytes);
    expect(await reopen().stat("/tmp/report")).toMatchObject({ contentType: "application/pdf", size: 4 });
  }));
});
