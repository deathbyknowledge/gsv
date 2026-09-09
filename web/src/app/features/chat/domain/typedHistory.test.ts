import { describe, expect, it } from "vitest";
import { procHistoryRecordSchema, procHistoryArchivedRecordSchema } from "@humansandmachines/gsv/protocol";
import { mergeTranscriptRows } from "./transcriptMerge";
import { transcriptRowsFromRecords } from "./typedHistory";
import { momentsFromConversation, activitiesForRows, receiptTargets, placesUsed } from "../../instrument/zen/zenModel";

const identity = { id: 1, messageId: 1, index: 0, runId: "r", generation: 1, createdAt: 1, source: "typed" };
describe("typed history projection", () => {
  it.each(["completed", "failed"] as const)("retains %s CodeMode output without inventing a target", (outcome) => {
    const code = 'console.log("started"); return 0;';
    const output = outcome === "completed"
      ? { status: "completed", result: 0, logs: ["started"] }
      : { status: "failed", error: "script failed", logs: ["started"] };
    const call = procHistoryRecordSchema.parse({ ...identity, kind: "call", payload: {
      runId: "r", callId: "code", tool: "CodeMode", syscall: "codemode.exec", target: null,
      args: { code, target: "laptop" },
    } });
    const result = procHistoryRecordSchema.parse({ ...identity, id: 2, messageId: 2, createdAt: 2, kind: "result", payload: {
      callId: "code", tool: "CodeMode", outcome, output, media: [], resources: [],
    } });
    const running = transcriptRowsFromRecords([call]);
    const delta = mergeTranscriptRows(running, transcriptRowsFromRecords([result]));
    const reload = transcriptRowsFromRecords([call, result]);
    const unlinked = transcriptRowsFromRecords([result]);
    for (const rows of [delta, reload, unlinked]) {
      const moment = momentsFromConversation([], rows, null)[0];
      expect(moment.activities).toEqual([expect.objectContaining({ target: null })]);
      expect(moment.activities[0].calls[0]).toMatchObject({
        syscall: "codemode.exec", finished: true, failed: outcome === "failed",
        output: outcome === "completed" ? "started\n0" : "started\nscript failed",
        summary: rows === unlinked ? "" : code,
      });
      expect(receiptTargets(moment)).toEqual([]);
      expect(placesUsed(moment)).toBe(0);
    }
    expect(activitiesForRows(running, "r", true)[0]).toMatchObject({ target: null, live: true });
  });

  it("keeps process working separate from a real target named null", () => {
    const rows = transcriptRowsFromRecords([
      procHistoryRecordSchema.parse({ ...identity, kind: "call", payload: {
        runId: "r", callId: "code", tool: "CodeMode", syscall: "codemode.run", target: null, args: { code: "return 1;", target: "null" },
      } }),
      procHistoryRecordSchema.parse({ ...identity, id: 2, messageId: 2, kind: "call", payload: {
        runId: "r", callId: "read", tool: "Read", syscall: "fs.read", target: "null", args: { path: "/x" },
      } }),
    ]);
    const moment = momentsFromConversation([], rows, "r")[0];
    expect(moment.activities.map((activity) => activity.target)).toEqual([null, "null"]);
    expect(new Set(moment.activities.map((activity) => activity.key)).size).toBe(2);
    expect(receiptTargets(moment)).toEqual([{ target: "null", live: true, failed: false }]);
    expect(placesUsed(moment)).toBe(1);
  });

  it("retains a call's start and a sent message's identity when the result arrives after sending", () => {
    const call = procHistoryRecordSchema.parse({ ...identity, createdAt: 10, kind: "call", payload: {
      runId: "r", callId: "read", tool: "Read", syscall: "fs.read", target: "gsv", args: { path: "/note.md" },
    } });
    const sent = procHistoryRecordSchema.parse({ ...identity, id: 2, messageId: 2, createdAt: 10, kind: "message", payload: {
      direction: "out", conversationMessageId: "sent-one", text: "An update", media: [], origin: {},
    } });
    const result = procHistoryRecordSchema.parse({ ...identity, id: 3, messageId: 3, createdAt: 20, kind: "result", payload: {
      callId: "read", tool: "Read", outcome: "completed", output: "Read output", media: [], resources: [],
    } });
    const started = transcriptRowsFromRecords([call]).map((row) => ({ ...row, processId: "original", status: "running" as const }));
    const delta = mergeTranscriptRows(started, transcriptRowsFromRecords([sent, result]));
    const reloaded = transcriptRowsFromRecords([call, sent, result]);

    for (const rows of [delta, reloaded]) {
      expect(rows.find((row) => row.role === "toolResult")).toMatchObject({
        toolStartedAt: 10, toolCallRecordKey: "1:0", timestamp: 20,
        toolSyscall: "fs.read", toolTarget: "gsv", toolArgs: { path: "/note.md" },
      });
      expect(rows.find((row) => row.messageDirection === "out")).toMatchObject({
        conversationMessageId: "sent-one", historyRecordKey: "2:0", timestamp: 10,
      });
    }
    expect(delta.find((row) => row.role === "toolResult")?.processId).toBe("original");
  });

  it.each(["live", "archive"])("hides redacted thinking in %s notes without changing retained content", (source) => {
    const schema = source === "live" ? procHistoryRecordSchema : procHistoryArchivedRecordSchema;
    const hidden = { type: "thinking", thinking: "opaque provider redaction", redacted: true, thinkingSignature: "hidden-signature" };
    const media = [{ type: "image", mimeType: "image/png", key: "image:synthetic", description: "preview" }];
    const payloads = [
      { text: "Ordinary draft", thinking: [
        { type: "thinking", thinking: "Visible reasoning", thinkingSignature: "visible-signature" },
        hidden,
        { type: "thinking", thinking: "Also visible", redacted: false, thinkingSignature: "second-signature" },
      ], media },
      { text: "", thinking: [hidden] },
      { text: "Ordinary text remains", thinking: [hidden] },
    ];
    const records = payloads.map((payload, index) => schema.parse({
      ...identity, id: index + 1, messageId: index + 1, kind: "note", payload,
      createdAt: source === "archive" ? undefined : identity.createdAt,
      source: source === "archive" ? "legacy" : identity.source,
    }));
    const retained = structuredClone(records);

    const rows = transcriptRowsFromRecords(records);

    expect(rows).toEqual([
      expect.objectContaining({ role: "assistant", text: "Ordinary draft", thinking: ["Visible reasoning", "[redacted thinking]", "Also visible"], media }),
      expect.objectContaining({ role: "assistant", text: "", thinking: ["[redacted thinking]"] }),
      expect.objectContaining({ role: "assistant", text: "Ordinary text remains", thinking: ["[redacted thinking]"] }),
    ]);
    expect(JSON.stringify(rows)).not.toContain(hidden.thinking);
    expect(records).toEqual(retained);
  });

  it("replaces stale streamed thinking from a redacted-only history note when completion was missed", () => {
    const previous = transcriptRowsFromRecords([procHistoryRecordSchema.parse({
      ...identity, kind: "note", payload: { text: "Earlier note", thinking: [{ type: "thinking", thinking: "Earlier visible reasoning" }] },
    })]);
    const streamed = {
      id: "assistant:r", role: "assistant" as const, runId: "r", text: "", time: "", timestamp: 2,
      thinking: ["Partial reasoning later redacted"], streaming: true, status: "streaming" as const,
    };
    const refreshed = transcriptRowsFromRecords([procHistoryRecordSchema.parse({
      ...identity, id: 2, messageId: 2, createdAt: 2, kind: "note",
      payload: { text: "", thinking: [{ type: "thinking", thinking: "opaque provider data", redacted: true }] },
    })]);

    expect(mergeTranscriptRows([...previous, streamed], refreshed)).toEqual([
      ...previous,
      expect.objectContaining({ id: "message:2", text: "", thinking: ["[redacted thinking]"], status: "done" }),
    ]);
  });

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

  it("keeps a failed Read receipt when its running row settles and history reloads", () => {
    const path = "/this-file-defo-does-not-exist.txt";
    const output = { ok: false, error: `ENOENT: no such file or directory, stat '${path}'` };
    const call = procHistoryRecordSchema.parse({ ...identity, kind: "call", payload: {
      runId: "r", callId: "read", tool: "Read", syscall: "fs.read", target: "gsv", args: { path },
    } });
    const result = procHistoryRecordSchema.parse({ ...identity, id: 2, messageId: 2, createdAt: 2, kind: "result", payload: {
      callId: "read", tool: "Read", outcome: "failed", output, media: [], resources: [],
    } });
    const records = [call, result];
    const running = transcriptRowsFromRecords([call]).map((row) => ({ ...row, status: "running" as const }));
    const settled = mergeTranscriptRows(running, transcriptRowsFromRecords(records));
    const reloaded = transcriptRowsFromRecords(records.map((record) => procHistoryRecordSchema.parse(JSON.parse(JSON.stringify(record)))));

    for (const rows of [settled, reloaded]) {
      expect(rows).toEqual([expect.objectContaining({
        role: "toolResult", toolName: "Read", toolSyscall: "fs.read", toolTarget: "gsv",
        toolOutcome: "failed", toolOutput: output, isError: true, status: "error",
      })]);
      const moments = momentsFromConversation([], rows, null);
      expect(moments).toHaveLength(1);
      expect(moments[0].activities[0].calls).toEqual([expect.objectContaining({ output: output.error, finished: true, failed: true })]);
      expect(receiptTargets(moments[0])).toEqual([{ target: "gsv", live: false, failed: true }]);
    }
  });

  it("shows successful Read content verbatim even when it looks like a filesystem error", () => {
    const path = "/example.json";
    const content = '{"ok":false,"error":"ENOENT: quoted file content"}';
    const output = { ok: true, path, content };
    const records = [
      procHistoryRecordSchema.parse({ ...identity, kind: "call", payload: {
        runId: "r", callId: "read", tool: "Read", syscall: "fs.read", target: "gsv", args: { path },
      } }),
      procHistoryRecordSchema.parse({ ...identity, id: 2, messageId: 2, createdAt: 2, kind: "result", payload: {
        callId: "read", tool: "Read", outcome: "completed", output, media: [], resources: [],
      } }),
    ];
    const reloaded = records.map((record) => procHistoryRecordSchema.parse(JSON.parse(JSON.stringify(record))));
    for (const source of [records, reloaded]) {
      const rows = transcriptRowsFromRecords(source);
      expect(rows).toEqual([expect.objectContaining({ toolOutcome: "completed", toolOutput: output, isError: false, status: "done" })]);
      const moments = momentsFromConversation([], rows, null);
      expect(moments).toHaveLength(1);
      expect(moments[0].activities[0].calls).toEqual([expect.objectContaining({ output: content, finished: true, failed: false })]);
      expect(receiptTargets(moments[0])).toEqual([{ target: "gsv", live: false, failed: false }]);
    }
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
