import type { GsvEndpointContext, GsvEndpointRequest } from "@humansandmachines/gsv/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserTargetDriver } from "./driver";

afterEach(() => vi.unstubAllGlobals());

describe("browser target activity", () => {
  it("counts overlapping requests until they finish", async () => {
    const driver = createBrowserTargetDriver();
    // SAFETY: this test only executes shell.exec, which reads these context fields.
    const context = {
      abortSignal: new AbortController().signal,
      connection: { peer: { id: "chrome" } },
    } as GsvEndpointContext;
    const request = (id: string): GsvEndpointRequest => shellRequest(id, "help");

    const first = driver.handle(request("first"), context);
    const second = driver.handle(request("second"), context);
    expect(driver.activeRequests()).toHaveLength(2);

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ data: expect.objectContaining({ status: "completed" }) }),
      expect.objectContaining({ data: expect.objectContaining({ status: "completed" }) }),
    ]);
    expect(driver.activeRequests()).toHaveLength(0);
  });

  it("clears the count when a request fails", async () => {
    const driver = createBrowserTargetDriver();
    // SAFETY: unsupported calls fail before the driver reads other context fields.
    const context = { abortSignal: new AbortController().signal } as GsvEndpointContext;
    const request: GsvEndpointRequest = {
      id: "unsupported",
      call: "unsupported",
      args: {},
      raw: { type: "req", id: "unsupported", call: "unsupported", args: {} },
    };

    await expect(driver.handle(request, context)).rejects.toThrow("Unsupported browser target syscall");
    expect(driver.activeRequests()).toHaveLength(0);
  });

  it("waits for a cancelled page command before completing pause", async () => {
    const tabRequested = deferred<void>();
    const tabResult = deferred<chrome.tabs.Tab[]>();
    const attach = vi.fn();
    vi.stubGlobal("chrome", {
      tabs: {
        query: vi.fn(() => {
          tabRequested.resolve(undefined);
          return tabResult.promise;
        }),
      },
      debugger: {
        attach,
        detach: vi.fn(),
        sendCommand: vi.fn(),
        onEvent: { addListener: vi.fn() },
        onDetach: { addListener: vi.fn() },
      },
    });
    const driver = createBrowserTargetDriver();
    // SAFETY: this test only executes shell.exec, which reads these context fields.
    const context = {
      abortSignal: new AbortController().signal,
      connection: { peer: { id: "chrome" } },
    } as GsvEndpointContext;
    const request = shellRequest("late-js", "page js 'document.title = 1'");
    const execution = driver.handle(request, context);
    await tabRequested.promise;

    const paused = driver.pause();
    let pauseFinished = false;
    void paused.then(() => { pauseFinished = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pauseFinished).toBe(false);
    expect(driver.activeRequests()).toHaveLength(0);
    await expect(driver.handle({ ...request, id: "new" }, context))
      .rejects.toThrow("Browser access is paused");

    tabResult.resolve([{
      id: 42,
      windowId: 1,
      index: 0,
      active: true,
      highlighted: true,
      pinned: false,
      frozen: false,
      incognito: false,
      selected: true,
      discarded: false,
      autoDiscardable: true,
      groupId: -1,
    }]);
    await paused;
    await expect(execution).resolves.toMatchObject({ data: { status: "failed" } });
    expect(attach).not.toHaveBeenCalled();

    driver.resume();
    await expect(driver.handle({ ...request, id: "resumed", args: { input: "help" } }, context))
      .resolves.toMatchObject({ data: { status: "completed" } });
  });

  it("detaches when debugger attachment finishes after pause starts", async () => {
    const attachStarted = deferred<void>();
    const attachFinished = deferred<void>();
    const detach = vi.fn(async () => {});
    const sendCommand = vi.fn();
    vi.stubGlobal("chrome", {
      tabs: { query: vi.fn(async () => [{ id: 42, windowId: 1, index: 0, active: true }]) },
      debugger: {
        attach: vi.fn(async () => {
          attachStarted.resolve(undefined);
          await attachFinished.promise;
        }),
        detach,
        sendCommand,
        onEvent: { addListener: vi.fn() },
        onDetach: { addListener: vi.fn() },
      },
    });
    const driver = createBrowserTargetDriver();
    // SAFETY: this test only executes shell.exec, which reads these context fields.
    const context = {
      abortSignal: new AbortController().signal,
      connection: { peer: { id: "chrome" } },
    } as GsvEndpointContext;
    const request = shellRequest("attaching-js", "page js 'document.title = 1'");
    const execution = driver.handle(request, context);
    await attachStarted.promise;

    const paused = driver.pause();
    attachFinished.resolve(undefined);
    await paused;
    await execution;
    expect(sendCommand).not.toHaveBeenCalled();
    expect(detach).toHaveBeenCalledWith({ tabId: 42 });
  });
});

function shellRequest(id: string, input: string): GsvEndpointRequest {
  const args = { input };
  return { id, call: "shell.exec", args, raw: { type: "req", id, call: "shell.exec", args } };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}
