import { afterEach, describe, expect, it, vi } from "vitest";
import { releaseAllDebuggers } from "../shared/debugger";
import { pageCommand } from "./commands/page";
import type { CommandContext, TargetFileSystem } from "./types";

afterEach(async () => {
  await releaseAllDebuggers();
  vi.unstubAllGlobals();
});

describe("page command cancellation", () => {
  it("does not start page work after tab resolution finishes during Pause", async () => {
    let resolveTab!: (tab: object) => void;
    const tab = new Promise<object>((resolve) => { resolveTab = resolve; });
    const getTab = vi.fn(() => tab);
    const executeScript = vi.fn();
    const attach = vi.fn();
    vi.stubGlobal("chrome", {
      tabs: { get: getTab },
      scripting: { executeScript },
      debugger: { attach },
    });
    const write = vi.fn(async () => {});
    const controller = new AbortController();
    const ctx = context(controller.signal, write);
    const commands = [
      ["text", "--tab", "42"],
      ["snapshot", "--tab", "42", "--dom"],
      ["snapshot", "--tab", "42"],
      ["screenshot", "--tab", "42"],
      ["click", "--tab", "42", "button"],
      ["type", "--tab", "42", "input", "hello"],
      ["key", "--tab", "42", "Enter"],
      ["scroll", "--tab", "42", "down"],
      ["wait", "--tab", "42", "#ready"],
      ["js", "--tab", "42", "document.title"],
    ];
    const running = commands.map((args) => pageCommand.run(args, ctx));
    expect(getTab).toHaveBeenCalledTimes(commands.length);

    controller.abort(new Error("Browser access paused"));
    resolveTab({ id: 42, windowId: 1, index: 0, active: true, highlighted: true, pinned: false });
    const results = await Promise.all(running);

    expect(results.every((result) => result.exitCode !== 0)).toBe(true);
    expect(executeScript).not.toHaveBeenCalled();
    expect(attach).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("does not persist a screenshot returned after Pause", async () => {
    let finishCapture!: (result: { data: string }) => void;
    const capture = new Promise<{ data: string }>((resolve) => { finishCapture = resolve; });
    let captureStarted!: () => void;
    const started = new Promise<void>((resolve) => { captureStarted = resolve; });
    const detach = vi.fn(async () => {});
    vi.stubGlobal("chrome", {
      tabs: { get: vi.fn(async () => ({ id: 42, windowId: 1, index: 0, active: true, highlighted: true, pinned: false })) },
      debugger: {
        attach: vi.fn(async () => {}),
        detach,
        sendCommand: vi.fn((_target: object, method: string) => {
          if (method === "Page.captureScreenshot") {
            captureStarted();
            return capture;
          }
          return Promise.resolve({});
        }),
        onEvent: { addListener: vi.fn() },
        onDetach: { addListener: vi.fn() },
      },
    });
    const write = vi.fn(async () => {});
    const controller = new AbortController();
    const running = pageCommand.run(["screenshot", "--tab", "42"], context(controller.signal, write));
    await started;

    controller.abort(new Error("Browser access paused"));
    finishCapture({ data: "aGVsbG8=" });
    const result = await running;

    expect(result.exitCode).not.toBe(0);
    expect(write).not.toHaveBeenCalled();
    expect(detach).toHaveBeenCalledWith({ tabId: 42 });
  });

  it("keeps a pending page wait injection owned until Chrome returns", async () => {
    let finishInjection!: (result: object[]) => void;
    const injection = new Promise<object[]>((resolve) => { finishInjection = resolve; });
    let injectionStarted!: () => void;
    const started = new Promise<void>((resolve) => { injectionStarted = resolve; });
    vi.stubGlobal("chrome", {
      tabs: { get: vi.fn(async () => ({ id: 42, windowId: 1, index: 0, active: true, highlighted: true, pinned: false })) },
      scripting: { executeScript: vi.fn(() => { injectionStarted(); return injection; }) },
    });
    const controller = new AbortController();
    const running = pageCommand.run(["wait", "--tab", "42", "#ready"], context(controller.signal));
    await started;

    controller.abort(new Error("Browser access paused"));
    let settled = false;
    void Promise.resolve(running).then(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    finishInjection([{ result: { ok: true, value: null } }]);
    expect((await running).exitCode).not.toBe(0);
  });
});

function context(signal: AbortSignal, write = vi.fn(async () => {})): CommandContext {
  const fs: TargetFileSystem = {
    read: async () => new Uint8Array(),
    write,
    append: async () => {},
    delete: async () => {},
    mkdir: async () => {},
    copy: async () => "",
    move: async () => {},
    list: async () => ({ files: [], directories: [] }),
    stat: async (path) => ({ path, isFile: false, isDirectory: true, size: 0 }),
    exists: async () => false,
    search: async () => [],
    resolvePath: (_cwd, path) => path,
    getAllPaths: async () => [],
  };
  return { cwd: "/", stdin: "", fs, now: () => 0, abortSignal: signal };
}
