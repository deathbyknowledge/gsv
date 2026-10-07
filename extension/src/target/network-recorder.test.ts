import { afterEach, describe, expect, it, vi } from "vitest";
import { networkStatus, startNetworkCapture, stopNetworkCapture } from "./network-recorder";
import type { TargetFileSystem } from "./types";

afterEach(async () => {
  await stopNetworkCapture();
  vi.unstubAllGlobals();
});

describe("network capture teardown", () => {
  it("discards late bodies and drains in-flight persistence before stop", async () => {
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
    let blockBodyWrite = false;
    let bodyWriteStarted!: () => void;
    const writingBody = new Promise<void>((resolve) => { bodyWriteStarted = resolve; });
    let releaseBodyWrite!: () => void;
    const bodyWritten = new Promise<void>((resolve) => { releaseBodyWrite = resolve; });
    const write = vi.fn(async (path: string, _content: Uint8Array) => {
      if (blockBodyWrite && path.includes("response-body")) {
        bodyWriteStarted();
        await bodyWritten;
      }
    });
    const append = vi.fn(async (_path: string, _content: Uint8Array) => {});
    const fs = {
      mkdir: vi.fn(async () => {}),
      write,
      append,
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

    blockBodyWrite = true;
    await startNetworkCapture({ tabId: 42, bodies: true, persist: true, bodyLimit: 1_000, fs });
    onEvent({ tabId: 42 }, "Network.requestWillBeSent", {
      requestId: "request-2",
      request: { url: "https://example.test/second", method: "GET" },
    });
    onEvent({ tabId: 42 }, "Network.loadingFinished", { requestId: "request-2" });
    await writingBody;

    const stopping = stopNetworkCapture();
    const stoppingAgain = stopNetworkCapture();
    let stopped = false;
    void stopping.then(() => { stopped = true; });
    let stoppedAgain = false;
    void stoppingAgain.then(() => { stoppedAgain = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stopped).toBe(false);
    expect(stoppedAgain).toBe(false);
    releaseBodyWrite();
    await Promise.all([stopping, stoppingAgain]);

    const writesAfterStop = write.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(write).toHaveBeenCalledWith(expect.stringContaining("response-body"), expect.any(Uint8Array));
    expect(write.mock.calls).toHaveLength(writesAfterStop);
    expect(append.mock.calls.some(([, content]) => new TextDecoder().decode(content).includes('"type":"body"'))).toBe(false);
    expect(networkStatus()).toEqual([]);
  });
});
