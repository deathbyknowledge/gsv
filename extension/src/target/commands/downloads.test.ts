import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandContext, TargetFileSystem } from "../types";
import { downloadsCommand } from "./downloads";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("downloads start cancellation", () => {
  it("waits for cancellation when Chrome returns a download after Pause", async () => {
    let finishDownload!: (id: number) => void;
    const pendingDownload = new Promise<number>((resolve) => { finishDownload = resolve; });
    let finishCancel!: () => void;
    const pendingCancel = new Promise<void>((resolve) => { finishCancel = resolve; });
    const download = vi.fn(() => pendingDownload);
    const search = vi.fn();
    const cancel = vi.fn(() => pendingCancel);
    vi.stubGlobal("chrome", { downloads: { download, search, cancel } });
    const controller = new AbortController();

    const running = downloadsCommand.run(["start", "https://example.com/file.zip"], context(controller.signal));
    controller.abort(new Error("Browser access paused"));
    finishDownload(37);
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledWith(37));
    let settled = false;
    void Promise.resolve(running).then(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    finishCancel();
    const result = await running;
    expect(result).toMatchObject({ exitCode: 1, stderr: expect.stringContaining("Browser access paused") });
    expect(search).not.toHaveBeenCalled();
  });

  it("cancels a started download when Pause interrupts its status lookup", async () => {
    let finishSearch!: (items: chrome.downloads.DownloadItem[]) => void;
    const pendingSearch = new Promise<chrome.downloads.DownloadItem[]>((resolve) => { finishSearch = resolve; });
    const cancel = vi.fn(async () => {});
    vi.stubGlobal("chrome", {
      downloads: {
        download: vi.fn(async () => 37),
        search: vi.fn(() => pendingSearch),
        cancel,
      },
    });
    const controller = new AbortController();

    const running = downloadsCommand.run(["start", "https://example.com/file.zip"], context(controller.signal));
    await vi.waitFor(() => expect(chrome.downloads.search).toHaveBeenCalledWith({ id: 37 }));
    controller.abort(new Error("Browser access paused"));
    finishSearch([]);

    expect((await running).exitCode).toBe(1);
    expect(cancel).toHaveBeenCalledWith(37);
  });

  it("reports a failed cancellation with the download id", async () => {
    const cancel = vi.fn(async () => { throw new Error("cancel blocked"); });
    vi.stubGlobal("chrome", {
      downloads: {
        download: vi.fn(async () => 37),
        search: vi.fn(),
        cancel,
      },
    });
    const controller = new AbortController();
    const running = downloadsCommand.run(["start", "https://example.com/file.zip"], context(controller.signal));
    controller.abort(new Error("Browser access paused"));

    const result = await running;
    expect(result).toMatchObject({ exitCode: 1, stderr: expect.stringContaining("Could not cancel download 37") });
    expect(result.stderr).toContain("cancel blocked");
  });
});

function context(signal: AbortSignal): CommandContext {
  return {
    cwd: "/",
    stdin: "",
    // SAFETY: download commands do not access the browser target filesystem.
    fs: {} as TargetFileSystem,
    now: () => 0,
    abortSignal: signal,
  };
}
