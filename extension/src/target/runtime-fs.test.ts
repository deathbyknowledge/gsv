import { afterEach, describe, expect, it, vi } from "vitest";
import { releaseAllDebuggers } from "../shared/debugger";
import { RuntimeFileSystem } from "./runtime-fs";
import { TabResourceStore } from "./tab-resources";

afterEach(async () => {
  await releaseAllDebuggers();
  vi.unstubAllGlobals();
});

describe("browser tab resources", () => {
  it("lists metadata without reading bodies and fetches one body lazily", async () => {
    const browser = installChrome();
    const fs = new RuntimeFileSystem(new TabResourceStore(() => 0));

    await expect(fs.list("/proc/tabs/7")).resolves.toEqual({
      directories: ["resources"],
      files: ["meta.json", "text.txt"],
    });
    expect(browser.sendCommand).not.toHaveBeenCalled();

    await expect(fs.list("/proc/tabs/7/resources")).resolves.toEqual({
      directories: ["https"],
      files: ["index.json"],
    });
    expect(methodCalls(browser.sendCommand, "Page.getResourceTree")).toHaveLength(1);
    expect(methodCalls(browser.sendCommand, "Page.getResourceContent")).toHaveLength(0);

    const manifest = JSON.parse(new TextDecoder().decode(
      await fs.read("/proc/tabs/7/resources/index.json"),
    )) as ResourceManifest;
    const scripts = manifest.resources.filter((resource) => resource.url.includes("app.js"));
    expect(scripts.map((resource) => resource.url)).toEqual([
      "https://cdn.example.com/assets/app.js?v=1",
      "https://cdn.example.com/assets/app.js?v=2",
    ]);
    expect(new Set(scripts.map((resource) => resource.path)).size).toBe(2);
    const script = scripts[0];
    expect(script).toBeDefined();

    const path = `/proc/tabs/7/resources/${script!.path}`;
    await expect(fs.stat(path)).resolves.toMatchObject({
      isFile: true,
      size: 18,
      contentType: "application/javascript",
    });
    expect(methodCalls(browser.sendCommand, "Page.getResourceContent")).toHaveLength(0);

    await expect(fs.read(path)).resolves.toEqual(new TextEncoder().encode("const loaded = 1;"));
    expect(methodCalls(browser.sendCommand, "Page.getResourceContent")).toHaveLength(1);
    expect(methodCalls(browser.sendCommand, "Page.getResourceTree")).toHaveLength(1);
  });

  it("decodes binary resource bodies returned as base64", async () => {
    const browser = installChrome();
    const fs = new RuntimeFileSystem(new TabResourceStore(() => 0));
    const manifest = JSON.parse(new TextDecoder().decode(
      await fs.read("/proc/tabs/7/resources/index.json"),
    )) as ResourceManifest;
    const image = manifest.resources.find((resource) => resource.url.includes("logo.png"));

    await expect(fs.read(`/proc/tabs/7/resources/${image!.path}`)).resolves.toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect(methodCalls(browser.sendCommand, "Page.getResourceContent")).toHaveLength(1);
  });

  it("searches text resources through CDP without downloading their bodies", async () => {
    const browser = installChrome();
    const fs = new RuntimeFileSystem(new TabResourceStore(() => 0));

    const matches = await fs.search(
      "/proc/tabs/7/resources",
      "loaded",
      "*.js",
    );

    expect(matches).toEqual([{
      path: expect.stringMatching(/^\/proc\/tabs\/7\/resources\/https\/cdn\.example\.com\/app~[a-f0-9]{8}\.js$/),
      line: 1,
      content: "const loaded = 1;",
    }]);
    expect(methodCalls(browser.sendCommand, "Page.searchInResource")).toHaveLength(2);
    expect(methodCalls(browser.sendCommand, "Page.getResourceContent")).toHaveLength(0);
  });
});

type ResourceManifest = {
  resources: Array<{
    path: string;
    url: string;
  }>;
};

type DebuggerSendCommand = ReturnType<typeof vi.fn>;

function installChrome(): { sendCommand: DebuggerSendCommand } {
  const sendCommand = vi.fn(async (
    _target: chrome.debugger.DebuggerSession,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<object | undefined> => {
    if (method === "Page.getResourceTree") {
      return {
        frameTree: {
          frame: {
            id: "frame-1",
            loaderId: "loader-1",
            url: "https://example.com/",
            mimeType: "text/html",
          },
          resources: [
            {
              url: "https://cdn.example.com/assets/app.js?v=1",
              type: "Script",
              mimeType: "application/javascript",
              contentSize: 18,
            },
            {
              url: "https://cdn.example.com/assets/app.js?v=2",
              type: "Script",
              mimeType: "application/javascript",
              contentSize: 18,
            },
            {
              url: "https://cdn.example.com/assets/logo.png",
              type: "Image",
              mimeType: "image/png",
              contentSize: 3,
            },
          ],
        },
      };
    }
    if (method === "Page.getResourceContent") {
      const url = String(params?.url ?? "");
      return url.includes("logo.png")
        ? { content: "AQID", base64Encoded: true }
        : { content: "const loaded = 1;", base64Encoded: false };
    }
    if (method === "Page.searchInResource") {
      return String(params?.url ?? "").endsWith("app.js?v=1")
        ? { result: [{ lineNumber: 0, lineContent: "const loaded = 1;" }] }
        : { result: [] };
    }
    return undefined;
  });

  vi.stubGlobal("chrome", {
    tabs: {
      get: async (tabId: number) => ({
        id: tabId,
        windowId: 1,
        index: 0,
        active: true,
        highlighted: true,
        pinned: false,
        title: "Example",
        url: "https://example.com/",
      }),
    },
    debugger: {
      attach: vi.fn(async () => {}),
      detach: vi.fn(async () => {}),
      sendCommand,
      onEvent: { addListener: vi.fn() },
      onDetach: { addListener: vi.fn() },
    },
  });
  return { sendCommand };
}

function methodCalls(sendCommand: DebuggerSendCommand, method: string): unknown[][] {
  return sendCommand.mock.calls.filter((call) => call[1] === method);
}
