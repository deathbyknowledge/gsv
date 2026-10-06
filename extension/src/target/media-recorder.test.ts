import { afterEach, describe, expect, it, vi } from "vitest";
import { pauseBrowserResources } from "../background/pause-access";
import {
  clearMediaCaptureGrant,
  grantMediaCapture,
  mediaCaptureGrantStatus,
  startMediaRecording,
} from "./media-recorder";
import type { MediaRecordingStatus, OffscreenMediaMessage, OffscreenMediaResponse } from "./media-recorder-protocol";
import type { TargetFileSystem } from "./types";

afterEach(() => {
  clearMediaCaptureGrant();
  vi.unstubAllGlobals();
});

describe("tab media recording ownership", () => {
  it("stops only the recording created by an aborted start", async () => {
    const startResponse = deferred<OffscreenMediaResponse<MediaRecordingStatus>>();
    const active = new Set(["previous-recording"]);
    const sendMessage = vi.fn(async (message: OffscreenMediaMessage) => {
      if (message.type === "start") {
        active.add(message.recordingId);
        return await startResponse.promise;
      }
      if (message.type === "stop") {
        if (message.recordingId) active.delete(message.recordingId);
        else active.clear();
        return { ok: true as const, value: [] };
      }
      throw new Error(`Unexpected offscreen message: ${message.type}`);
    });
    stubChrome({ sendMessage });
    const controller = new AbortController();
    const fs = { stat: vi.fn().mockRejectedValue(new Error("missing")) } as unknown as TargetFileSystem;

    const start = startMediaRecording({
      tabId: 42,
      cwd: "/",
      fs,
      mode: "video",
      maxDurationMs: 10_000,
      maxBytes: 1_000_000,
      monitor: false,
      abortSignal: controller.signal,
    });
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "start" })));
    const startMessage = sendMessage.mock.calls[0]?.[0];
    if (!startMessage || startMessage.type !== "start") throw new Error("Missing recording start");

    controller.abort(new Error("start cancelled"));
    startResponse.resolve({
      ok: true,
      value: {
        id: startMessage.recordingId,
        tabId: startMessage.tabId,
        active: true,
        mode: startMessage.mode,
        path: startMessage.path,
        localPath: startMessage.path,
        requestedPath: startMessage.requestedPath,
        startedAt: startMessage.startedAt,
      },
    });

    await expect(start).rejects.toThrow("start cancelled");
    expect(sendMessage.mock.calls.map(([message]) => message).filter((message) => message.type === "stop"))
      .toEqual([{ target: startMessage.target, type: "stop", recordingId: startMessage.recordingId }]);
    expect(active).toEqual(new Set(["previous-recording"]));
  });

  it("discards an allowance that finishes after browser access is paused", async () => {
    const streamId = deferred<string>();
    const getMediaStreamId = vi.fn()
      .mockImplementationOnce(() => streamId.promise)
      .mockResolvedValueOnce("fresh-stream");
    stubChrome({ getMediaStreamId });

    const pendingGrant = grantMediaCapture(42);
    await pauseBrowserResources({
      async disconnect() {},
      async waitForCommands() {},
      revokeMediaGrant: clearMediaCaptureGrant,
      async stopNetwork() { return []; },
      async stopRecordings() { return []; },
      async releaseDebuggers() { return []; },
    });
    streamId.resolve("stale-stream");

    await expect(pendingGrant).rejects.toThrow("Browser access was paused");
    expect(mediaCaptureGrantStatus()).toBeNull();
    await expect(grantMediaCapture(42)).resolves.toMatchObject({ tabId: 42 });
  });
});

function stubChrome(options: {
  sendMessage?: (message: OffscreenMediaMessage) => Promise<unknown>;
  getMediaStreamId?: () => Promise<string>;
}): void {
  vi.stubGlobal("chrome", {
    tabs: { get: vi.fn(async () => ({ id: 42, windowId: 1, index: 0, active: true, highlighted: true, pinned: false })) },
    offscreen: { hasDocument: vi.fn(async () => true) },
    tabCapture: { getMediaStreamId: options.getMediaStreamId ?? vi.fn(async () => "stream") },
    runtime: { sendMessage: options.sendMessage ?? vi.fn() },
  });
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}
