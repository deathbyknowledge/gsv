import { describe, expect, it, vi } from "vitest";
import { bodyToBytes, bodyToText } from "@humansandmachines/gsv/protocol";
import { BrowserFsDriver, BrowserTargetFileSystem } from "./fs";
import { createRuntimeFileSystem } from "./runtime-fs";
import type { TargetFileSystem } from "./types";
import { BrowserTargetFileSystem as SharedBrowserFileSystem } from "@humansandmachines/gsv-browser/fs";
import type { FilePersistence, StoredFsEntry } from "@humansandmachines/gsv-browser/fs-persistence";

function persistedFileSystem() {
  const entries = new Map<string, StoredFsEntry>();
  const persistence: FilePersistence = {
    list: async () => [...entries.values()],
    get: async path => entries.get(path) ?? null,
    put: vi.fn(async entry => { entries.set(entry.path, entry); }),
    delete: vi.fn(async paths => { for (const path of paths) entries.delete(path); }),
  };
  const fs = new SharedBrowserFileSystem(createRuntimeFileSystem(), async () => persistence, 8);
  return { fs, persistence, entries };
}

describe("browser file admission and persistence", () => {
  it.each([undefined, -1, 1.5, Number.POSITIVE_INFINITY, Number.NaN, 9])(
    "rejects invalid or oversized declared length %s without reading the body", async length => {
      const { fs } = persistedFileSystem();
      const pull = vi.fn(), cancel = vi.fn();
      const stream = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
      const result = await new BrowserFsDriver(fs).handle("fs.transfer.receive", { path: "/tmp/input" }, { stream, length });
      expect(result.data).toMatchObject({ ok: false });
      expect(pull).not.toHaveBeenCalled();
      expect(cancel).toHaveBeenCalledOnce();
      expect(await fs.exists("/tmp/input")).toBe(false);
    },
  );

  it("cancels an overlong stream and leaves the destination unchanged", async () => {
    const { fs } = persistedFileSystem();
    await fs.write("/tmp/input", new Uint8Array([7]));
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(9)); }, cancel,
    });
    const result = await new BrowserFsDriver(fs).handle("fs.transfer.receive", { path: "/tmp/input" }, { stream, length: 8 });
    expect(result.data).toMatchObject({ ok: false, error: expect.stringContaining("size mismatch") });
    expect(cancel).toHaveBeenCalledOnce();
    expect(await fs.read("/tmp/input")).toEqual(new Uint8Array([7]));
  });

  it("accepts a chunked transfer exactly at the file bound and rejects a short body", async () => {
    const { fs } = persistedFileSystem();
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(bytes.subarray(0, 3)); controller.enqueue(bytes.subarray(3)); controller.close();
    } });
    const driver = new BrowserFsDriver(fs);
    expect((await driver.handle("fs.transfer.receive", { path: "/tmp/input" }, { stream, length: 8 })).data).toMatchObject({ ok: true, bytesWritten: 8 });
    expect(await fs.read("/tmp/input")).toEqual(bytes);
    const short = new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } });
    expect((await driver.handle("fs.transfer.receive", { path: "/tmp/input" }, { stream: short, length: 8 })).data).toMatchObject({ ok: false });
    expect(await fs.read("/tmp/input")).toEqual(bytes);
    await expect(fs.append("/tmp/input", new Uint8Array([9]))).rejects.toThrow("byte limit");
    expect(await fs.read("/tmp/input")).toEqual(bytes);
  });

  it.each([false, true])("keeps committed state after a rejected write (existing: %s)", async existing => {
    const { fs, persistence } = persistedFileSystem();
    if (existing) await fs.write("/tmp/input", new Uint8Array([1]), "image/png");
    vi.mocked(persistence.put).mockRejectedValueOnce(new Error("Storage quota exceeded"));
    await expect(fs.write("/tmp/input", new Uint8Array([2]), "text/plain")).rejects.toThrow("quota");
    expect(await fs.exists("/tmp/input")).toBe(existing);
    if (existing) {
      expect(await fs.read("/tmp/input")).toEqual(new Uint8Array([1]));
      expect(await fs.stat("/tmp/input")).toMatchObject({ contentType: "image/png", size: 1 });
    } else {
      await expect(fs.read("/tmp/input")).rejects.toThrow("No such file");
    }
  });

  it("publishes a new file only after its write commits", async () => {
    const { fs, persistence, entries } = persistedFileSystem();
    let commit = () => {};
    vi.mocked(persistence.put).mockImplementationOnce(entry => new Promise<void>(resolve => {
      commit = () => { entries.set(entry.path, entry); resolve(); };
    }));
    const pending = fs.write("/tmp/input", new Uint8Array([1]));
    await vi.waitFor(() => expect(persistence.put).toHaveBeenCalledOnce());
    expect(await fs.exists("/tmp/input")).toBe(false);
    commit();
    await pending;
    expect(await fs.read("/tmp/input")).toEqual(new Uint8Array([1]));
  });

  it("does not retain directories whose persistence failed", async () => {
    const { fs, persistence } = persistedFileSystem();
    vi.mocked(persistence.put).mockRejectedValueOnce(new Error("Storage quota exceeded"));
    await expect(fs.write("/tmp/new/input", new Uint8Array([1]))).rejects.toThrow("quota");
    expect(await fs.exists("/tmp/new")).toBe(false);
    expect(await fs.exists("/tmp/new/input")).toBe(false);
  });
});

