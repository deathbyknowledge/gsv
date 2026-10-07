import { describe, expect, it, vi } from "vitest";
import { RecordingStartFence } from "./recording-start-fence";

describe("offscreen recording start fence", () => {
  it("releases a stream returned after Pause even when no follow-up cleanup runs", async () => {
    const fence = new RecordingStartFence();
    const stream = deferred<{ stop(): void }>();
    const resource = { stop: vi.fn() };
    const acquire = vi.fn(() => stream.promise);
    const start = fence.acquire(fence.generation(), acquire, (value) => value.stop(), async () => false);
    await vi.waitFor(() => expect(acquire).toHaveBeenCalledOnce());

    fence.stop();
    stream.resolve(resource);

    await expect(start).rejects.toThrow("Browser access was paused");
    expect(resource.stop).toHaveBeenCalledOnce();
  });

  it("rejects a delayed start while persisted access is paused", async () => {
    const fence = new RecordingStartFence();
    fence.stop();
    const acquire = vi.fn();

    await expect(fence.acquire(fence.generation(), acquire, vi.fn(), async () => true))
      .rejects.toThrow("Browser access was paused");
    expect(acquire).not.toHaveBeenCalled();
  });

  it("rechecks the stop generation after reading the persisted state", async () => {
    const fence = new RecordingStartFence();
    const paused = deferred<boolean>();
    const acquire = vi.fn();
    const start = fence.acquire(fence.generation(), acquire, vi.fn(), () => paused.promise);

    fence.stop();
    paused.resolve(false);

    await expect(start).rejects.toThrow("Browser access was paused");
    expect(acquire).not.toHaveBeenCalled();
  });

  it("allows a fresh start after access resumes", async () => {
    const fence = new RecordingStartFence();
    fence.stop();
    const resource = { stop: vi.fn() };

    await expect(fence.acquire(fence.generation(), async () => resource, (value) => value.stop(), async () => false))
      .resolves.toBe(resource);
    expect(resource.stop).not.toHaveBeenCalled();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}
