import type { JsonValue, ProcHistoryRecordData } from "@humansandmachines/gsv/protocol";
import { describe, expect, it } from "vitest";
import { initProcess, ROOT_IDENTITY, runInProcess } from "./do-test-harness";
import { renderCompactionTranscriptWindow } from "./history/compaction-renderer";
import { buildCompactionSummaryContext, isCompactionSummaryMessage } from "./history/helpers";
import { inferHistoryRecords } from "./storage/history-records";
import { normalizeCompactionCut } from "./storage/record-codec";
import type { MessageRecord } from "./storage/records";

function message(id: number, fields: Partial<MessageRecord> = {}): MessageRecord {
  return {
    id, generation: 1, runId: "run:summary", role: "user", content: "compatibility text",
    toolCalls: null, toolCallId: null, media: null, metadata: null, createdAt: 100,
    ...fields,
  };
}

function note(text: string): ProcHistoryRecordData {
  return { kind: "note", payload: { text, thinking: [] } };
}

function call(callId: string): ProcHistoryRecordData {
  return { kind: "call", payload: { callId, tool: "Read", syscall: "fs.read", args: {}, target: "gsv", runId: "run:summary" } };
}

function result(callId: string, output: JsonValue = null): ProcHistoryRecordData {
  return { kind: "result", payload: { callId, tool: "Read", outcome: "completed", output, media: [], resources: [] } };
}

function lines(transcript: string): JsonValue[] {
  // SAFETY: the subject produces JSONL; parsing each line asserts the serialization boundary.
  return transcript.split("\n").map((line) => JSON.parse(line) as JsonValue);
}

describe("structured compaction transcript", () => {
  it("renders typed members as independent JSON lines with original message coordinates", () => {
    const records = [note("Typed reasoning"), call("call:read"), {
      kind: "message", payload: { direction: "out", text: "Committed update", media: [], origin: {} },
    } satisfies ProcHistoryRecordData];
    const source = [
      message(10, { role: "assistant", content: "Obsolete compatibility prose", records }),
      message(20, { role: "toolResult", toolCallId: "compatibility-call", records: [result("call:read", { count: 3 })] }),
      message(30, { role: "system", content: "Legacy runtime event" }),
    ];
    const transcript = renderCompactionTranscriptWindow(source, 24_000);
    expect(lines(transcript)).toEqual([
      ...records.map((record, index) => ({ messageId: 10, index, generation: 1, runId: "run:summary", createdAt: 100, ...record })),
      { messageId: 20, index: 0, generation: 1, runId: "run:summary", createdAt: 100, ...result("call:read", { count: 3 }) },
      {
        messageId: 30, index: 0, generation: 1, runId: "run:summary", createdAt: 100,
        kind: "event", payload: { kind: "legacy", payload: { text: "Legacy runtime event" }, severity: "info", audience: "model" },
      },
    ]);
    expect(transcript).not.toContain("Obsolete compatibility prose");
    expect(transcript).not.toContain("tool_calls");
    const context = buildCompactionSummaryContext(source, "Unchanged summary prompt");
    expect(context.systemPrompt).toBe("Unchanged summary prompt");
    expect(context.messages[0]?.content).toContain(transcript);
  });

  it("keeps bounded head and tail records with explicit omission and truncation", () => {
    const source = Array.from({ length: 100 }, (_, index) => message(index + 1, {
      records: [result(`call:${index}`, { nested: { text: `${index}:` + '"\\\n'.repeat(10_000) } })],
    }));
    const transcript = renderCompactionTranscriptWindow(source, 2_000);
    const parsed = lines(transcript);
    expect(transcript.length).toBeLessThanOrEqual(2_000);
    expect(parsed[0]).toMatchObject({ messageId: 1, kind: "result", record_truncated: true, payload_preview: expect.stringContaining('"output":{"nested":') });
    expect(parsed.at(-1)).toMatchObject({ messageId: 100, kind: "result", record_truncated: true });
    expect(parsed).toContainEqual({ omitted_records: 98, omitted_messages: 98 });
  });

  it("bounds deeply nested payloads without recursively serializing the whole value", () => {
    let output: JsonValue = { text: "deep value" };
    for (let index = 0; index < 20_000; index += 1) output = { nested: output };
    const transcript = renderCompactionTranscriptWindow([
      message(1, { records: [result("call:deep", output)] }),
      message(2, { records: [note("The final state remains visible")] }),
    ], 1_500);
    expect(transcript.length).toBeLessThanOrEqual(1_500);
    expect(lines(transcript)[0]).toMatchObject({ messageId: 1, kind: "result", record_truncated: true });
    expect(lines(transcript).at(-1)).toMatchObject({ messageId: 2, kind: "note", payload: { text: "The final state remains visible" } });
  });

  it("emits only complete records for small windows and nothing for an empty transcript", () => {
    expect(renderCompactionTranscriptWindow([], 100)).toBe("");
    expect(renderCompactionTranscriptWindow([message(1)], 1)).toBe("");
    const source = [message(1, { records: [note('Exact JSON: " \\ \n 😀')] })];
    const full = renderCompactionTranscriptWindow(source, 24_000);
    expect(renderCompactionTranscriptWindow(source, full.length)).toBe(full);
    expect(lines(full)[0]).toMatchObject({ payload: { text: 'Exact JSON: " \\ \n 😀' } });
    const shortened = renderCompactionTranscriptWindow(source, full.length - 1);
    expect(shortened.length).toBeLessThan(full.length);
    expect(() => lines(shortened)).not.toThrow();
  });
});

