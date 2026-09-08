import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  jsonValueSchema, procHistoryRecordSchema, type ProcHistoryArgs, type ProcHistoryRecordData,
  type ProcHistoryRecordsResult,
} from "@humansandmachines/gsv/protocol";
import type { Process } from "./do";
import { initProcess, ROOT_IDENTITY, runInProcess } from "./do-test-harness";
import { historyCursor } from "./history/cursor";
import { getProcessByPid } from "../shared/utils";
import { runSqlMigrations } from "../schema/runner";
import { PROCESS_MIGRATIONS, PROCESS_SCHEMA_COMPONENT } from "./schema/migrations";
import { ProcessStore } from "./store";
import { decodeWireFrameJson, decodeWireResponse } from "../protocol/decode-wire-frame";

const note: ProcHistoryRecordData = { kind: "note", payload: { text: "Working", thinking: [] } };
const call: ProcHistoryRecordData = {
  kind: "call",
  payload: { callId: "call:one", tool: "Read", syscall: "fs.read", args: { path: "/one" }, target: "gsv", runId: "run:one" },
};
const outgoing: ProcHistoryRecordData = {
  kind: "message",
  payload: { direction: "out", text: "A committed message", media: [], origin: {}, conversationMessageId: "message:one" },
};

async function history(stub: DurableObjectStub<Process>, args: ProcHistoryArgs = {}): Promise<ProcHistoryRecordsResult> {
  return runInProcess(stub, async (process: Process) => {
    const result = await process.controller.handleProcHistory({ format: 2, ...args });
    if (!result.ok || result.format !== 2) throw new Error("Typed history read failed");
    for (const record of result.records) expect(procHistoryRecordSchema.parse(record)).toEqual(record);
    decodeWireResponse("proc.history", {
      type: "res", id: "history:fixture", ok: true,
      data: jsonValueSchema.parse(JSON.parse(JSON.stringify(result))),
    });
    return result;
  });
}

function cursor(result: ProcHistoryRecordsResult): string {
  if (!result.cursor) throw new Error("Expected a history synchronization cursor");
  return result.cursor;
}