describe("BrowserFsDriver", () => {
  it("rejects malformed writes before changing files and normalizes valid paths", async () => {
    const fs = new BrowserTargetFileSystem(createRuntimeFileSystem());
    const write = vi.spyOn(fs, "write");
    const driver = new BrowserFsDriver(fs);

    await expect(driver.handle("fs.write", { path: "/tmp/note.txt", content: 42 })).rejects.toThrow();
    await expect(driver.handle("fs.write", { path: "  ", content: "hello" })).rejects.toThrow();
    await expect(driver.handle("fs.copy", { source: { path: "/tmp/note.txt" }, destination: {} })).rejects.toThrow();
    expect(write).not.toHaveBeenCalled();

    await expect(driver.handle("fs.write", { path: "/tmp/../tmp/note.txt", content: "hello" })).resolves.toMatchObject({
      data: { ok: true, path: "/tmp/note.txt", size: 5 },
    });
    expect(new TextDecoder().decode(await fs.read("/tmp/note.txt"))).toBe("hello");
  });

  it("uses the stored MIME type when reading an extensionless file", async () => {
    const runtime = {
      exists: async () => false,
      getAllPaths: async () => [],
    } as unknown as TargetFileSystem;
    const fs = new BrowserTargetFileSystem(runtime);
    const bytes = new Uint8Array([1, 2, 3]);
    await fs.write("/tmp/capture", bytes, "image/png");

    const response = await new BrowserFsDriver(fs).handle("fs.read", {
      path: "/tmp/capture",
    });

    expect(response.data).toEqual({
      ok: true,
      path: "/tmp/capture",
      size: bytes.byteLength,
      kind: "image",
      contentType: "image/png",
    });
    expect(response.body).toBeDefined();
    expect(await bodyToBytes(response.body!)).toEqual(bytes);
  });

  it("references any file without its content", async () => {
    const runtime = {
      exists: async () => false,
      getAllPaths: async () => [],
    } as unknown as TargetFileSystem;
    const fs = new BrowserTargetFileSystem(runtime);
    const pdf = new TextEncoder().encode("%PDF-1.4\n1 0 obj\n");
    await fs.write("/tmp/report.pdf", pdf, "application/pdf");
    await fs.write("/tmp/notes.md", new TextEncoder().encode("hello\n"), "text/markdown");
    const driver = new BrowserFsDriver(fs, async () => "chrome-desk");

    const document = await driver.handle("fs.read", { path: "/tmp/report.pdf", representation: "reference" });
    expect(document.body).toBeUndefined();
    expect(document.data).toMatchObject({
      ok: true,
      kind: "file",
      contentType: "application/pdf",
      resource: {
        type: "file",
        target: "chrome-desk",
        path: "/tmp/report.pdf",
        contentType: "application/pdf",
        size: pdf.byteLength,
        revision: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      },
    });

    const note = await driver.handle("fs.read", { path: "/tmp/notes.md", representation: "reference" });
    expect(note.body).toBeUndefined();
    expect(note.data).toMatchObject({ ok: true, kind: "text", resource: { target: "chrome-desk", size: 6 } });
    const read = await driver.handle("fs.read", { path: "/tmp/notes.md" });
    expect(read.body && await bodyToText(read.body)).toBe("hello\n");
  });

  it("sends a file with its content revision and refuses a stale one", async () => {
    const runtime = {
      exists: async () => false,
      getAllPaths: async () => [],
    } as unknown as TargetFileSystem;
    const fs = new BrowserTargetFileSystem(runtime);
    await fs.write("/tmp/report.pdf", new TextEncoder().encode("%PDF-1.4\n"), "application/pdf");
    const driver = new BrowserFsDriver(fs);

    const stat = await driver.handle("fs.transfer.stat", { path: "/tmp/report.pdf" });
    const sent = await driver.handle("fs.transfer.send", { path: "/tmp/report.pdf" });
    expect(sent.data).toMatchObject({ ok: true, revision: expect.stringMatching(/^sha256:/) });
    expect(stat.data).toMatchObject({ ok: true, revision: (sent.data as { revision: string }).revision });
    const stale = await driver.handle("fs.transfer.send", { path: "/tmp/report.pdf", revision: "sha256:stale" });
    expect(stale.data).toMatchObject({ ok: false, error: "Source revision is no longer available: /tmp/report.pdf" });
  });

  it("reads SVG images as text", async () => {
    const runtime = {
      exists: async () => false,
      getAllPaths: async () => [],
    } as unknown as TargetFileSystem;
    const fs = new BrowserTargetFileSystem(runtime);
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>hello</text></svg>';
    await fs.write("/tmp/vector", new TextEncoder().encode(svg), "image/svg+xml");

    const response = await new BrowserFsDriver(fs).handle("fs.read", {
      path: "/tmp/vector",
    });

    expect(response.data).toMatchObject({
      ok: true,
      kind: "text",
      contentType: "image/svg+xml",
    });
    expect(response.body).toBeDefined();
    expect(await bodyToText(response.body!)).toBe(svg);
  });

  it("returns selected text without line numbers", async () => {
    const runtime = {
      exists: async () => false,
      getAllPaths: async () => [],
    } as unknown as TargetFileSystem;
    const fs = new BrowserTargetFileSystem(runtime);
    await fs.write("/tmp/lines.txt", new TextEncoder().encode("one\ntwo\nthree"), "text/plain");

    const response = await new BrowserFsDriver(fs).handle("fs.read", {
      path: "/tmp/lines.txt",
      offset: 1,
      limit: 1,
    });

    expect(response.data).toMatchObject({
      ok: true,
      kind: "text",
      lines: 1,
    });
    expect(response.body).toBeDefined();
    expect(await bodyToText(response.body!)).toBe("two");
  });

  it("rejects invalid UTF-8 in text-classified files", async () => {
    const runtime = {
      exists: async () => false,
      getAllPaths: async () => [],
    } as unknown as TargetFileSystem;
    const fs = new BrowserTargetFileSystem(runtime);
    await fs.write("/tmp/bad", new Uint8Array([0xff]), "text/plain");

    const response = await new BrowserFsDriver(fs).handle("fs.read", { path: "/tmp/bad" });

    expect(response.data).toMatchObject({ ok: false, error: expect.stringContaining("Binary file") });
    expect(response.body).toBeUndefined();
  });

  it("delegates searches under runtime mounts to the runtime filesystem", async () => {
    const search = vi.fn(async () => [{
      path: "/proc/tabs/7/resources/https/example.com/app.js",
      line: 1,
      content: "needle",
    }]);
    const runtime = {
      search,
      exists: async () => true,
      getAllPaths: async () => {
        throw new Error("runtime paths should not be materialized");
      },
    } as unknown as TargetFileSystem;
    const fs = new BrowserTargetFileSystem(runtime);

    await expect(fs.search("/proc/tabs/7/resources", "needle", "*.js")).resolves.toEqual([{
      path: "/proc/tabs/7/resources/https/example.com/app.js",
      line: 1,
      content: "needle",
    }]);
    expect(search).toHaveBeenCalledWith("/proc/tabs/7/resources", "needle", "*.js", undefined);
  });

  it.each(["stat", "list", "read"] as const)(
    "returns %s failures as filesystem operation errors",
    async (operation) => {
      const error = new Error(`${operation} failed`);
      const fs = {
        stat: async () => {
          if (operation === "stat") throw error;
          return {
            path: "/tmp/file",
            isFile: operation === "read",
            isDirectory: operation === "list",
            size: 1,
            contentType: "text/plain",
          };
        },
        list: async () => {
          throw error;
        },
        read: async () => {
          throw error;
        },
      } as unknown as TargetFileSystem;

      const response = await new BrowserFsDriver(fs).handle("fs.read", { path: "/tmp/file" });

      expect(response.data).toEqual({ ok: false, error: `${operation} failed` });
      expect(response.body).toBeUndefined();
    },
  );
});
