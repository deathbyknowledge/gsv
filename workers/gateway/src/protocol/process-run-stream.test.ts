import { describe, expect, it, vi } from "vitest";
import type { SignalFrame } from "./frames";
import {
  consumeProcessRunStream,
  encodeProcessRunStreamFrame,
} from "./process-run-stream";

function runStreamFrame(
  pid: string,
  runId: string,
  seq: number,
  delta: string,
): SignalFrame {
  return {
    type: "sig",
    signal: "proc.run.stream",
    payload: {
      pid,
      runId,
      seq,
      event: { type: "text_delta", delta },
      timestamp: Date.now(),
    },
  };
}

function chunkedStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

describe("Process run stream framing", () => {
  it("decodes fragmented and coalesced UTF-8 records in order", async () => {
    const pid = "proc-stream-codec";
    const firstFrame = runStreamFrame(pid, "run-1", 7, "one 🙂");
    const secondFrame = runStreamFrame(pid, "run-1", 8, "two");
    const first = encodeProcessRunStreamFrame(firstFrame);
    const second = encodeProcessRunStreamFrame(secondFrame);
    const combined = new Uint8Array(first.byteLength + second.byteLength);
    combined.set(first);
    combined.set(second, first.byteLength);
    const emojiStart = first.findIndex((byte) => byte === 0xf0);
    expect(emojiStart).toBeGreaterThan(0);
    const split = emojiStart + 2;
    const consumed: SignalFrame[] = [];

    await consumeProcessRunStream(
      pid,
      chunkedStream([combined.slice(0, split), combined.slice(split)]),
      (frame) => consumed.push(frame),
    );

    expect(consumed).toEqual([firstFrame, secondFrame]);
  });

  it("rejects a process identity mismatch and cancels the source", async () => {
    const cancel = vi.fn();
    const bytes = encodeProcessRunStreamFrame(runStreamFrame("proc-other", "run-1", 1, "no"));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
      },
      cancel,
    });

    await expect(consumeProcessRunStream("proc-owner", stream, vi.fn()))
      .rejects.toThrow("payload is invalid");
    expect(cancel).toHaveBeenCalledWith("Process run stream is invalid");
  });

  it("rejects truncated, cross-run, and noncontiguous records", async () => {
    const pid = "proc-invalid-stream";
    const first = encodeProcessRunStreamFrame(runStreamFrame(pid, "run-1", 4, "one"));
    const wrongRun = encodeProcessRunStreamFrame(runStreamFrame(pid, "run-2", 5, "two"));
    const skipped = encodeProcessRunStreamFrame(runStreamFrame(pid, "run-1", 6, "three"));

    await expect(consumeProcessRunStream(
      pid,
      chunkedStream([first.slice(0, first.byteLength - 1)]),
      vi.fn(),
    )).rejects.toThrow("incomplete record");
    await expect(consumeProcessRunStream(
      pid,
      chunkedStream([first, wrongRun]),
      vi.fn(),
    )).rejects.toThrow("changed run IDs");
    await expect(consumeProcessRunStream(
      pid,
      chunkedStream([first, skipped]),
      vi.fn(),
    )).rejects.toThrow("sequence is not contiguous");
  });

  it("rejects records over the framing limit", () => {
    expect(() => encodeProcessRunStreamFrame(
      runStreamFrame("proc-large-stream", "run-1", 1, "x".repeat(1_048_576)),
    )).toThrow("record is too large");
  });
});
