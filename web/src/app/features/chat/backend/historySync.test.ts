import { describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/preact-query";
import type { GSVClient } from "@humansandmachines/gsv/client";
import { procHistoryRecordSchema, type ProcHistoryArgs, type ProcHistoryRecord, type ProcHistoryRecordsResult, type ProcHistoryResult } from "@humansandmachines/gsv/protocol";
import { ProcessHistorySync, processHistoryKey, type SyncedChatHistory } from "./historySync";

function record(messageId: number, text = String(messageId), index = 0): ProcHistoryRecord {
  return procHistoryRecordSchema.parse({ id: messageId, messageId, index, generation: 1, runId: null, createdAt: messageId, source: "typed", kind: "message", payload: { direction: "in", text, media: [], origin: {} } });
}
function page(records: ProcHistoryRecord[], revision: number, extra: Partial<ProcHistoryRecordsResult> = {}): ProcHistoryRecordsResult {
  return { ok: true, pid: "p", format: 2, messages: [], records, messageCount: records.length, historyRevision: revision, historyGeneration: 1, historyResetRevision: 0, cursor: `c${revision}`, reset: false, hasMore: false, ...extra };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function harness(replies: Array<ProcHistoryResult | Promise<ProcHistoryResult>>) {
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let onSignal: Parameters<GSVClient["onSignal"]>[0] = () => {};
  let onStatus: Parameters<GSVClient["onStatus"]>[0] = () => {};
  const history = vi.fn(async (_args?: ProcHistoryArgs): Promise<ProcHistoryResult> => {
    const reply = replies.shift();
    if (!reply) throw new Error("Unexpected history request");
    return await reply;
  });
  const client = {
    proc: { history: Object.assign(history, { compact: vi.fn(), segments: vi.fn(), segment: { read: vi.fn() } }), observe: vi.fn(async () => ({ ok: true as const, pid: "p", observing: true as const })), unobserve: vi.fn(async () => ({ ok: true as const, pid: "p", observing: false as const })) },
    onSignal: ((listener) => { onSignal = listener; return () => {}; }) satisfies GSVClient["onSignal"],
    onStatus: ((listener) => { onStatus = listener; return () => {}; }) satisfies GSVClient["onStatus"],
  };
  const sync = new ProcessHistorySync(client, queries);
  return { sync, history, client, emit: (...args: Parameters<typeof onSignal>) => onSignal(...args), status: (...args: Parameters<typeof onStatus>) => onStatus(...args), current: () => queries.getQueryData<SyncedChatHistory>(processHistoryKey("p"))! };
}

describe("shared typed process history synchronization", () => {
  it("reconciles a signal received during the initial snapshot using its returned cursor", async () => {
    const first = deferred<ProcHistoryResult>();
    const h = harness([first.promise, page([record(2)], 2)]);
    h.sync.retain("p", 50, false);
    const read = h.sync.read("p");
    await vi.waitFor(() => expect(h.history).toHaveBeenCalledTimes(1));
    h.emit("proc.changed", { pid: "p", changes: ["messages"], historyRevision: 2, historyGeneration: 1, historyResetRevision: 0 });
    first.resolve(page([record(1)], 1));
    await read;
    expect(h.history.mock.calls.map(([args]) => args)).toEqual([
      { pid: "p", limit: 50, tail: true, format: 2 },
      { pid: "p", limit: 50, since: "c1", format: 2 },
    ]);
    expect(h.current().records.map((row) => row.messageId)).toEqual([1, 2]);
  });

  it("drains delta pages and replaces complete groups for late companions and media", async () => {
    const note = procHistoryRecordSchema.parse({ ...record(1), runId: "r", kind: "note", payload: { text: "working", thinking: [], media: [] } });
    const outgoing = procHistoryRecordSchema.parse({ ...record(1, "sent", 1), payload: { direction: "out", text: "sent", media: [{ type: "image", mimeType: "image/png", key: "k" }], origin: {} } });
    const h = harness([page([note], 1), page([note, outgoing], 3, { hasMore: true }), page([record(2)], 4)]);
    h.sync.retain("p", 50, false);
    await h.sync.read("p");
    h.emit("proc.changed", { pid: "p", changes: ["messages"], historyRevision: 4 });
    await h.sync.read("p");
    expect(h.history.mock.calls.slice(1).map(([args]) => args?.since)).toEqual(["c1", "c3"]);
    expect(h.current().records.map((row) => [row.messageId, row.index])).toEqual([[1, 0], [1, 1], [2, 0]]);
    expect(h.current().runtime.rows.find((row) => row.messageDirection === "out")?.media).toHaveLength(1);
    expect(h.current().cursor).toBe("c4");
  });

  it("discards an in-flight old delta on reset and rejects late output from the retired run", async () => {
    const old = deferred<ProcHistoryResult>();
    const h = harness([page([record(1)], 1, { activeRunId: "old" }), old.promise, page([], 3, { historyGeneration: 2, historyResetRevision: 3, reset: true })]);
    h.sync.retain("p", 50, false);
    await h.sync.read("p");
    const pending = h.sync.read("p");
    await vi.waitFor(() => expect(h.history).toHaveBeenCalledTimes(2));
    h.emit("proc.changed", { pid: "p", changes: ["messages"], historyGeneration: 2, historyResetRevision: 3, historyRevision: 3 });
    expect(h.current().records).toEqual([]);
    old.resolve(page([record(2)], 2));
    await pending;
    h.emit("proc.run.stream", { pid: "p", runId: "old", event: { type: "text_delta", delta: "stale", contentIndex: 0 } });
    expect(h.current().records).toEqual([]);
    expect(h.current().runtime.rows).toEqual([]);
    expect(h.history.mock.calls[2][0]?.tail).toBe(true);
  });

  it("keeps a historical page away from the head cursor and fills missing call source data", async () => {
    const result = procHistoryRecordSchema.parse({ ...record(2), runId: "r", kind: "result", payload: { callId: "call", tool: "Shell", outcome: "completed", output: "done", media: [], resources: [] } });
    const call = procHistoryRecordSchema.parse({ ...record(1), runId: "r", kind: "call", payload: { runId: "r", callId: "call", tool: "Shell", syscall: "shell.exec", target: "laptop", args: { input: "pwd" } } });
    const h = harness([page([result], 2, { hasMoreBefore: true }), page([call], 2, { cursor: undefined })]);
    await h.sync.read("p");
    await h.sync.loadOlder("p", 2, 50);
    expect(h.current().cursor).toBe("c2");
    expect(h.current().runtime.rows).toEqual([expect.objectContaining({ role: "toolResult", toolSyscall: "shell.exec", toolTarget: "laptop", toolArgs: { input: "pwd" } })]);
    expect(h.history.mock.calls[1][0]).toEqual({ pid: "p", beforeMessageId: 2, limit: 50, format: 2 });
  });

  it("shares observation and reconnects with one snapshot for multiple surfaces", async () => {
    const h = harness([page([record(1)], 1), page([record(2)], 2)]);
    const releaseChat = h.sync.retain("p", 50, true);
    const releaseZen = h.sync.retain("p", 50, true);
    await Promise.all([h.sync.read("p"), h.sync.read("p")]);
    expect(h.client.proc.observe).toHaveBeenCalledTimes(1);
    h.status({ state: "disconnected", url: null, username: null, connectionId: null, message: null });
    h.status({ state: "connected", url: null, username: null, connectionId: null, message: null });
    await h.sync.read("p");
    expect(h.history).toHaveBeenCalledTimes(2);
    expect(h.history.mock.calls[1][0]?.tail).toBe(true);
    releaseChat();
    expect(h.client.proc.unobserve).not.toHaveBeenCalled();
    releaseZen();
    expect(h.client.proc.unobserve).toHaveBeenCalledTimes(1);
  });

  it.each(["reconnect", "larger window"])("preserves an active stream across a same-epoch %s snapshot", async (reason) => {
    const snapshot = deferred<ProcHistoryResult>();
    const h = harness([page([], 1, { activeRunId: "r" }), snapshot.promise]);
    h.sync.retain("p", 50, false);
    await h.sync.read("p");
    h.emit("proc.run.stream", { pid: "p", runId: "r", event: { type: "text_delta", delta: "before ", contentIndex: 0 } });
    if (reason === "reconnect") {
      h.status({ state: "disconnected", url: null, username: null, connectionId: null, message: null });
      h.status({ state: "connected", url: null, username: null, connectionId: null, message: null });
    } else {
      h.sync.retain("p", 400, false);
    }
    const pending = h.sync.read("p", reason === "larger window" ? 400 : 50);
    await vi.waitFor(() => expect(h.history).toHaveBeenCalledTimes(2));
    h.emit("proc.run.stream", { pid: "p", runId: "r", event: { type: "text_delta", delta: "during", contentIndex: 0 } });
    snapshot.resolve(page([], 1, { activeRunId: "r" }));
    await pending;
    expect(h.history.mock.calls[1][0]?.tail).toBe(true);
    expect(h.current().runtime.rows).toEqual([expect.objectContaining({ text: "before during", streaming: true, runId: "r" })]);
  });

  it("discards an existing raw stream when the snapshot closes its history epoch", async () => {
    const h = harness([page([], 1, { activeRunId: "r" }), page([], 2, { historyGeneration: 2, historyResetRevision: 2, reset: true })]);
    h.sync.retain("p", 50, false);
    await h.sync.read("p");
    h.emit("proc.run.stream", { pid: "p", runId: "r", event: { type: "text_delta", delta: "discard me", contentIndex: 0 } });
    expect(h.current().runtime.rows).toHaveLength(1);
    await h.sync.read("p", 400);
    expect(h.current().runtime.rows).toEqual([]);
    h.emit("proc.run.stream", { pid: "p", runId: "r", event: { type: "text_delta", delta: "late", contentIndex: 0 } });
    expect(h.current().runtime.rows).toEqual([]);
  });

  it("reconciles changes missed while a surface was closed when it reopens", async () => {
    const h = harness([page([record(1)], 1), page([record(2)], 2)]);
    const close = h.sync.retain("p", 50, false);
    await h.sync.read("p");
    close();
    h.emit("proc.changed", { pid: "p", changes: ["messages"], historyRevision: 2 });
    expect(h.history).toHaveBeenCalledTimes(1);
    h.sync.retain("p", 50, false);
    await h.sync.read("p");
    expect(h.history.mock.calls[1][0]?.since).toBe("c1");
    expect(h.current().records.map((row) => row.messageId)).toEqual([1, 2]);
  });

  it("rejects historical pages from an obsolete generation", async () => {
    const h = harness([
      page([record(4)], 4, { historyGeneration: 2, historyResetRevision: 3 }),
      page([record(1)], 2, { cursor: undefined }),
      page([record(4), record(5)], 5, { historyGeneration: 2, historyResetRevision: 3 }),
    ]);
    await h.sync.read("p");
    await h.sync.loadOlder("p", 4, 50);
    expect(h.current().records.map((row) => row.messageId)).toEqual([4, 5]);
    expect(h.current().cursor).toBe("c5");
    expect(h.history.mock.calls[2][0]?.tail).toBe(true);
  });

  it("keeps an executing tool live while a typed call delta supplies its exact target", async () => {
    const call = procHistoryRecordSchema.parse({ ...record(1), runId: "r", kind: "call", payload: { runId: "r", callId: "c", tool: "Shell", syscall: "shell.exec", target: "laptop", args: { input: "pwd" } } });
    const h = harness([page([], 0, { activeRunId: "r" }), page([call], 1, { activeRunId: "r" })]);
    h.sync.retain("p", 50, false);
    await h.sync.read("p");
    h.emit("proc.run.tool.started", { pid: "p", runId: "r", callId: "c", toolName: "Shell", syscall: "shell.exec", args: { input: "pwd" } });
    await h.sync.read("p");
    expect(h.current().runtime.rows).toEqual([expect.objectContaining({ role: "tool", status: "running", toolTarget: "laptop", toolSyscall: "shell.exec" })]);
  });

  it("reports older gateways explicitly without accepting their compatibility messages", async () => {
    const h = harness([{ ok: true, pid: "p", messages: [], messageCount: 0 }]);
    await expect(h.sync.read("p")).rejects.toThrow("does not support typed process history");
    expect(h.current()).toBeUndefined();
  });
});
