import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeBrowserViewStream } from "@humansandmachines/gsv/protocol";
import { BrowserView, type CapturedBrowserFrame } from "../src/browser-view";

const frame = (value: number): CapturedBrowserFrame => ({ capturedAt: value, tabId: 1, documentId: "doc", width: 1280, height: 800, image: new Uint8Array([value]) });
afterEach(() => { vi.useRealTimers(); });
describe("browser presentation pacing", () => {
  it("replaces unsent images and sends current state before the next image", async () => {
    const closed = vi.fn(), view = new BrowserView(closed);
    const packets = decodeBrowserViewStream(view.body);
    view.frame(frame(1));
    expect((await packets.next()).value?.image).toEqual(new Uint8Array([1]));
    view.frame(frame(2));
    expect((await packets.next()).value?.image).toEqual(new Uint8Array([2]));
    view.frame(frame(3)); view.frame(frame(4));
    view.state({ kind: "state", tabs: [], activeTabId: 1 });
    expect((await packets.next()).value?.metadata.kind).toBe("state");
    const latest = (await packets.next()).value!;
    expect(latest.image).toEqual(new Uint8Array([4]));
    expect(latest.metadata).toMatchObject({ sequence: 3 });
    await packets.return();
    expect(closed).toHaveBeenCalledOnce();
    view.close(); expect(closed).toHaveBeenCalledOnce();
  });
  it.each(["frame", "state"] as const)("closes an abandoned viewer with unread %s output", async pending => {
    vi.useFakeTimers();
    const closed = vi.fn(), view = new BrowserView(closed);
    const packets = decodeBrowserViewStream(view.body);
    view.frame(frame(1)); await packets.next();
    if (pending === "frame") view.frame(frame(2));
    else view.state({ kind: "state", tabs: [], activeTabId: 1 });
    await vi.advanceTimersByTimeAsync(15001);
    view.checkConsumer();
    await expect(packets.next()).rejects.toThrow("stopped reading");
    expect(closed).toHaveBeenCalledOnce();
  });
  it("keeps a quiet viewer open while it reads state heartbeats", async () => {
    vi.useFakeTimers();
    const closed = vi.fn(), view = new BrowserView(closed);
    const packets = decodeBrowserViewStream(view.body);
    view.frame(frame(1)); await packets.next();
    for (let heartbeat = 0; heartbeat < 3; heartbeat++) {
      const reading = packets.next();
      await vi.advanceTimersByTimeAsync(10000);
      view.state({ kind: "state", tabs: [], activeTabId: 1 });
      view.checkConsumer();
      expect((await reading).value?.metadata.kind).toBe("state");
      expect(closed).not.toHaveBeenCalled();
    }
    await packets.return();
    expect(closed).toHaveBeenCalledOnce();
  });
});
