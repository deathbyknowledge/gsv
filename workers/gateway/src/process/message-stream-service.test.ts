import { describe, expect, it, vi } from "vitest";
import { ProcessMessageStreamService } from "./message-stream-service";
import type { Process } from "./do";

type Emitted = { phase: string; id: string; delta?: string; reason?: string };
type StreamFixture = { streams: ProcessMessageStreamService; emitted: Emitted[] };

function service(): StreamFixture {
  // SAFETY: test fixture is constructed with the asserted domain shape.
  const streams = new ProcessMessageStreamService({} as Process);
  const emitted: Emitted[] = [];
  vi.spyOn(streams, "emitProjection").mockImplementation(async (_runId, projection, phase, delta, reason) => {
    const entry: Emitted = { phase, id: projection.id };
    if (delta !== undefined) entry.delta = delta;
    if (reason !== undefined) entry.reason = reason;
    emitted.push(entry);
  });
  return { streams, emitted };
}

describe("ProcessMessageStreamService", () => {
  it("starts on the first character and sends each new suffix", async () => {
    const { streams, emitted } = service();
    await streams.append("run", "call", "");
    expect(emitted).toEqual([]);
    await streams.append("run", "call", "Hel");
    await streams.append("run", "call", "Hello");
    await streams.append("run", "call", "Hello, world");
    expect(emitted).toEqual([
      { phase: "started", id: "draft:run:call" },
      { phase: "delta", id: "draft:run:call", delta: "Hel" },
      { phase: "delta", id: "draft:run:call", delta: "lo" },
      { phase: "delta", id: "draft:run:call", delta: ", world" },
    ]);
  });

  it("ignores appends that do not extend the text", async () => {
    const { streams, emitted } = service();
    await streams.append("run", "call", "Hello");
    await streams.append("run", "call", "Hello");
    await streams.append("run", "call", "Hel");
    await streams.append("run", "call", "Yellow");
    expect(emitted).toEqual([
      { phase: "started", id: "draft:run:call" },
      { phase: "delta", id: "draft:run:call", delta: "Hello" },
    ]);
  });

  it("completes a streamed message with matching text without another delta", async () => {
    const { streams, emitted } = service();
    await streams.append("run", "call", "Hello, ");
    await streams.append("run", "call", "Hello, world");
    await streams.complete("run", "call", "Hello, world");
    expect(emitted.map((entry) => entry.phase)).toEqual(["started", "delta", "delta"]);
    expect(emitted.map((entry) => entry.delta ?? "").join("")).toBe("Hello, world");
  });

  it("sends the remainder when the committed text extends the streamed prefix", async () => {
    const { streams, emitted } = service();
    await streams.append("run", "call", "Hello");
    await streams.complete("run", "call", "Hello, world");
    expect(emitted.at(-1)).toEqual({ phase: "delta", id: "draft:run:call", delta: ", world" });
  });

  it("aborts when the committed text differs from its stream", async () => {
    const { streams, emitted } = service();
    await streams.append("run", "call", "Hello");
    await streams.complete("run", "call", "Goodbye");
    expect(emitted.at(-1)).toEqual({
      phase: "aborted", id: "draft:run:call", reason: "Committed message differs from its stream",
    });
    await streams.append("run", "call", "Hello again");
    await streams.complete("run", "call", "Hello again");
    expect(emitted).toHaveLength(3);
  });

  it("aborts a streamed action with its reason and stays quiet for one that never started", async () => {
    const { streams, emitted } = service();
    await streams.append("run", "call", "Hel");
    await streams.abortAction("run", "call", "Send accepts text and yield only");
    await streams.abortAction("run", "other", "never streamed");
    await streams.append("run", "call", "Hello");
    expect(emitted).toEqual([
      { phase: "started", id: "draft:run:call" },
      { phase: "delta", id: "draft:run:call", delta: "Hel" },
      { phase: "aborted", id: "draft:run:call", reason: "Send accepts text and yield only" },
    ]);
  });

  it("aborts every started projection of a run and leaves other runs alone", async () => {
    const { streams, emitted } = service();
    await streams.append("run", "a", "one");
    await streams.append("run", "b", "two");
    await streams.append("other", "c", "three");
    await streams.abortRun("run", "The run was interrupted");
    expect(emitted.filter((entry) => entry.phase === "aborted")).toEqual([
      { phase: "aborted", id: "draft:run:a", reason: "The run was interrupted" },
      { phase: "aborted", id: "draft:run:b", reason: "The run was interrupted" },
    ]);
  });

  it("withdraws a whitespace preview when Send becomes a silent yield", async () => {
    const { streams, emitted } = service();
    await streams.append("run", "call", " \n");
    await streams.silence("run", "call");
    expect(emitted.slice(2)).toEqual([
      { phase: "aborted", id: "draft:run:call", reason: "The run yielded without a message" },
      { phase: "silenced", id: "draft:run:call" },
    ]);
  });

  it("fences every projection before waiting for abort delivery", async () => {
    const { streams, emitted } = service();
    await streams.append("run", "a", "one");
    await streams.append("run", "b", "two");
    let release!: () => void;
    const delivery = new Promise<void>((resolve) => { release = resolve; });
    const notify = vi.spyOn(streams, "emitProjection").mockImplementation(async () => delivery);
    notify.mockClear();
    const aborted = streams.abortRun("run", "interrupted");
    try {
      await streams.append("run", "b", "two late");
      expect(notify.mock.calls.map((call) => call[2])).toEqual(["aborted", "aborted"]);
    } finally {
      release();
    }
    await aborted;
    expect(emitted.map((entry) => entry.delta ?? "").join("")).toBe("onetwo");
  });

  it.each(["append", "complete"] as const)("does not emit a late delta when %s is interrupted during start", async (operation) => {
    const { streams } = service();
    let release!: () => void;
    const delivery = new Promise<void>((resolve) => { release = resolve; });
    const phases: string[] = [];
    vi.spyOn(streams, "emitProjection").mockImplementation(async (_runId, _projection, phase) => {
      phases.push(phase);
      if (phase === "started") await delivery;
    });
    const pending = streams[operation]("run", "call", "late text");
    await streams.abortRun("run", "interrupted");
    release();
    await pending;
    expect(phases).toEqual(["started", "aborted"]);
  });
});
