import { describe, expect, it, vi } from "vitest";
import { bodyToBytes, bodyToText } from "@humansandmachines/gsv/protocol";
import { BrowserFsDriver, BrowserTargetFileSystem } from "./fs";
import type { TargetFileSystem } from "./types";

describe("BrowserFsDriver", () => {
  it("does not read browser content after Pause interrupts stat", async () => {
    let finishStat!: (stat: { path: string; isFile: boolean; isDirectory: boolean; size: number }) => void;
    const pendingStat = new Promise<{ path: string; isFile: boolean; isDirectory: boolean; size: number }>((resolve) => {
      finishStat = resolve;
    });
    const stat = vi.fn(() => pendingStat);
    const read = vi.fn();
    const fs = { stat, read } as unknown as TargetFileSystem;
    const controller = new AbortController();
    const running = new BrowserFsDriver(fs).handle("fs.read", { path: "/proc/tabs/42/resources/app.js" }, undefined, controller.signal);

    await vi.waitFor(() => expect(stat).toHaveBeenCalledWith("/proc/tabs/42/resources/app.js", controller.signal));
    controller.abort(new Error("Browser access paused"));
    finishStat({ path: "/proc/tabs/42/resources/app.js", isFile: true, isDirectory: false, size: 10 });

    await expect(running).rejects.toThrow("Browser access paused");
    expect(read).not.toHaveBeenCalled();
  });

  it("does not write an edit after Pause interrupts its read", async () => {
    let finishRead!: (bytes: Uint8Array) => void;
    const pendingRead = new Promise<Uint8Array>((resolve) => { finishRead = resolve; });
    const write = vi.fn(async () => {});
    const fs = { read: vi.fn(() => pendingRead), write } as unknown as TargetFileSystem;
    const controller = new AbortController();
    const running = new BrowserFsDriver(fs).handle("fs.edit", {
      path: "/tmp/note.txt", oldString: "old", newString: "new",
    }, undefined, controller.signal);

    await vi.waitFor(() => expect(fs.read).toHaveBeenCalledWith("/tmp/note.txt", controller.signal));
    controller.abort(new Error("Browser access paused"));
    finishRead(new TextEncoder().encode("old"));

    await expect(running).rejects.toThrow("Browser access paused");
    expect(write).not.toHaveBeenCalled();
  });

  it("cancels a pending transfer body before Pause can write it", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ cancel });
    const write = vi.fn(async () => {});
    const fs = { write } as unknown as TargetFileSystem;
    const controller = new AbortController();
    const running = new BrowserFsDriver(fs).handle("fs.transfer.receive", {
      path: "/tmp/incoming.bin",
    }, { stream, length: 4 }, controller.signal);

    await vi.waitFor(() => expect(stream.locked).toBe(true));
    controller.abort(new Error("Browser access paused"));

    await expect(running).rejects.toThrow("Browser access paused");
    expect(cancel).toHaveBeenCalledOnce();
    expect(write).not.toHaveBeenCalled();
  });

  it("does not create a file after Pause interrupts a storage lookup", async () => {
    let finishExists!: (exists: boolean) => void;
    const pendingExists = new Promise<boolean>((resolve) => { finishExists = resolve; });
    const exists = vi.fn((path: string) => path === "/tmp/late.txt" ? pendingExists : Promise.resolve(false));
    const runtime = { exists, getAllPaths: async () => [] } as unknown as TargetFileSystem;
    const fs = new BrowserTargetFileSystem(runtime);
    const controller = new AbortController();
    const running = new BrowserFsDriver(fs).handle("fs.write", {
      path: "/tmp/late.txt", content: "late",
    }, undefined, controller.signal);

    await vi.waitFor(() => expect(exists).toHaveBeenCalledWith("/tmp/late.txt", controller.signal));
    controller.abort(new Error("Browser access paused"));
    finishExists(false);

    await expect(running).rejects.toThrow("Browser access paused");
    await expect(fs.exists("/tmp/late.txt")).resolves.toBe(false);
  });

  it("does not copy after Pause interrupts source acquisition", async () => {
    const runtime = { exists: async () => false, getAllPaths: async () => [] } as unknown as TargetFileSystem;
    const fs = new BrowserTargetFileSystem(runtime);
    await fs.write("/tmp/source.txt", new TextEncoder().encode("source"));
    let finishRead!: (bytes: Uint8Array) => void;
    const pendingRead = new Promise<Uint8Array>((resolve) => { finishRead = resolve; });
    vi.spyOn(fs, "read").mockImplementation(() => pendingRead);
    const controller = new AbortController();
    const running = new BrowserFsDriver(fs).handle("fs.copy", {
      source: { path: "/tmp/source.txt" }, destination: { path: "/tmp/dest.txt" },
    }, undefined, controller.signal);

    await vi.waitFor(() => expect(fs.read).toHaveBeenCalledWith("/tmp/source.txt", controller.signal));
    controller.abort(new Error("Browser access paused"));
    finishRead(new TextEncoder().encode("source"));

    await expect(running).rejects.toThrow("Browser access paused");
    await expect(fs.exists("/tmp/dest.txt")).resolves.toBe(false);
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
