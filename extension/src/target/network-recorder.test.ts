import { afterEach, describe, expect, it, vi } from "vitest";
import { networkStatus, startNetworkCapture, stopNetworkCapture } from "./network-recorder";
import type { TargetFileSystem } from "./types";

afterEach(async () => {
  await stopNetworkCapture();
  vi.unstubAllGlobals();
});

describe("network capture teardown", () => {
  it("discards a response body returned after capture stops", async () => {
    let onEvent!: (source: chrome.debugger.DebuggerSession, method: string, params?: object) => void;
    let resolveBody!: (value: { body: string; base64Encoded: boolean }) => void;
    const body = new Promise<{ body: string; base64Encoded: boolean }>((resolve) => { resolveBody = resolve; });
    let bodyRequested!: () => void;
    const requested = new Promise<void>((resolve) => { bodyRequested = resolve; });
    vi.stubGlobal("chrome", {
      debugger: {
        attach: vi.fn(async () => {}),
        detach: vi.fn(async () => {}),
        sendCommand: vi.fn(async (_target: chrome.debugger.DebuggerSession, method: string) => {
          if (method === "Network.getResponseBody") {
            bodyRequested();
            return await body;
          }
          return {};
        }),
        onEvent: { addListener: vi.fn((listener: typeof onEvent) => { onEvent = listener; }) },
        onDetach: { addListener: vi.fn() },
      },
      tabs: { onRemoved: { addListener: vi.fn(), removeListener: vi.fn() } },
    });
    const write = vi.fn(async (_path: string, _content: Uint8Array) => {});
    const fs = {
      mkdir: vi.fn(async () => {}),
      write,
      append: vi.fn(async () => {}),
    } as unknown as TargetFileSystem;
    await startNetworkCapture({ tabId: 42, bodies: true, persist: true, bodyLimit: 1_000, fs });
    onEvent({ tabId: 42 }, "Network.requestWillBeSent", {
      requestId: "request-1",
      request: { url: "https://example.test", method: "GET" },
    });
    onEvent({ tabId: 42 }, "Network.loadingFinished", { requestId: "request-1" });
    await requested;

    await stopNetworkCapture();
    resolveBody({ body: "late body", base64Encoded: false });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(networkStatus()).toEqual([]);
    expect(write.mock.calls.some(([path]) => String(path).includes("response-body"))).toBe(false);
  });
});
