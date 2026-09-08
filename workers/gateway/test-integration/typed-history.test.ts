import { describe, expect, it } from "vitest";
import {
  procHistoryRecordSchema,
  type ProcHistoryArgs,
  type ProcHistoryRecordsResult,
} from "@humansandmachines/gsv/protocol";
import {
  startProcessRuntimeHarness,
  type ProcessRuntimeHarness,
} from "./process-runtime-harness";

async function history(runtime: ProcessRuntimeHarness, args: ProcHistoryArgs): Promise<ProcHistoryRecordsResult> {
  const result = await runtime.client.proc.history({ ...args, format: 2 });
  if (!result.ok) throw new Error(result.error);
  if (result.format !== 2) throw new Error("Gateway did not return typed history");
  for (const record of result.records) expect(procHistoryRecordSchema.parse(record)).toEqual(record);
  return result;
}

function cursor(result: ProcHistoryRecordsResult): string {
  if (!result.cursor) throw new Error("Gateway omitted the history synchronization cursor");
  return result.cursor;
}

describe("typed history authenticated wire integration", () => {
  it("pages complete typed groups, rejects internal event injection, and fences reset cursors", async () => {
    const runtime = await startProcessRuntimeHarness();
    try {
      const process = await runtime.spawn("typed history wire journey");
      await runtime.configureAi(process.pid);
      const empty = await history(runtime, { pid: process.pid, tail: true });
      expect(empty).toMatchObject({ records: [], messageCount: 0, reset: false, hasMore: false });
      await expect(runtime.client.request("proc.event.deliver", {
        pid: process.pid, eventId: "public-injection",
        event: { kind: "runtime.wake", payload: { source: "process", reason: "public injection" }, severity: "info", audience: "person" },
      })).rejects.toMatchObject({ code: 400, message: "Invalid proc.event.deliver arguments" });
      expect((await history(runtime, { pid: process.pid, since: cursor(empty) })).records).toEqual([]);

      const path = "/tmp/typed-history-wire.txt";
      await runtime.client.fs.write({ path, content: "typed wire fixture" });
      runtime.ai.enqueue({ kind: "tool-calls", calls: [{ id: "typed-read", name: "Read", arguments: { path } }] });
      const held = runtime.ai.hold({ kind: "message", text: "Committed typed reply" });
      const sent = await runtime.client.proc.send({ pid: process.pid, message: "Read the typed fixture." });
      if (!sent.ok) throw new Error(sent.error);
      await held.started;
      const pending = await history(runtime, { pid: process.pid, tail: true });
      expect(pending.activeRunId).toBe(sent.runId);
      const call = pending.records.find((record) => record.kind === "call");
      expect(call).toMatchObject({ kind: "call", payload: {
        callId: "typed-read", tool: "Read", syscall: "fs.read", args: { path }, runId: sent.runId,
      } });
      if (!call) throw new Error("Read call was not committed before the next generation");
      const older = await history(runtime, { pid: process.pid, afterMessageId: call.messageId - 1, limit: 1 });
      expect(older.cursor).toBeUndefined();
      expect(older.records.map(({ kind }) => kind)).toEqual(["note", "call"]);
      expect(older.records.every(({ messageId }) => messageId === call.messageId)).toBe(true);
      expect(pending.records).toContainEqual(expect.objectContaining({
        kind: "result", payload: expect.objectContaining({ callId: "typed-read", outcome: "completed" }),
      }));

      held.release();
      await runtime.waitFor(() => runtime.signals.some(({ signal, payload }) =>
        signal === "proc.run.finished" && payload.runId === sent.runId
      ), "typed history run to finish");
      let installed = [...pending.records];
      let nextCursor = cursor(pending);
      let page: ProcHistoryRecordsResult;
      do {
        page = await history(runtime, { pid: process.pid, since: nextCursor, limit: 1 });
        expect(page.reset).toBe(false);
        expect(page.historyGeneration).toBe(pending.historyGeneration);
        expect(page.historyRevision).toBeGreaterThan(pending.historyRevision);
        const groups = new Set(page.records.map(({ messageId }) => messageId));
        expect(groups.size).toBeLessThanOrEqual(1);
        installed = installed.filter(({ messageId }) => !groups.has(messageId)).concat(page.records);
        nextCursor = cursor(page);
      } while (page.hasMore);
      const complete = await history(runtime, { pid: process.pid, tail: true });
      installed.sort((left, right) => left.messageId - right.messageId || left.index - right.index);
      expect(installed).toEqual(complete.records);
      expect(complete.records).toContainEqual(expect.objectContaining({
        kind: "call", payload: expect.objectContaining({ tool: "Shell", syscall: null }),
      }));
      expect(complete.records).toContainEqual(expect.objectContaining({
        kind: "result", payload: expect.objectContaining({ tool: "Shell", outcome: "completed", output: {
          action: "message", finish: true, delivery: expect.any(Object),
        } }),
      }));
      expect(complete.records.find((record) => record.kind === "message" && record.payload.direction === "out"))
        .toMatchObject({ kind: "message", payload: {
          text: "Committed typed reply", conversationId: expect.any(String), conversationMessageId: expect.any(String),
        } });
      expect((await history(runtime, { pid: process.pid, since: nextCursor })).records).toEqual([]);
      const conversation = await runtime.client.conversation.forProcess({ pid: process.pid });
      const canonical = await runtime.client.conversation.history({ conversationId: conversation.conversation.id });
      expect(canonical.messages.at(-1)?.text).toBe("Committed typed reply");
      const legacy = await runtime.client.proc.history({ pid: process.pid });
      expect(legacy).not.toHaveProperty("format");
      expect(legacy).not.toHaveProperty("records");
      expect(await runtime.client.proc.reset({ pid: process.pid })).toMatchObject({ ok: true });
      const reset = await history(runtime, { pid: process.pid, since: cursor(complete) });
      expect(reset).toMatchObject({ reset: true, records: [], messages: [], messageCount: 0 });
      expect(reset.historyGeneration).toBe(complete.historyGeneration + 1);
      expect(reset.historyRevision).toBeGreaterThan(complete.historyRevision);
      expect((await history(runtime, { pid: process.pid, since: cursor(reset) })).reset).toBe(false);
      expect((await runtime.client.conversation.history({ conversationId: conversation.conversation.id })).messages)
        .toEqual(canonical.messages);
    } finally {
      await runtime.close();
    }
  });

  it("delivers watched target lifecycle notices without starting a person-only model run", async () => {
    const runtime = await startProcessRuntimeHarness();
    try {
      const targetId = "typed-history-machine";
      const machine = await runtime.connectMachine(targetId);
      await runtime.client.sys.target.update({ targetId, label: "Fixture computer" });
      const process = await runtime.spawn("target watch wire journey");
      await runtime.configureAi(process.pid);
      const input = `signal watch --json '${JSON.stringify({ signal: "target.status", targetId, key: "wire-target", once: false })}'`;
      runtime.ai.enqueue(
        { kind: "tool-calls", calls: [{ id: "watch-target", name: "CodeMode", arguments: {
          code: `return await shell(${JSON.stringify(input)});`,
        } }] },
        { kind: "message", text: "Watching the target." },
      );
      const sent = await runtime.client.proc.send({ pid: process.pid, message: "Watch this target." });
      if (!sent.ok) throw new Error(sent.error);
      await runtime.waitFor(() => runtime.signals.some(({ signal, payload }) =>
        payload.runId === sent.runId && (signal === "proc.run.hil.requested" || signal === "proc.run.finished")
      ), "watch registration approval or completion");
      const waiting = await history(runtime, { pid: process.pid });
      if (waiting.pendingHil) {
        expect(waiting.pendingHil).toMatchObject({ syscall: "shell.exec", args: { input } });
        await runtime.client.proc.hil({ pid: process.pid, requestId: waiting.pendingHil.requestId, decision: "approve" });
      }
      await runtime.waitFor(() => runtime.signals.some(({ signal, payload }) =>
        signal === "proc.run.finished" && payload.runId === sent.runId
      ), "target watch registration run");
      const baseline = await history(runtime, { pid: process.pid, tail: true });
      expect(baseline.records).toContainEqual(expect.objectContaining({ kind: "result", payload: expect.objectContaining({
        callId: "watch-target", outcome: "completed", output: expect.any(Object),
      }) }));
      const generations = runtime.ai.requests.length;
      machine.close();
      await runtime.waitFor(async () => (await history(runtime, { pid: process.pid, since: cursor(baseline) })).records.some((record) =>
        record.kind === "event" && record.payload.kind === "target.connection"
      ), "typed target disconnection notice");
      const disconnected = await history(runtime, { pid: process.pid, since: cursor(baseline) });
      expect(disconnected.activeRunId).toBeNull();
      expect(disconnected.records).toHaveLength(1);
      expect(disconnected.records[0]).toMatchObject({ kind: "event", runId: null, payload: {
        kind: "target.connection", severity: "info", audience: "person", payload: {
          targetId, event: "disconnected", label: "Fixture computer", platform: "linux", version: "fixture-machine", observedAt: expect.any(Number),
        },
      } });
      await machine.connect();
      await runtime.waitFor(async () => (await history(runtime, { pid: process.pid, since: cursor(disconnected) })).records.some((record) =>
        record.kind === "event" && record.payload.kind === "target.connection" && record.payload.payload.event === "connected"
      ), "typed target reconnection notice");
      const connected = await history(runtime, { pid: process.pid, since: cursor(disconnected) });
      expect(connected.records).toHaveLength(1);
      expect(connected.records[0]).toMatchObject({ kind: "event", runId: null, payload: {
        kind: "target.connection", audience: "person", payload: { targetId, event: "connected" },
      } });
      expect(connected.activeRunId).toBeNull();
      expect(runtime.ai.requests).toHaveLength(generations);
      expect((await history(runtime, { pid: process.pid, since: cursor(connected) })).records).toEqual([]);
    } finally {
      await runtime.close();
    }
  });

});
