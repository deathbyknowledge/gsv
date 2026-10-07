import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { BrowserFsDriver, BrowserTargetFileSystem } from "@humansandmachines/gsv-browser/fs";
import type { TargetFileSystem } from "@humansandmachines/gsv-browser/types";
import { browserFilePersistence, MAX_BROWSER_FILE_BYTES } from "../src/browser-files";
import { InstanceStore } from "../src/store";

async function fixture(work: (fs: BrowserTargetFileSystem, reopen: () => BrowserTargetFileSystem) => Promise<void>) {
  await runInDurableObject(env.INSTANCES.getByName(crypto.randomUUID()), async (_object, ctx) => {
    const store = new InstanceStore(ctx.storage);
    const value = store.admit({ ownerUid: 1000, human: true }, { requestId: "files", templateId: "browser" }, {
      enabled: true, concurrentInstances: 1, periodSeconds: 1000, maxInstanceSeconds: 600, savedProfiles: 1, profileStorageBytes: 1024,
    });
    store.update({ ...value, state: "ready" });
    // SAFETY: These writable-path tests consult only runtime existence.
    const runtime = { exists: async () => false } as TargetFileSystem;
    const reopen = () => new BrowserTargetFileSystem(runtime, async () => browserFilePersistence(store, value.instanceId), MAX_BROWSER_FILE_BYTES);
    await work(reopen(), reopen);
  });
}

describe("cloud browser files", () => {
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
