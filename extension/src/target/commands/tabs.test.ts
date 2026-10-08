import { afterEach, describe, expect, it, vi } from "vitest";
import { releaseAllDebuggers, releaseDebugger, acquireDebugger } from "../../shared/debugger";
import { pageCommand } from "./page";
import { tabCommands } from "./tabs";
import type { CommandContext, FileStat, TargetFileSystem } from "../types";

afterEach(async () => {
  await releaseAllDebuggers();
  vi.unstubAllGlobals();
});

describe("tabs open", () => {
  it("opens a background tab by default and returns its id", async () => {
    const create = vi.fn(async ({ url, active }: chrome.tabs.CreateProperties) => tab(active ?? true, url ?? ""));
    stubChrome({ create });

    const result = await runTabs(["open", "https://example.com"]);

    expect(create).toHaveBeenCalledWith({ url: "https://example.com", active: false });
    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(result.stdout.split("\n")[0]).toBe("opened tab 42");
    expect(JSON.parse(result.stdout.split("\n")[1] ?? "{}")).toMatchObject({
      tab: { id: 42, active: false, url: "https://example.com" },
    });
  });

  it("opens a foreground tab only with --active", async () => {
    const create = vi.fn(async ({ url, active }: chrome.tabs.CreateProperties) => tab(active ?? false, url ?? ""));
    stubChrome({ create });

    const result = await runTabs(["open", "--active", "https://example.com"]);

    expect(create).toHaveBeenCalledWith({ url: "https://example.com", active: true });
    expect(result.exitCode).toBe(0);
  });

  it("passes Pause cancellation to rendered tab storage", async () => {
    stubChrome({ create: vi.fn(async ({ url }) => tab(false, url ?? "")) });
    const controller = new AbortController();
    const mkdir = vi.fn(async () => {});
    const write = vi.fn(async () => {});
    const ctx = context(write, {
      stdin: "hello",
      abortSignal: controller.signal,
      fs: { mkdir, write } as unknown as TargetFileSystem,
    });

    expect((await runTabs(["open", "-"], ctx)).exitCode).toBe(0);
    expect(mkdir).toHaveBeenCalledWith("/tmp/render", controller.signal);
    expect(write).toHaveBeenCalledWith(
      expect.stringMatching(/^\/tmp\/render\/\d{14}-[a-f0-9]{8}-stdin\.txt$/),
      new TextEncoder().encode("hello"),
      "text/plain; charset=utf-8",
      controller.signal,
    );
  });

  it("closes a tab returned by Chrome after Pause", async () => {
    let finishCreate!: (created: chrome.tabs.Tab) => void;
    const pendingCreate = new Promise<chrome.tabs.Tab>((resolve) => { finishCreate = resolve; });
    let finishClose!: () => void;
    const pendingClose = new Promise<void>((resolve) => { finishClose = resolve; });
    const chromeApi = stubChrome({ create: vi.fn(() => pendingCreate) });
    chromeApi.tabs.remove = vi.fn(() => pendingClose);
    const controller = new AbortController();

    const running = runTabs(["open", "https://example.com"], context(vi.fn(), { abortSignal: controller.signal }));
    controller.abort(new Error("Browser access paused"));
    finishCreate(tab(false, "https://example.com"));

    await vi.waitFor(() => expect(chromeApi.tabs.remove).toHaveBeenCalledWith(42));
    let settled = false;
    void Promise.resolve(running).then(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    finishClose();
    const result = await running;
    expect(result.exitCode).toBe(1);
  });

  it("passes request cancellation to remote file copies", async () => {
    const controller = new AbortController();
    const copyTargetFile = vi.fn(async () => {
      throw new Error("copy stopped");
    });
    const ctx = context(vi.fn(), {
      fs: { mkdir: vi.fn() } as unknown as TargetFileSystem,
      currentTargetId: "browser",
      abortSignal: controller.signal,
      copyTargetFile,
    });

    const result = await runTabs(["open", "machine:/report.txt"], ctx);

    expect(copyTargetFile).toHaveBeenCalledWith(
      { target: "machine", path: "/report.txt" },
      {
        target: "browser",
        path: expect.stringMatching(/^\/tmp\/render\/\d{14}-[a-f0-9]{8}-report\.txt$/),
      },
      controller.signal,
    );
    expect(result).toMatchObject({ exitCode: 1, stderr: expect.stringContaining("copy stopped") });
  });

  it("does not read or open a file after Pause interrupts stat", async () => {
    let finishStat!: (stat: FileStat) => void;
    const pendingStat = new Promise<FileStat>((resolve) => { finishStat = resolve; });
    const read = vi.fn();
    const write = vi.fn();
    const mkdir = vi.fn();
    const create = vi.fn();
    stubChrome({ create });
    const controller = new AbortController();
    const ctx = context(write, {
      abortSignal: controller.signal,
      fs: {
        resolvePath: (_cwd: string, path: string) => path,
        stat: vi.fn(() => pendingStat),
        mkdir,
        read,
        write,
      } as unknown as TargetFileSystem,
    });

    const running = runTabs(["open", "/reports/summary.txt"], ctx);
    controller.abort(new Error("Browser access paused"));
    finishStat({ path: "/reports/summary.txt", isFile: true, isDirectory: false, size: 3 });
    const result = await running;

    expect(result.exitCode).toBe(1);
    expect(mkdir).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("does not persist or open a file after Pause interrupts read", async () => {
    let finishRead!: (bytes: Uint8Array) => void;
    const pendingRead = new Promise<Uint8Array>((resolve) => { finishRead = resolve; });
    let readStarted!: () => void;
    const started = new Promise<void>((resolve) => { readStarted = resolve; });
    const write = vi.fn();
    const create = vi.fn();
    stubChrome({ create });
    const controller = new AbortController();
    const ctx = context(write, {
      abortSignal: controller.signal,
      fs: {
        resolvePath: (_cwd: string, path: string) => path,
        stat: vi.fn(async (path: string) => ({ path, isFile: true, isDirectory: false, size: 3 })),
        mkdir: vi.fn(async () => {}),
        read: vi.fn(() => { readStarted(); return pendingRead; }),
        write,
      } as unknown as TargetFileSystem,
    });

    const running = runTabs(["open", "/reports/summary.txt"], ctx);
    await started;
    expect(ctx.fs.stat).toHaveBeenCalledWith("/reports/summary.txt", controller.signal);
    expect(ctx.fs.read).toHaveBeenCalledWith("/reports/summary.txt", controller.signal);
    controller.abort(new Error("Browser access paused"));
    finishRead(new Uint8Array([1, 2, 3]));
    const result = await running;

    expect(result.exitCode).toBe(1);
    expect(write).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("does not focus a tab after Pause interrupts tab lookup", async () => {
    let finishGet!: (tab: chrome.tabs.Tab) => void;
    const pendingGet = new Promise<chrome.tabs.Tab>((resolve) => { finishGet = resolve; });
    const chromeApi = stubChrome({ get: vi.fn(() => pendingGet) });
    const controller = new AbortController();

    const running = runTabs(["focus", "42"], context(vi.fn(), { abortSignal: controller.signal }));
    controller.abort(new Error("Browser access paused"));
    finishGet(tab(false, "https://example.com"));
    const result = await running;

    expect(result.exitCode).toBe(1);
    expect(chromeApi.windows.update).not.toHaveBeenCalled();
    expect(chromeApi.tabs.update).not.toHaveBeenCalled();
  });

  it("does not activate a tab after Pause interrupts window focus", async () => {
    let finishWindow!: (window: chrome.windows.Window) => void;
    const pendingWindow = new Promise<chrome.windows.Window>((resolve) => { finishWindow = resolve; });
    let updateStarted!: () => void;
    const started = new Promise<void>((resolve) => { updateStarted = resolve; });
    const chromeApi = stubChrome({
      get: vi.fn(async () => tab(false, "https://example.com")),
      updateWindow: vi.fn(() => { updateStarted(); return pendingWindow; }),
    });
    const controller = new AbortController();

    const running = runTabs(["focus", "42"], context(vi.fn(), { abortSignal: controller.signal }));
    await started;
    controller.abort(new Error("Browser access paused"));
    finishWindow({ id: 7, focused: true, alwaysOnTop: false, incognito: false });
    const result = await running;

    expect(result.exitCode).toBe(1);
    expect(chromeApi.tabs.update).not.toHaveBeenCalled();
  });

});

describe("page screenshot", () => {
  it("captures an inactive tab without focusing it", async () => {
    const write = vi.fn();
    const controller = new AbortController();
    const chromeApi = stubChrome({
      get: vi.fn(async () => tab(false, "https://example.com")),
      sendCommand: vi.fn(async () => ({ data: "AQIDBA==" })),
    });

    const result = await pageCommand.run(["screenshot", "--tab", "42"], context(write, { abortSignal: controller.signal }));

    expect(result.exitCode).toBe(0);
    expect(chromeApi.debugger.attach).toHaveBeenCalledWith({ tabId: 42 }, "1.3");
    expect(chromeApi.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: 42 },
      "Page.captureScreenshot",
      { format: "png", fromSurface: true, captureBeyondViewport: false },
    );
    expect(chromeApi.debugger.detach).toHaveBeenCalledWith({ tabId: 42 });
    expect(chromeApi.tabs.update).not.toHaveBeenCalled();
    expect(chromeApi.windows.update).not.toHaveBeenCalled();
    expect(chromeApi.tabs.captureVisibleTab).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledWith(
      "/home/browser/screenshots/tab-42-19700101000000.png",
      new Uint8Array([1, 2, 3, 4]),
      "image/png",
      controller.signal,
    );
  });

  it("does not detach a debugger session owned by another operation", async () => {
    const chromeApi = stubChrome({
      get: vi.fn(async () => tab(false, "https://example.com")),
      sendCommand: vi.fn(async () => ({ data: "AQIDBA==" })),
    });
    await acquireDebugger(42);

    const result = await pageCommand.run(["screenshot", "--tab", "42"], context());

    expect(result.exitCode).toBe(0);
    expect(chromeApi.debugger.attach).toHaveBeenCalledTimes(1);
    expect(chromeApi.debugger.detach).not.toHaveBeenCalled();
    await releaseDebugger(42);
    expect(chromeApi.debugger.detach).toHaveBeenCalledTimes(1);
  });
});

async function runTabs(args: string[], ctx = context()) {
  const command = tabCommands[0];
  if (!command) {
    throw new Error("tabs command is unavailable");
  }
  return await command.run(args, ctx);
}

function context(write = vi.fn(), overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    cwd: "/",
    stdin: "",
    fs: { write } as unknown as TargetFileSystem,
    now: () => 0,
    ...overrides,
  };
}

function tab(active: boolean, url: string): chrome.tabs.Tab {
  return {
    id: 42,
    windowId: 7,
    index: 3,
    active,
    highlighted: active,
    pinned: false,
    discarded: false,
    frozen: false,
    incognito: false,
    selected: active,
    autoDiscardable: true,
    groupId: -1,
    url,
  };
}

function stubChrome(overrides: {
  create?: typeof chrome.tabs.create;
  get?: typeof chrome.tabs.get;
  updateWindow?: typeof chrome.windows.update;
  sendCommand?: typeof chrome.debugger.sendCommand;
}) {
  const chromeApi = {
    tabs: {
      create: overrides.create ?? vi.fn(),
      get: overrides.get ?? vi.fn(),
      remove: vi.fn(async () => {}),
      update: vi.fn(),
      captureVisibleTab: vi.fn(),
    },
    windows: { update: overrides.updateWindow ?? vi.fn() },
    runtime: { getURL: vi.fn((path: string) => `chrome-extension://test/${path}`) },
    debugger: {
      attach: vi.fn(),
      detach: vi.fn(),
      sendCommand: overrides.sendCommand ?? vi.fn(),
      onEvent: { addListener: vi.fn() },
      onDetach: { addListener: vi.fn() },
    },
  };
  vi.stubGlobal("chrome", chromeApi);
  return chromeApi;
}
