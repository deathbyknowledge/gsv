import { afterEach, describe, expect, it, vi } from "vitest";
import { pauseBrowserResources } from "../background/pause-access";
import { acquireDebugger, debuggerTabs, releaseAllDebuggers, releaseDebugger } from "./debugger";

afterEach(async () => {
  await releaseAllDebuggers();
  vi.unstubAllGlobals();
});

describe("debugger detach ownership", () => {
  it("retains a failed command detach for a later Pause retry", async () => {
    const chromeApi = stubChrome();
    chromeApi.debugger.detach.mockRejectedValueOnce(new Error("detach blocked"));
    await acquireDebugger(42);

    await expect(releaseDebugger(42)).rejects.toThrow("detach blocked");
    expect(debuggerTabs()).toEqual([42]);
    await expect(releaseAllDebuggers()).resolves.toEqual([42]);
    expect(debuggerTabs()).toEqual([]);
  });

  it("reports a failed detach during Pause and retains the session for retry", async () => {
    const chromeApi = stubChrome();
    chromeApi.debugger.detach.mockRejectedValue(new Error("detach blocked"));
    await acquireDebugger(42);

    const result = await pauseBrowserResources({
      async disconnect() {},
      async waitForCommands() {},
      revokeMediaGrant() {},
      async stopNetwork() { return []; },
      async stopRecordings() { return []; },
      releaseDebuggers: releaseAllDebuggers,
    });

    expect(result.errors).toContainEqual(expect.stringContaining("tab 42: Error: detach blocked"));
    expect(debuggerTabs()).toEqual([42]);
    chromeApi.debugger.detach.mockResolvedValue(undefined);
    await expect(releaseAllDebuggers()).resolves.toEqual([42]);
    expect(debuggerTabs()).toEqual([]);
  });

  it("shares a pending detach between command cleanup and Pause", async () => {
    const chromeApi = stubChrome();
    let finishDetach!: () => void;
    const pendingDetach = new Promise<void>((resolve) => { finishDetach = resolve; });
    chromeApi.debugger.detach.mockImplementation(() => pendingDetach);
    await acquireDebugger(42);

    const commandCleanup = releaseDebugger(42);
    const pauseCleanup = releaseAllDebuggers();
    expect(chromeApi.debugger.detach).toHaveBeenCalledOnce();
    finishDetach();

    await expect(commandCleanup).resolves.toBeUndefined();
    await expect(pauseCleanup).resolves.toEqual([42]);
    expect(debuggerTabs()).toEqual([]);
  });
});

function stubChrome() {
  const chromeApi = {
    debugger: {
      attach: vi.fn(async () => {}),
      detach: vi.fn(async () => {}),
      onEvent: { addListener: vi.fn() },
      onDetach: { addListener: vi.fn() },
    },
  };
  vi.stubGlobal("chrome", chromeApi);
  return chromeApi;
}