describe("typed Process history synchronization", () => {
  it("migrates v14 without rewriting legacy or typed rows and seeds a durable revision", async () => {
    const stub = await getProcessByPid("history-sync-migration");
    await runInDurableObject(stub, async (_process: Process, state) => {
      await state.storage.deleteAll();
      runSqlMigrations(state.storage, PROCESS_SCHEMA_COMPONENT, PROCESS_MIGRATIONS.filter(({ id }) => id <= 14));
      const sql = state.storage.sql;
      sql.exec("INSERT INTO messages (role, content, created_at) VALUES ('user', '  legacy bytes  ', -10.5)");
      sql.exec("INSERT INTO messages (role, content, created_at, kind, payload_json) VALUES ('assistant', 'Working', 10, ?, ?)",
        note.kind, JSON.stringify(note.payload));
      const before = sql.exec("SELECT * FROM messages ORDER BY id").toArray();
      runSqlMigrations(state.storage, PROCESS_SCHEMA_COMPONENT, PROCESS_MIGRATIONS);
      runSqlMigrations(state.storage, PROCESS_SCHEMA_COMPONENT, PROCESS_MIGRATIONS);
      expect(sql.exec("SELECT * FROM messages ORDER BY id").toArray())
        .toEqual(before.map((row) => ({ ...row, history_revision: 0 })));
      const store = new ProcessStore(sql);
      expect(store.state.getHistoryRevision()).toBe(0);
      expect(store.messages.getHistoryDelta(0, 10).messages).toEqual([]);
      store.messages.appendRelatedRecord(2, call);
      const delta = store.messages.getHistoryDelta(0, 10);
      expect(delta.messages.map(({ id }) => id)).toEqual([2]);
      expect(store.messages.recordsForMessages(delta.messages).map(({ kind }) => kind)).toEqual(["note", "call"]);
    });
  });

  it("keeps the default wire unchanged and pages complete mixed legacy/typed groups", async () => {
    const stub = await initProcess("history-sync-snapshot", ROOT_IDENTITY);
    await runInProcess(stub, (process: Process) => {
      process.store.messages.appendMessage("assistant", "Legacy", {
        legacy: true,
        toolCalls: JSON.stringify([{ type: "toolCall", id: "call:legacy", name: "Read", arguments: { path: "/legacy" } }]),
      });
      process.store.messages.appendMessage("assistant", "Working", { records: [note, call] });
    });
    const legacy = await runInProcess(stub, (process: Process) => process.controller.handleProcHistory({ limit: 1 }));
    expect(legacy.ok).toBe(true);
    expect(legacy).not.toHaveProperty("format");
    expect(legacy).not.toHaveProperty("records");
    expect(legacy).not.toHaveProperty("cursor");
    const first = await history(stub, { limit: 1 });
    expect(first.messages).toEqual(legacy.ok ? legacy.messages : []);
    expect(first.records.map(({ kind, messageId, index, source }) => ({ kind, messageId, index, source })))
      .toEqual([
        { kind: "note", messageId: 1, index: 0, source: "legacy" },
        { kind: "call", messageId: 1, index: 1, source: "legacy" },
      ]);
    expect(first.records[0]!.id).toBe(first.records[1]!.id);
    const tail = await history(stub, { tail: true, limit: 1 });
    expect(tail.messages).toHaveLength(1);
    expect(tail.records.map(({ kind }) => kind)).toEqual(["note", "call"]);
    expect(new Set(tail.records.map(({ messageId }) => messageId)).size).toBe(1);
    expect(tail.messageCount).toBe(2);
    expect(tail.hasMoreBefore).toBe(true);
    expect(tail.reset).toBe(false);
  });

  it("survives eviction and returns late companions plus asynchronous media updates as group replacements", async () => {
    const stub = await initProcess("history-sync-late", ROOT_IDENTITY);
    const parentId = await runInProcess(stub, (process: Process) => (
      process.store.messages.appendMessage("assistant", "Working", { records: [note, call], runId: "run:one" })
    ));
    const baseline = await history(stub, { tail: true });
    await evictDurableObject(stub);
    await runInProcess(stub, (process: Process) => {
      process.store.messages.appendRelatedRecord(parentId, outgoing);
      process.store.messages.updateMessageMedia(parentId, "run:one", JSON.stringify([
        { type: "audio", mimeType: "audio/ogg", transcription: "Prepared later" },
      ]));
    });
    const updated = await history(stub, { since: cursor(baseline), limit: 1 });
    expect(updated.messages.map(({ id }) => id)).toEqual([parentId]);
    expect(updated.records.map(({ kind }) => kind)).toEqual(["note", "call", "message"]);
    expect(updated.records[0]?.payload).toMatchObject({ media: [{ transcription: "Prepared later" }] });
    expect(updated.records.every(({ messageId }) => messageId === parentId)).toBe(true);
    expect(updated.historyRevision).toBeGreaterThan(baseline.historyRevision);
    expect(updated.hasMore).toBe(false);
    await evictDurableObject(stub);
    expect((await history(stub, { since: cursor(updated) })).records).toEqual([]);
    await runInProcess(stub, (process: Process) => process.store.messages.clearMessageMedia(parentId, "run:one"));
    const cleared = await history(stub, { since: cursor(updated) });
    expect(cleared.records[0]?.payload).toMatchObject({ media: [] });
    expect(cleared.records).toHaveLength(3);
  });

  it("pages revisions without dropping an older parent that changes between delta pages", async () => {
    const stub = await initProcess("history-sync-delta-pages", ROOT_IDENTITY);
    const ids = await runInProcess(stub, (process: Process) => [
      process.store.messages.appendMessage("assistant", "First", { record: note, runId: "run:one" }),
      process.store.messages.appendMessage("assistant", "Second", { record: note, runId: "run:one" }),
      process.store.messages.appendMessage("assistant", "Third", { record: note, runId: "run:one" }),
    ]);
    const initial = await history(stub);
    await runInProcess(stub, (process: Process) => {
      // Deliberately reverse parent order to exercise arbitrary-id companion selection.
      process.store.messages.appendRelatedRecord(ids[2]!, call);
      process.store.messages.appendRelatedRecord(ids[0]!, outgoing);
    });
    const page = await history(stub, { since: cursor(initial), limit: 1 });
    expect(page.records.map(({ messageId }) => messageId)).toEqual([ids[2], ids[2]]);
    expect(page.hasMore).toBe(true);
    await runInProcess(stub, (process: Process) => {
      process.store.messages.appendRelatedRecord(ids[2]!, outgoing);
      process.store.messages.appendRelatedRecord(ids[1]!, call);
    });
    const rest = await history(stub, { since: cursor(page), limit: 3 });
    expect(rest.messages.map(({ id }) => id)).toEqual(ids);
    expect(rest.records.filter(({ messageId }) => messageId === ids[0]).map(({ kind }) => kind)).toEqual(["note", "message"]);
    expect(rest.records.filter(({ messageId }) => messageId === ids[2]).map(({ kind }) => kind)).toEqual(["note", "call", "message"]);
    expect(rest.records.filter(({ messageId }) => messageId === ids[1]).map(({ kind }) => kind)).toEqual(["note", "call"]);
    expect(rest.hasMore).toBe(false);
    expect((await history(stub, { since: cursor(rest) })).records).toEqual([]);
  });

  it("keeps older/status reads from advancing the head cursor or exposing status-only records", async () => {
    const stub = await initProcess("history-sync-historical-pages", ROOT_IDENTITY);
    const ids = await runInProcess(stub, (process: Process) => [
      process.store.messages.appendMessage("user", "One"),
      process.store.messages.appendMessage("user", "Two"),
    ]);
    const initial = await history(stub, { tail: true, limit: 1 });
    await runInProcess(stub, (process: Process) => process.store.messages.appendRelatedRecord(ids[1]!, outgoing));
    for (const args of [{ beforeMessageId: ids[1] }, { afterMessageId: ids[0] }, { offset: 0 }]) {
      const page = await history(stub, args);
      expect(page.cursor).toBeUndefined();
      expect(page.historyRevision).toBeGreaterThan(initial.historyRevision);
      expect(page.historyGeneration).toBe(initial.historyGeneration);
      expect(page.historyResetRevision).toBe(initial.historyResetRevision);
    }
    const status = await history(stub, { includeMessages: false });
    expect(status.messages).toEqual([]);
    expect(status.records).toEqual([]);
    expect(status.cursor).toBeUndefined();
    expect((await history(stub, { since: cursor(initial) })).records.map(({ kind }) => kind)).toEqual(["message", "message"]);
  });

  it("requires a fresh snapshot after compaction reuses the first parent id", async () => {
    const stub = await initProcess("history-sync-compaction", ROOT_IDENTITY);
    const ids = await runInProcess(stub, (process: Process) => [
      process.store.messages.appendMessage("user", "One"),
      process.store.messages.appendMessage("assistant", "Two", { records: [note, call] }),
      process.store.messages.appendMessage("user", "Three"),
    ]);
    const initial = await history(stub);
    await runInProcess(stub, (process: Process) => process.store.history.compactHistoryPrefix({
      generation: process.store.state.getHistoryGeneration(),
      fromMessageId: ids[0]!, toMessageId: ids[1]!, summary: "A summary",
      record: { kind: "event", payload: { kind: "legacy", severity: "info", audience: "model", payload: { text: "A summary" } } },
    }));
    await evictDurableObject(stub);
    const reset = await history(stub, { since: cursor(initial), limit: 10 });
    expect(reset.reset).toBe(true);
    expect(reset.historyGeneration).toBe(initial.historyGeneration);
    expect(reset.historyResetRevision).toBeGreaterThan(initial.historyRevision);
    expect(reset.messages.map(({ id }) => id)).toEqual([ids[0], ids[2]]);
    expect(reset.records.map(({ kind }) => kind)).toEqual(["event", "message"]);
    expect((await history(stub, { since: cursor(reset) })).reset).toBe(false);
  });

  it("invalidates cursors for context-owned deletions and reset even when the next history is empty", async () => {
    const stub = await initProcess("history-sync-deletions", ROOT_IDENTITY);
    const id = await runInProcess(stub, (process: Process) => process.store.messages.appendMessage("user", "Owned"));
    const initial = await history(stub);
    await runInProcess(stub, (process: Process) => {
      process.store.epochs.createContextEpoch({
        id: "epoch:one", generation: 1, systemPrompt: "Synthetic prompt", r12yRevision: 0,
        r12yCount: 0, r12yBaseline: [], sourceManifest: {}, observedProjection: {}, now: 1,
      });
      process.store.sql.exec("INSERT INTO context_epoch_message_refs (epoch_id, message_id, kind, created_at) VALUES ('epoch:one', ?, 'context.changed', 1)", id);
      process.store.epochs.deleteContextEpochOwnedMessages("epoch:one");
    });
    const emptied = await history(stub, { since: cursor(initial) });
    expect(emptied).toMatchObject({ reset: true, records: [], messages: [], messageCount: 0 });
    await runInProcess(stub, (process: Process) => process.store.resetHistory());
    await evictDurableObject(stub);
    const reset = await history(stub, { since: cursor(emptied) });
    expect(reset.reset).toBe(true);
    expect(reset.historyGeneration).toBe(emptied.historyGeneration + 1);
    expect(reset.historyRevision).toBeGreaterThan(emptied.historyRevision);
    expect(reset.records).toEqual([]);
    expect((await history(stub, { since: cursor(reset) })).reset).toBe(false);
  });

  it("rejects malformed, wrong-process, future, and incompatible cursors", async () => {
    const pid = "history-sync-invalid";
    const stub = await initProcess(pid, ROOT_IDENTITY);
    const initial = await history(stub);
    const bad: ProcHistoryArgs[] = [
      { since: "" }, { since: "h2:any:1:0" }, { since: `h1:${pid}:1:01` },
      { since: historyCursor("another-process", initial.historyGeneration, initial.historyRevision) },
      { since: historyCursor(pid, initial.historyGeneration + 1, initial.historyRevision) },
      { since: historyCursor(pid, initial.historyGeneration, initial.historyRevision + 1) },
      { since: `h1:${pid}:1:9007199254740992` },
      { since: cursor(initial), tail: true }, { since: cursor(initial), offset: 0 },
      { since: cursor(initial), beforeMessageId: 1 }, { since: cursor(initial), afterMessageId: 1 },
      { since: cursor(initial), includeMessages: false }, { limit: 1001 },
    ];
    await runInProcess(stub, async (process: Process) => {
      for (const args of bad) expect(await process.controller.handleProcHistory({ format: 2, ...args })).toMatchObject({ ok: false });
      expect(await process.controller.handleProcHistory({ since: cursor(initial) })).toMatchObject({ ok: false });
    });
  });

  it("includes the current durable revision in observational change signals", async () => {
    const stub = await initProcess("history-sync-signal", ROOT_IDENTITY);
    await runInProcess(stub, async (process: Process) => {
      process.store.messages.appendMessage("user", "A change");
      const send = vi.spyOn(process, "sendSignal").mockResolvedValue(undefined);
      await process.signals.changed(["messages"]);
      expect(send).toHaveBeenCalledWith("proc.changed", expect.objectContaining({
        historyRevision: process.store.state.getHistoryRevision(),
        historyGeneration: process.store.state.getHistoryGeneration(),
        historyResetRevision: process.store.state.getHistoryResetRevision(),
      }));
    });
  });

  it("validates typed history at the generated wire boundary", async () => {
    expect(decodeWireFrameJson(JSON.stringify({
      type: "req", id: "history:request", call: "proc.history", args: { format: 2, since: "opaque" },
    }))).toMatchObject({ args: { format: 2, since: "opaque" } });
    for (const args of [{ format: 3 }, { format: 2, since: 1 }]) {
      expect(() => decodeWireFrameJson(JSON.stringify({
        type: "req", id: "history:request", call: "proc.history", args,
      }))).toThrow("Invalid proc.history arguments");
    }
    const stub = await initProcess("history-sync-wire", ROOT_IDENTITY);
    await runInProcess(stub, (process: Process) => process.store.messages.appendMessage("system", "A notice", {
      record: { kind: "event", payload: { kind: "generation.failed", severity: "error", audience: "both", payload: { reason: "generation.empty", error: "No output" } } },
    }));
    const result = await history(stub);
    const malformed = {
      ...result,
      records: [{ ...result.records[0], payload: {
        kind: "generation.failed", severity: "error", audience: "both", payload: { text: "Missing required structured data" },
      } }],
    };
    expect(() => decodeWireResponse("proc.history", {
      type: "res", id: "history:fixture", ok: true,
      data: jsonValueSchema.parse(JSON.parse(JSON.stringify(malformed))),
    })).toThrow("Invalid proc.history response");
  });
});
