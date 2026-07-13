import { afterEach, describe, expect, it, vi } from "vitest";
import { releaseAllDebuggers, releaseDebugger, acquireDebugger } from "../../shared/debugger";
import { pageCommand } from "./page";
import { tabCommands } from "./tabs";
import type { CommandContext, TargetFileSystem } from "../types";

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

});

describe("page screenshot", () => {
  it("captures an inactive tab without focusing it", async () => {
    const write = vi.fn();
    const chromeApi = stubChrome({
      get: vi.fn(async () => tab(false, "https://example.com")),
      sendCommand: vi.fn(async () => ({ data: "AQIDBA==" })),
    });

    const result = await pageCommand.run(["screenshot", "--tab", "42"], context(write));

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

async function runTabs(args: string[]) {
  const command = tabCommands[0];
  if (!command) {
    throw new Error("tabs command is unavailable");
  }
  return await command.run(args, context());
}

function context(write = vi.fn()): CommandContext {
  return {
    cwd: "/",
    stdin: "",
    fs: { write } as unknown as TargetFileSystem,
    now: () => 0,
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
  sendCommand?: typeof chrome.debugger.sendCommand;
}) {
  const chromeApi = {
    tabs: {
      create: overrides.create ?? vi.fn(),
      get: overrides.get ?? vi.fn(),
      update: vi.fn(),
      captureVisibleTab: vi.fn(),
    },
    windows: { update: vi.fn() },
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