describe("structured compaction boundaries", () => {
  it("normalizes an already promoted legacy near-miss without rewriting its stored payload or model bytes", async () => {
    const stub = await initProcess("history-compaction-promoted-near-miss", ROOT_IDENTITY);
    await runInProcess(stub, (process) => {
      const text = "Process history compacted. extra details, not an actual summary";
      const id = process.store.messages.appendMessage("system", text, {
        record: { kind: "event", payload: {
          kind: "legacy", payload: { text, recognizedKind: "history.compacted" }, severity: "info", audience: "model",
        } },
      });
      process.store.messages.appendRelatedRecord(id, {
        kind: "message", payload: { direction: "out", text: "A later user-visible update", media: [], origin: {} },
      });
      const storedPayload = () => process.store.sql.exec<{ payload_json: string }>(
        "SELECT payload_json FROM messages WHERE id = ?", id,
      ).toArray()[0]!.payload_json;
      const original = storedPayload();
      const loaded = process.store.messages.getMessages()[0]!;
      expect(loaded.content).toBe(text);
      expect(loaded.records?.[0]).toEqual({
        kind: "event", payload: { kind: "legacy", payload: { text }, severity: "info", audience: "model" },
      });
      expect(isCompactionSummaryMessage(loaded)).toBe(false);
      expect(process.store.messages.toMessages()[0]?.content).toBe(`[GSV EVENT]\n${text}`);
      expect(storedPayload()).toBe(original);
      expect(original).toContain('"recognizedKind":"history.compacted"');
    });
  });

  it("recognizes summaries by typed identity and confines exact legacy prefix recovery to storage", () => {
    const summary: ProcHistoryRecordData = {
      kind: "event", payload: {
        kind: "history.compacted", payload: { archivedMessages: 2, archivePath: "/root/archive.gz", segmentId: "segment:1", summary: "Earlier work" },
        severity: "info", audience: "model",
      },
    };
    expect(isCompactionSummaryMessage(message(1, { records: [summary] }))).toBe(true);
    const legacy = message(2, { role: "system", content: "Process history compacted.\n\nSummary:\nEarlier work" });
    expect(isCompactionSummaryMessage(legacy)).toBe(true);
    expect(isCompactionSummaryMessage({ ...legacy, records: inferHistoryRecords(legacy) })).toBe(true);
    for (const content of ["Process history compacted.", "Process history compacted. extra", "Process history compacted.\r\nSummary"]) {
      const nearMiss = message(3, { role: "system", content });
      expect(isCompactionSummaryMessage(nearMiss)).toBe(false);
      expect(isCompactionSummaryMessage({ ...nearMiss, records: inferHistoryRecords(nearMiss) })).toBe(false);
    }
    expect(isCompactionSummaryMessage({ ...legacy, role: "user" })).toBe(false);
    expect(isCompactionSummaryMessage(message(4, { records: [note("ordinary note"), summary] }))).toBe(false);
  });

  it("keeps overlapping typed exchanges and companion records in original message coordinates", () => {
    const source = [
      message(1),
      message(2, { role: "assistant", records: [note("First calls"), call("a"), call("b")] }),
      message(3, { role: "system", content: "Interleaved runtime event" }),
      message(4, { records: [result("b")] }),
      message(5, { role: "assistant", records: [note("Overlapping call"), call("c")] }),
      message(6, { records: [result("a")] }),
      message(7, { records: [result("c")] }),
      message(8),
    ];
    expect(normalizeCompactionCut(source, 2, "backward")).toBe(1);
    expect(normalizeCompactionCut(source, 2, "forward")).toBe(7);
    expect(normalizeCompactionCut(source, 5, "backward")).toBe(1);
    expect(normalizeCompactionCut(source, 7, "backward")).toBe(7);
  });

  it("preserves empty legacy call ids and keeps incomplete exchanges together", () => {
    const source = [
      message(1),
      message(2, { role: "assistant", toolCalls: JSON.stringify([{ type: "toolCall", id: "", name: "Read", arguments: {} }]) }),
      message(3, { role: "toolResult", toolCallId: "", toolCalls: '{"toolName":"Read","isError":false}' }),
      message(4, { role: "assistant", records: [note("Pending call"), call("pending")] }),
      message(5),
    ];
    expect(normalizeCompactionCut(source, 2, "backward")).toBe(1);
    expect(normalizeCompactionCut(source, 2, "forward")).toBe(3);
    expect(normalizeCompactionCut(source, 4, "backward")).toBe(3);
    expect(normalizeCompactionCut(source, 4, "forward")).toBe(5);
  });
});
