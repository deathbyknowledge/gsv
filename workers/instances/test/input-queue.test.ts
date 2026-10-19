import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserInputQueue } from "../src/input-queue";

afterEach(() => vi.useRealTimers());

describe("shared browser input", () => {
  it("finishes an admitted action, lets human input run together, then resumes Ship", async () => {
    vi.useFakeTimers();
    const queue = new BrowserInputQueue(), events: string[] = [];
    let release!: () => void;
    const click = queue.run(async () => { events.push("mouse down"); await new Promise<void>(resolve => { release = resolve; }); events.push("mouse up"); });
    const agent = queue.run(async () => { events.push("agent types"); });
    const human = queue.run(async () => { events.push("human types"); }, undefined, "human");
    expect(events).toEqual(["mouse down"]);
    release(); await click; await human;
    expect(events).toEqual(["mouse down", "mouse up", "human types"]);
    await vi.advanceTimersByTimeAsync(1001); await agent;
    expect(events.at(-1)).toBe("agent types");
  });
  it("cancels queued input before it runs and recovers after a failed action", async () => {
    const queue = new BrowserInputQueue(), controller = new AbortController();
    let release!: () => void;
    const first = queue.run(() => new Promise<void>(resolve => { release = resolve; }));
    const effect = vi.fn(async () => {});
    const cancelled = queue.run(effect, controller.signal);
    const rejected = expect(cancelled).rejects.toThrow("stopped");
    controller.abort(new Error("stopped")); await rejected;
    release(); await first;
    await expect(queue.run(async () => { throw new Error("failed click"); })).rejects.toThrow("failed click");
    await queue.run(effect);
    expect(effect).toHaveBeenCalledTimes(1);
  });
});
