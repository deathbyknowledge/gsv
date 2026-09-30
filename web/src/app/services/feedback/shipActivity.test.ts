import { describe, expect, it } from "vitest";
import type { ProcHistoryRecord, ProcHistoryRecordsResult } from "@humansandmachines/gsv/protocol";
import { FEEDBACK_ACTIVITY_MAX_LENGTH } from "@humansandmachines/gsv/services/feedback";
import { feedbackActivity } from "./shipActivity";

const identity = (id: number) => ({ id, messageId: id, index: 0, generation: 1, runId: "run", createdAt: id, source: "typed" as const });
const message = (id: number, text: string): ProcHistoryRecord => ({
  ...identity(id), kind: "message", payload: { direction: "in", text, media: [], origin: {} },
});
const history = (records: ProcHistoryRecord[]): ProcHistoryRecordsResult => ({
  ok: true, pid: "proc:ship", format: 2, messages: [], messageCount: records.length, records,
  historyRevision: 1, historyGeneration: 1, historyResetRevision: 0, reset: false, hasMore: false,
});

describe("feedback activity snapshot", () => {
  it("includes thinking, tool inputs and output without media or opaque provider signatures", () => {
    const snapshot = feedbackActivity(history([
      { ...message(1, "The file will not open."), kind: "message", payload: {
        direction: "in", text: "The file will not open.", origin: {},
        media: [{ type: "image", mimeType: "image/png", url: "https://private.example/image" }],
      } },
      { ...identity(2), kind: "note", payload: { text: "Checking the file.", thinking: [{ type: "thinking", thinking: "Inspect its path.", thinkingSignature: "opaque-signature" }] } },
      { ...identity(2), index: 1, kind: "call", payload: { callId: "call", tool: "Read", syscall: "fs.read", args: { path: "/example" }, target: "gsv", runId: "run" } },
      { ...identity(3), kind: "result", payload: { callId: "call", tool: "Read", outcome: "failed", output: "File not found", media: [], resources: [] } },
    ]));
    expect(snapshot).toMatchObject({ pid: "proc:ship", messageCount: 3, truncated: false });
    expect(snapshot.text).toContain("The file will not open.");
    expect(snapshot.text).toContain("Thinking: Inspect its path.");
    expect(snapshot.text).toContain('"path": "/example"');
    expect(snapshot.text).toContain("File not found");
    expect(snapshot.text).not.toContain("private.example");
    expect(snapshot.text).not.toContain("opaque-signature");
  });

  it("keeps the newest 20 message groups", () => {
    const snapshot = feedbackActivity(history(Array.from({ length: 25 }, (_, index) => message(index + 1, `Message number ${index + 1}.`))));
    expect(snapshot.messageCount).toBe(20);
    expect(snapshot.text).not.toContain("Message number 5.");
    expect(snapshot.text).toContain("Message number 6.");
    expect(snapshot.text).toContain("Message number 25.");
  });

  it("bounds an oversized snapshot, preserves its newest text and marks omission", () => {
    const snapshot = feedbackActivity(history([message(1, "x".repeat(100_000)), message(2, "The final error")]));
    expect(snapshot.text.length).toBeLessThanOrEqual(FEEDBACK_ACTIVITY_MAX_LENGTH);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.text).toContain("Earlier activity omitted");
    expect(snapshot.text).toContain("The final error");
  });
});
