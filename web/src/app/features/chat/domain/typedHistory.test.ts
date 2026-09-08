import { describe, expect, it } from "vitest";
import { procHistoryRecordSchema, procHistoryArchivedRecordSchema } from "@humansandmachines/gsv/protocol";
import { mergeTranscriptRows } from "./transcriptMerge";
import { transcriptRowsFromRecords } from "./typedHistory";
import { momentsFromConversation, activitiesForRows } from "../../instrument/zen/zenModel";

const identity = { id: 1, messageId: 1, index: 0, runId: "r", generation: 1, createdAt: 1, source: "typed" };
describe("typed history projection", () => {
  it("uses event severity and kind without reclassifying ordinary text or JSON-looking strings", () => {
    const rows = transcriptRowsFromRecords([
      procHistoryRecordSchema.parse({ ...identity, kind: "message", payload: { direction: "in", text: "Generation failed: just a quotation", media: [], origin: {} } }),
      procHistoryRecordSchema.parse({ ...identity, id: 2, messageId: 2, kind: "event", payload: { kind: "legacy", payload: { text: "Generation failed: retained info" }, severity: "info", audience: "model" } }),
      procHistoryRecordSchema.parse({ ...identity, id: 3, messageId: 3, kind: "event", payload: { kind: "delivery.failed", payload: { phase: "message", error: "connection lost" }, severity: "error", audience: "both" } }),
      procHistoryRecordSchema.parse({ ...identity, id: 4, messageId: 4, kind: "result", payload: { callId: "c", tool: "Read", output: '{"text":"literal"}', outcome: "completed", media: [], resources: [] } }),
    ]);
    // Error-ish wording that is not a known gateway format must NOT go red.
    expect(rows.map((row) => row.isError === true)).toEqual([false, false, true, false]);
    expect(rows[3].toolOutput).toBe('{"text":"literal"}');
    expect(rows[3].text).toBe('{"text":"literal"}');
    expect(rows[3].toolSyscall).toBeNull();
    expect(rows[3].toolTarget).toBeNull();
  });

  it("keeps unlinked archive results independent and leaves unknown timestamps unknown", () => {
    const records = [1, 2].map((messageId) => procHistoryArchivedRecordSchema.parse({
      ...identity, createdAt: undefined, id: messageId, messageId, source: "legacy", kind: "result",
      payload: { callId: null, tool: "Read", output: `result ${messageId}`, outcome: "completed", media: [], resources: [] },
    }));
    const rows = transcriptRowsFromRecords(records);
    expect(rows.map((row) => [row.id, row.toolCallId, row.timestamp, row.time])).toEqual([
      ["message:1", undefined, null, ""], ["message:2", undefined, null, ""],
    ]);
  });

  it("keeps Send inspectable while Zen uses committed messages and folds only notes into working", () => {
    const rows = transcriptRowsFromRecords([
      procHistoryRecordSchema.parse({ ...identity, kind: "note", payload: { text: "working", thinking: [], media: [] } }),
      procHistoryRecordSchema.parse({ ...identity, index: 1, kind: "call", payload: { runId: "r", callId: "s", tool: "Send", syscall: null, target: null, args: { message: "sent" } } }),
      procHistoryRecordSchema.parse({ ...identity, messageId: 2, kind: "message", payload: { direction: "out", text: "sent", media: [], origin: {} } }),
    ]);
    expect(rows.find((row) => row.toolName === "Send")).toBeDefined();
    expect(activitiesForRows(rows, "r", false)).toEqual([]);
    const moments = momentsFromConversation([{ id: "committed", text: "sent", time: "", timestamp: 2, runId: "r", role: "assistant" }], rows, null);
    expect(moments).toHaveLength(1);
    expect(moments[0]).toMatchObject({ text: "sent", narration: "working" });
  });

  it("excludes classified Shell sends while retaining ordinary Shell calls with identical arguments", () => {
    const records = [null, "shell.exec"].flatMap((syscall, index) => [
      procHistoryRecordSchema.parse({ ...identity, id: index * 2 + 1, messageId: index * 2 + 1, kind: "call", payload: {
        runId: "r", callId: `shell-${index}`, tool: "Shell", syscall, target: syscall ? "gsv" : null, args: { input: "message send --message hello" },
      } }),
      procHistoryRecordSchema.parse({ ...identity, id: index * 2 + 2, messageId: index * 2 + 2, kind: "result", payload: {
        callId: `shell-${index}`, tool: "Shell", outcome: "completed", output: "done", media: [], resources: [],
      } }),
    ]);
    const rows = transcriptRowsFromRecords(records);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.toolRunControl)).toEqual([true, false]);
    const moments = momentsFromConversation([{ id: "committed", text: "hello", time: "", timestamp: 2, runId: "r", role: "assistant" }], rows, null);
    expect(moments).toHaveLength(1);
    expect(moments[0].text).toBe("hello");
    expect(moments[0].activities.flatMap((activity) => activity.calls.map((call) => call.callId))).toEqual(["shell-1"]);
  });

  it("keeps unlinked Shell results visible and carries typed run control into a running row", () => {
    const result = procHistoryRecordSchema.parse({ ...identity, kind: "result", payload: {
      callId: "unknown", tool: "Shell", outcome: "completed", output: "done", media: [], resources: [],
    } });
    expect(activitiesForRows(transcriptRowsFromRecords([result]), "r", false)).toHaveLength(1);
    const call = procHistoryRecordSchema.parse({ ...identity, kind: "call", payload: {
      runId: "r", callId: "send", tool: "Shell", syscall: null, target: null, args: { input: "message send --message hello" },
    } });
    const running = mergeTranscriptRows([{ id: "raw", role: "tool", toolCallId: "send", toolName: "Shell", toolSyscall: null, runId: "r", text: "", timestamp: 1, time: "", status: "running" }], transcriptRowsFromRecords([call]));
    expect(running).toEqual([expect.objectContaining({ status: "running", toolRunControl: true })]);
    expect(activitiesForRows(running, "r", true)).toEqual([]);
  });

  it("shows person events while idle and keeps model-only events out of human conversation", () => {
    const records = ["person", "model"].map((audience, index) => procHistoryRecordSchema.parse({
      ...identity, id: index + 1, messageId: index + 1, runId: null, kind: "event",
      payload: { kind: "legacy", payload: { text: "a status update" }, severity: "info", audience },
    }));
    const moments = momentsFromConversation([], transcriptRowsFromRecords(records), null);
    expect(moments).toHaveLength(1);
    expect(moments[0]).toMatchObject({ role: "note", text: "a status update", event: { audience: "person" }, runId: null });
  });

  it("renders a registered machine connection notice from typed source fields", () => {
    const event = procHistoryRecordSchema.parse({ ...identity, runId: null, kind: "event", payload: {
      kind: "target.connection", payload: { targetId: "machine-1", label: "Laptop", event: "connected", platform: "linux", observedAt: 1 }, severity: "info", audience: "person",
    } });
    const moments = momentsFromConversation([], transcriptRowsFromRecords([event]), null);
    expect(moments).toHaveLength(1);
    expect(moments[0]).toMatchObject({ text: "Laptop connected.", event: { kind: "target.connection", severity: "info", audience: "person" } });
  });

  it("uses the recorded target even when arguments name a different one", () => {
    const call = procHistoryRecordSchema.parse({ ...identity, kind: "call", payload: { runId: "r", callId: "c", tool: "Shell", syscall: "shell.exec", target: "authoritative", args: { target: "misleading", input: "pwd" } } });
    expect(activitiesForRows(transcriptRowsFromRecords([call]), "r", true)[0].target).toBe("authoritative");
  });
});
