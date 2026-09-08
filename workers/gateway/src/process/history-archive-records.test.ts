import { evictDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  jsonValueSchema, procHistoryArchivedRecordSchema, type ProcHistorySegmentReadArgs,
  type ProcHistorySegmentRecordsResult,
} from "@humansandmachines/gsv/protocol";
import type { Process } from "./do";
import { initProcess, ROOT_IDENTITY, runInProcess } from "./do-test-harness";
import { decodeWireResponse } from "../protocol/decode-wire-frame";

async function segmentPage(stub: DurableObjectStub<Process>, args: ProcHistorySegmentReadArgs): Promise<ProcHistorySegmentRecordsResult> {
  return runInProcess(stub, async (process: Process) => {
    const result = await process.history.handleHistorySegmentRead({ ...args, format: 2 });
    if (!result.ok || result.format !== 2) throw new Error("Typed archive read failed");
    for (const record of result.records) expect(procHistoryArchivedRecordSchema.parse(record)).toEqual(record);
    decodeWireResponse("proc.history.segment.read", {
      type: "res", id: "archive:fixture", ok: true,
      data: jsonValueSchema.parse(JSON.parse(JSON.stringify(result))),
    });
    return result;
  });
}

describe("typed history archive wire", () => {
  it("retains mixed typed and legacy groups through real compaction, archive paging, and eviction", async () => {
    const stub = await initProcess("history-archive-records", ROOT_IDENTITY);
    const compacted = await runInProcess(stub, async (process: Process) => {
      const { messages } = process.store;
      messages.appendMessage("user", "Legacy request", { legacy: true, createdAt: -10 });
      messages.appendMessage("assistant", "Legacy reasoning", {
        legacy: true, createdAt: 20, runId: "run:archive",
        toolCalls: JSON.stringify({
          thinking: [{ type: "thinking", thinking: "Retained thought", thinkingSignature: "archive-signature", redacted: false }],
          toolCalls: [{ type: "toolCall", id: "call:archive", name: "Read", arguments: { path: "/one" } }],
        }),
        metadata: { provider: { model: "synthetic-model", responseId: "synthetic-response" } },
      });
      messages.appendMessage("toolResult", '{\n  "ok": false,\n  "count": 1.00\n}', {
        legacy: true, createdAt: 30, runId: "run:archive", toolCallId: "call:archive",
        toolCalls: JSON.stringify({ toolName: "Read", isError: true, outcome: "denied" }),
      });
      messages.appendMessage("assistant", "Compatibility text", {
        createdAt: 40, runId: "run:archive", records: [
          { kind: "note", payload: { text: "Typed note", thinking: [] } },
          { kind: "message", payload: {
            direction: "out", text: "Committed output", origin: {}, media: [],
            conversationId: "conversation:archive", conversationMessageId: "message:archive",
          } },
        ],
      });
      messages.appendMessage("user", "Keep the live suffix", { createdAt: 50 });
      const result = await process.history.handleHistoryCompact({ keepLast: 1, summary: "Synthetic compacted context" });
      if (!result.ok) throw new Error(`Compaction failed: ${result.error}`);
      return result;
    });
    const legacy = await runInProcess(stub, (process: Process) => process.history.handleHistorySegmentRead({ segmentId: compacted.segment.id }));
    expect(legacy).not.toHaveProperty("format");
    expect(legacy).not.toHaveProperty("records");
    const full = await segmentPage(stub, { segmentId: compacted.segment.id });
    expect(full.messages).toEqual(legacy.ok ? legacy.messages : []);
    expect(full.messageCount).toBe(4);
    expect(full.records.map(({ id }) => id)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(full.records.map(({ messageId, index, kind, source }) => [messageId, index, kind, source])).toEqual([
      [1, 0, "message", "legacy"], [2, 0, "note", "legacy"], [2, 1, "call", "legacy"],
      [3, 0, "result", "legacy"], [4, 0, "note", "typed"], [4, 1, "message", "typed"],
    ]);
    expect(full.records[0]?.createdAt).toBe(-10);
    expect(full.records[1]).toMatchObject({
      sourceMessageId: full.messages[1]?.id,
      metadata: { provider: { responseId: "synthetic-response" } },
      payload: { thinking: [{ thinkingSignature: "archive-signature", redacted: false }] },
    });
    expect(full.records[3]?.payload).toMatchObject({ outcome: "denied", output: { ok: false, count: 1 } });
    expect(full.records[4]?.payload).toMatchObject({ text: "Typed note" });
    for (let offset = 0; offset < full.messageCount; offset++) {
      const page = await segmentPage(stub, { segmentId: compacted.segment.id, offset, limit: 1 });
      expect(page.records).toEqual(full.records.filter(({ messageId }) => messageId === offset + 1));
    }
    expect(full).not.toHaveProperty("cursor");
    await evictDurableObject(stub);
    expect(await segmentPage(stub, { segmentId: compacted.segment.id })).toEqual(full);
  });

  it("assigns stable archive coordinates without inventing missing timestamps or source ids", async () => {
    const pid = "history-archive-old-coordinates";
    const stub = await initProcess(pid, ROOT_IDENTITY);
    const key = `root/processes/${pid}/history/old.jsonl.gz`;
    const rows = [
      { role: "user", content: "No original id or timestamp" },
      { role: "assistant", content: "Old assistant", id: 1, generation: 2, ts: -0.5,
        tool_calls: [{ type: "toolCall", id: "call:old", name: "Read", arguments: { path: "/old" } }] },
      { role: "system", content: "Old notice", generation: 4 },
      { role: "toolResult", content: '{"ok":false,"reason":"old failure"}',
        tool_calls: { toolName: "Read", isError: true, outcome: "cancelled" } },
    ];
    const bytes = await new Response(new Blob([rows.map((row) => JSON.stringify(row)).join("\n")])
      .stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
    await env.STORAGE.put(key, bytes);
    await runInProcess(stub, (process: Process) => process.store.history.recordHistorySegment({
      id: "segment:old", generation: 9, kind: "compaction", fromMessageId: 1, toMessageId: 4, archivePath: `/${key}`,
    }));
    const full = await segmentPage(stub, { segmentId: "segment:old" });
    expect(full.records.map(({ id, messageId, generation }) => [id, messageId, generation])).toEqual([
      [1, 1, 9], [2, 2, 2], [3, 2, 2], [4, 3, 4], [5, 4, 9],
    ]);
    expect(full.records[0]).not.toHaveProperty("createdAt");
    expect(full.records[0]).not.toHaveProperty("sourceMessageId");
    expect(full.records[1]).toMatchObject({ sourceMessageId: 1, createdAt: -0.5 });
    expect(full.records[3]).not.toHaveProperty("createdAt");
    expect(full.records[4]).toMatchObject({
      kind: "result", source: "legacy",
      payload: { callId: null, tool: "Read", outcome: "cancelled", output: { ok: false, reason: "old failure" } },
    });
    expect((await segmentPage(stub, { segmentId: "segment:old", offset: 1, limit: 1 })).records).toEqual(full.records.slice(1, 3));
  });
});
