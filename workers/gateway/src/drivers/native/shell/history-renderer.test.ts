import { describe, expect, it } from "vitest";
import type { ProcHistoryRecord } from "@humansandmachines/gsv/protocol";
import { renderProcHistoryRecords } from "./history-renderer";

describe("native typed history presentation", () => {
  it("keeps notes, call routing, structured output, media, and person notices inspectable", () => {
    const identity = { id: 1, messageId: 1, generation: 0, runId: "run", createdAt: 1000, source: "typed" as const };
    const records: ProcHistoryRecord[] = [
      { ...identity, index: 0, kind: "note", payload: {
        text: "working", thinking: [{ type: "thinking", thinking: "private redacted text", redacted: true }],
      } },
      { ...identity, id: 2, index: 1, kind: "call", payload: {
        callId: "c", tool: "Shell", syscall: "shell.exec", target: "laptop", runId: "run", args: { input: "date" },
      } },
      { ...identity, id: 3, messageId: 2, index: 0, kind: "result", payload: {
        callId: "c", tool: "Shell", outcome: "failed", output: { text: "a field", exitCode: 7 },
        error: { message: "failed", code: 7 }, resources: [],
        media: [{ type: "document", mimeType: "text/plain", path: "/home/sam/report.txt" }],
      } },
      { ...identity, id: 4, messageId: 2, index: 1, kind: "event", payload: {
        kind: "media.failed", severity: "warn", audience: "person",
        payload: { error: "attachment unavailable", reason: "media.error", messageId: 1 },
      } },
    ];
    const text = renderProcHistoryRecords(records).join("\n");
    expect(text).toContain("[redacted thinking]\nworking");
    expect(text).not.toContain("private redacted text");
    expect(text).toContain("call Shell call=c syscall=shell.exec target=laptop");
    expect(text).toContain('"text": "a field",\n  "exitCode": 7');
    expect(text).toContain('Error: {"message":"failed","code":7}');
    expect(text).toContain("/home/sam/report.txt");
    expect(text).toContain("event media.failed severity=warn audience=person");
  });

  it("shows an archived result whose timestamp and call linkage were never retained", () => {
    const text = renderProcHistoryRecords([{
      id: 1, messageId: 1, index: 0, generation: 1, runId: null, source: "legacy", kind: "result",
      payload: { callId: null, tool: "unknown", outcome: "completed", output: "Old output", media: [], resources: [] },
    }]).join("\n");
    expect(text).toBe("[#1:0] result unknown completed call=unknown -\nOld output\n");
  });
});
