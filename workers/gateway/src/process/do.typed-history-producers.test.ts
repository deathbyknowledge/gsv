import { describe, expect, it, vi } from "vitest";
import type { ProcHistoryRecord } from "@humansandmachines/gsv/protocol";
import {
  initProcess,
  ROOT_IDENTITY,
  runInProcess,
  testUsage,
  assistantResponse,
} from "./do-test-harness";
import { classifyAssistantTurn } from "./run-tick-policy";

describe("typed history producers", () => {
  it("retains source JSON, resources, and all tool outcomes without parsing display text", async () => {
    const stub = await initProcess("typed-history-tools", ROOT_IDENTITY);
    await runInProcess(stub, async (process) => {
      const resource = {
        type: "resource",
        ref: {
          type: "file",
          target: "gsv",
          path: "/root/result.txt",
          revision: "revision-1",
          contentType: "text/plain",
          size: 4,
        },
      };
      const source = { ok: true, count: 2, content: [resource] };
      const runId = "typed-tools-run";
      process.tools.recordToolResults(runId, [
        { id: "json", dispatchId: "d1", call: "fs.read", args: {}, status: "completed", result: source, error: null, outcome: "completed" },
        { id: "text", dispatchId: "d2", call: "shell.exec", args: {}, status: "completed", result: '{"count":2}', error: null, outcome: "completed" },
        { id: "failed", dispatchId: "d3", call: "fs.read", args: {}, status: "error", result: null, error: "read failed", outcome: "failed" },
        { id: "denied", dispatchId: "d4", call: "fs.delete", args: {}, status: "error", result: null, error: "approval denied", outcome: "denied" },
        { id: "cancelled", dispatchId: "d5", call: "shell.exec", args: {}, status: "pending", result: null, error: null, outcome: null },
      ], { interruptPending: "run superseded" });
      const records: ProcHistoryRecord[] = process.store.messages.getRecords();
      expect(records.map((record) => record.payload)).toEqual([
        { callId: "json", tool: "Read", outcome: "completed", output: source, media: [], resources: [resource] },
        { callId: "text", tool: "Shell", outcome: "completed", output: '{"count":2}', media: [], resources: [] },
        { callId: "failed", tool: "Read", outcome: "failed", output: null, media: [], resources: [], error: { message: "read failed" } },
        { callId: "denied", tool: "Delete", outcome: "denied", output: null, media: [], resources: [], error: { message: "approval denied" } },
        { callId: "cancelled", tool: "Shell", outcome: "cancelled", output: null, media: [], resources: [], error: { message: "run superseded" } },
      ]);
      expect(process.store.messages.getMessages().map((message: { content: string }) => message.content)).toEqual([
        JSON.stringify(source), '{"count":2}', "Error: read failed", "Error: approval denied", "Error: run superseded",
      ]);
    });
  });

  it("writes assistant records from classified calls and retains their original arguments", async () => {
    const stub = await initProcess("typed-history-assistant", ROOT_IDENTITY);
    await runInProcess(stub, async (process) => {
      const runId = "typed-assistant-run";
      process.runs.active = { runId };
      process.tools.rememberShellSessionTargetFromResult("shell.exec", { target: "laptop" }, { sessionId: "session-1" });
      const turn = classifyAssistantTurn(assistantResponse([
        { type: "text", text: "draft" },
        { type: "thinking", thinking: "reasoning", thinkingSignature: "thinking-signature" },
        { type: "toolCall", id: "send", name: "Send", arguments: { text: "message" } },
        { type: "toolCall", id: "yield", name: "Shell", arguments: { input: "yield", target: "gsv" } },
        { type: "toolCall", id: "session", name: "Shell", arguments: { sessionId: "session-1" }, thoughtSignature: "call-signature" },
      ]), ["Send", "Shell"]);
      process.run.persistRunTickAssistantHistory(runId, turn, [], undefined);
      const records: ProcHistoryRecord[] = process.store.messages.getRecords();
      expect(records[0]).toMatchObject({
        kind: "note", payload: { text: "draft", thinking: [{ type: "thinking", thinking: "reasoning", thinkingSignature: "thinking-signature" }] },
      });
      expect(records.filter((record) => record.kind === "call").map((record) => record.payload)).toEqual([
        { callId: "send", tool: "Send", syscall: null, args: { text: "message" }, target: null, runId },
        { callId: "yield", tool: "Shell", syscall: null, args: { input: "yield", target: "gsv" }, target: null, runId },
        { callId: "session", tool: "Shell", syscall: "shell.exec", args: { sessionId: "session-1" }, target: "laptop", runId, thoughtSignature: "call-signature" },
      ]);
      const source = process.store.messages.getMessages()[0];
      expect(source.content).toBe("draft");
      expect(JSON.parse(source.toolCalls)).toEqual({ thinking: turn.thinking, toolCalls: turn.returnedToolCalls });
      process.runs.active = null;
    });
  });

  it("records native routing defaults without inventing targets for unresolved sessions or CodeMode", async () => {
    const stub = await initProcess("typed-history-default-targets", ROOT_IDENTITY);
    await runInProcess(stub, async (process) => {
      const runId = "typed-default-targets-run";
      process.runs.active = { runId };
      const turn = classifyAssistantTurn(assistantResponse([
        { type: "toolCall", id: "read", name: "Read", arguments: { path: "/root/file" } },
        { type: "toolCall", id: "write", name: "Write", arguments: { path: "/root/file", content: "text" } },
        { type: "toolCall", id: "edit", name: "Edit", arguments: { path: "/root/file", oldText: "a", newText: "b" } },
        { type: "toolCall", id: "delete", name: "Delete", arguments: { path: "/root/file" } },
        { type: "toolCall", id: "search", name: "Search", arguments: { pattern: "text" } },
        { type: "toolCall", id: "shell", name: "Shell", arguments: { input: "pwd" } },
        { type: "toolCall", id: "remote", name: "Read", arguments: { path: "/tmp/file", target: "laptop" } },
        { type: "toolCall", id: "gateway-name", name: "Read", arguments: { path: "/tmp/file", target: "gateway" } },
        { type: "toolCall", id: "local-name", name: "Read", arguments: { path: "/tmp/file", target: "local" } },
        { type: "toolCall", id: "spaced-name", name: "Read", arguments: { path: "/tmp/file", target: " laptop " } },
        { type: "toolCall", id: "missing-session", name: "Shell", arguments: { sessionId: "unknown-session" } },
        { type: "toolCall", id: "codemode", name: "CodeMode", arguments: { code: "return 1", target: "laptop" } },
      ]), ["Read", "Write", "Edit", "Delete", "Search", "Shell", "CodeMode"]);
      process.run.persistRunTickAssistantHistory(runId, turn, [], undefined);
      const calls = process.store.messages.getRecords().filter((record) => record.kind === "call");
      expect(calls.map((record) => [record.payload.callId, record.payload.target])).toEqual([
        ["read", "gsv"], ["write", "gsv"], ["edit", "gsv"], ["delete", "gsv"],
        ["search", "gsv"], ["shell", "gsv"], ["remote", "laptop"],
        ["gateway-name", "gateway"], ["local-name", "local"], ["spaced-name", " laptop "],
        ["missing-session", null], ["codemode", null],
      ]);
      expect(calls.map((record) => record.payload.args)).toEqual(turn.returnedToolCalls.map((call) => call.arguments));
      process.runs.active = null;
    });
  });

  it("records Send and Shell run-control outcomes and preserves their display sentences", async () => {
    const stub = await initProcess("typed-history-run-control", ROOT_IDENTITY);
    await runInProcess(stub, async (process) => {
      const runId = "typed-control-run";
      process.runs.active = { runId };
      process.store.messages.appendMessage("assistant", "draft", { runId });
      process.store.tools.register("send-dispatch", "send-call", runId, "Send", { text: "sent", yield: true });
      process.run.persistRunControlToolResult(runId, "send-dispatch", "send-call", {
        ok: true, action: "message", finish: true, text: "sent",
        delivery: { kind: "message", conversationId: "conv", messageId: "committed" },
      });
      process.store.tools.register("shell-dispatch", "shell-call", runId, "Shell", { input: "message send" });
      process.run.persistRunControlToolResult(runId, "shell-dispatch", "shell-call", {
        ok: false, action: "message", text: "", delivery: { kind: "none" }, failureKind: "command", error: "empty message",
      });
      process.store.tools.register("execution-dispatch", "execution-call", runId, "Send", { yield: true });
      process.run.persistRunControlExecutionError(runId, "execution-dispatch", "execution-call", "execution stopped");
      process.run.appendInvalidRunControlToolResult(runId, { id: "mixed-call", name: "Send", arguments: { yield: true } });
      const records: ProcHistoryRecord[] = process.store.messages.getRecords();
      expect(records.filter((record) => record.kind === "result").map((record) => record.payload)).toMatchObject([
        { callId: "send-call", tool: "Send", outcome: "completed", output: { action: "message", finish: true, delivery: { kind: "message", conversationId: "conv", messageId: "committed" } } },
        { callId: "shell-call", tool: "Shell", outcome: "failed", output: { action: "message", finish: false, delivery: { kind: "none" }, failureKind: "command", attempt: { count: 1, limit: 5 } }, error: { message: "empty message" } },
        { callId: "execution-call", tool: "Send", outcome: "failed", output: { failureKind: "execution", finish: false }, error: { message: "execution stopped" } },
        { callId: "mixed-call", tool: "Send", outcome: "failed", output: { failureKind: "command", finish: false }, error: { code: "run-control.mixed-actions" } },
      ]);
      const messages = process.store.messages.getMessages();
      expect(messages[1].content).toBe("Message committed and run yielded");
      expect(messages[2].content).toContain("Run-control command rejected (attempt 1 of 5): empty message");
      expect(messages[3].content).toBe("Run-control execution failed: execution stopped");
      process.runs.active = null;
    });
  });

  it("records rejected unoffered calls without registering or dispatching them", async () => {
    const stub = await initProcess("typed-history-unoffered", ROOT_IDENTITY);
    await runInProcess(stub, async (process) => {
      const runId = "typed-unoffered-run";
      const turn = classifyAssistantTurn(assistantResponse([
        { type: "toolCall", id: "unoffered", name: "Read", arguments: { path: "/root/private.txt" } },
      ]), []);
      process.run.persistRunTickToolCalls(runId, turn);
      const records: ProcHistoryRecord[] = process.store.messages.getRecords();
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        kind: "result", payload: {
          callId: "unoffered", tool: "Read", outcome: "failed", output: null,
          error: { code: "tool.not-offered", message: 'Tool "Read" was not offered for this generation' },
        },
      });
      expect(process.store.tools.getResults(runId)).toEqual([]);
    });
  });

  it("records confirmed outgoing messages without adding compatibility history rows", async () => {
    const stub = await initProcess("typed-history-outgoing", ROOT_IDENTITY);
    await runInProcess(stub, async (process) => {
      const runId = "typed-outgoing-run";
      process.runs.active = { runId, conversationId: "conv" };
      process.store.messages.appendMessage("assistant", "private draft", { runId });
      const committedMedia = {
        type: "resource",
        ref: { type: "file", target: "gsv", path: "/root/retained.txt", revision: "retained-revision", contentType: "text/plain", size: 4 },
      };
      process.run.commitRunControlMessage = vi.fn(async () => ({
        conversationId: "conv", id: "sent", text: "public message", media: [committedMedia],
      }));
      const result = await process.run.commitMessageRunControlAction({
        runId, actionId: "send", text: "public message", finish: false, media: [],
      });
      expect(result).toMatchObject({ ok: true, delivery: { conversationId: "conv", messageId: "sent" } });
      const records: ProcHistoryRecord[] = process.store.messages.getRecords();
      expect(records.find((record) => record.kind === "message")).toMatchObject({
        kind: "message",
        payload: { direction: "out", text: "public message", media: [committedMedia], conversationId: "conv", conversationMessageId: "sent", deliveryId: "send" },
      });
      expect(process.store.messages.getMessages().map((message: { content: string }) => message.content)).toEqual(["private draft"]);
      await process.run.commitMessageRunControlAction({
        runId, actionId: "send", text: "changed retry text", finish: false, media: [],
      });
      expect(process.store.messages.getRecords()).toEqual(records);
      process.run.commitRunControlMessage = vi.fn(async () => { throw new Error("commit rejected"); });
      await expect(process.run.commitMessageRunControlAction({
        runId, actionId: "failed-send", text: "not delivered", finish: false, media: [],
      })).rejects.toThrow("commit rejected");
      expect(process.store.messages.getRecords()).toEqual(records);
      process.runs.active = null;
    });
  });

  it("records correction attempts and confirmed exhaustion notices with separate audiences", async () => {
    const stub = await initProcess("typed-history-corrections", ROOT_IDENTITY);
    await runInProcess(stub, async (process) => {
      const runId = "typed-correction-run";
      process.runs.active = { runId };
      process.store.messages.appendMessage("assistant", "draft", { runId });
      process.sendSignal = vi.fn(async () => {});
      process.run.scheduleTick = vi.fn(async () => {});
      process.run.commitRunControlMessage = vi.fn(async () => ({ conversationId: "conv", id: "notice", text: "I wrote a reply but did not send it. Ask me again." }));
      await process.run.requireRunYield(runId, testUsage(), "draft");
      process.runs.active = { ...process.runs.active, terminalCorrectionRounds: 3 };
      await process.run.deliverCorrectionNotice(runId);
      await process.run.deliverCorrectionNotice(runId);
      const records: ProcHistoryRecord[] = process.store.messages.getRecords();
      expect(records.filter((record) => record.kind === "event").map((record) => record.payload)).toEqual([
        { kind: "correction.text-only", payload: { attempt: 1, limit: 3 }, severity: "warn", audience: "model" },
        { kind: "correction.exhausted", payload: { attempts: 3, limit: 3, conversationId: "conv", messageId: "notice" }, severity: "error", audience: "person" },
      ]);
      expect(process.store.messages.getMessages()).toHaveLength(2);
      process.runs.active = null;
    });
  });

  it("records generation failures with their provider metadata", async () => {
    const stub = await initProcess("typed-history-generation-failure", ROOT_IDENTITY);
    await runInProcess(stub, async (process) => {
      const runId = "typed-generation-run";
      process.runs.active = { runId };
      process.sendSignal = vi.fn(async () => {});
      await process.run.generationFailure(runId, {
        prepared: { activeConfig: { provider: "test-provider", model: "test-model" } },
      }, "generation.error", "provider rejected the request");
      const records: ProcHistoryRecord[] = process.store.messages.getRecords();
      expect(records.at(-1)).toMatchObject({
        kind: "event", payload: {
          kind: "generation.failed",
          payload: { reason: "generation.error", error: "provider rejected the request", provider: "test-provider", model: "test-model" },
          severity: "error", audience: "both",
        },
      });
      process.runs.active = null;
    });
  });

  it("keeps context-failure source facts separate from their compatibility text", async () => {
    const stub = await initProcess("typed-history-context-failure", ROOT_IDENTITY);
    await runInProcess(stub, async (process) => {
      const runId = "typed-context-run";
      const policy = { overflow: "fail", compactAtPressure: 0.9, compactToPressure: 0.6, updatedAt: 1 };
      process.runs.active = { runId };
      process.sendSignal = vi.fn(async () => {});
      await process.run.failWithHistoryEvent(runId, {
        reason: "context.policy.fail", trigger: "preflight", policy, pressure: 0.95,
      });
      const records: ProcHistoryRecord[] = process.store.messages.getRecords();
      expect(records.at(-1)).toMatchObject({
        kind: "event", payload: {
          kind: "context.failed", payload: { reason: "context.policy.fail", trigger: "preflight", policy, pressure: 0.95 },
          severity: "error", audience: "both",
        },
      });
      expect(process.store.messages.getMessages()[0].content).toBe([
        "Context limit policy stopped this run.",
        "Policy: fail at 90% context pressure.",
        "Current estimate: 95%.",
        "Compact the history or reset the process before sending more work.",
      ].join("\n"));
    });
  });

  it("records media failures at the same terminal boundary as their pending input", async () => {
    const stub = await initProcess("typed-history-media-failure", ROOT_IDENTITY);
    await runInProcess(stub, async (process) => {
      const runId = "typed-media-run";
      const messageId = process.store.messages.appendMessage("user", "attachment", { runId });
      process.runs.active = { runId, pendingMediaMessageId: messageId };
      process.sendSignal = vi.fn(async () => {});
      await process.resources.failPendingMedia(runId, messageId, "media preparation timed out", "media.timeout");
      const records: ProcHistoryRecord[] = process.store.messages.getRecords();
      expect(records.at(-1)).toMatchObject({
        kind: "event", payload: {
          kind: "media.failed", payload: { reason: "media.timeout", messageId, error: "media preparation timed out" },
          severity: "error", audience: "both",
        },
      });
      expect(process.runs.active).toBeNull();
    });
  });

  it("records exhausted finish delivery and the actual attempt count", async () => {
    const stub = await initProcess("typed-history-finish-failure", ROOT_IDENTITY);
    await runInProcess(stub, async (process) => {
      const runId = "typed-finish-run";
      process.store.state.setValue("pendingRunFinishes", JSON.stringify([{
        pid: process.pid, runId, status: "ok", reason: "run.yielded", result: { text: null },
        delivery: { kind: "none" }, queuedCount: 0, timestamp: 1, deliveryAttempts: 9,
      }]));
      process.sendSignal = vi.fn(async () => { throw new Error("transport unavailable"); });
      process.signals.changed = vi.fn(async () => {});
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        await process.finishDelivery.deliver(runId);
      } finally {
        warn.mockRestore();
      }
      const records: ProcHistoryRecord[] = process.store.messages.getRecords();
      expect(records.at(-1)).toMatchObject({
        kind: "event", payload: {
          kind: "delivery.failed",
          payload: { phase: "run-finish", runId, error: "transport unavailable", attempts: 10, maxAttempts: 10 },
          severity: "error", audience: "both",
        },
      });
    });
  });

  it("starts a durable continuation for pending events without appending another history record", async () => {
    const stub = await initProcess("typed-history-pending-wake", ROOT_IDENTITY);
    await runInProcess(stub, async (process) => {
      const run = { runId: "typed-wake-run", pendingRuntimeEvents: 2 };
      process.runs.active = run;
      process.store.messages.appendMessage("assistant", "done", { runId: run.runId });
      const records = process.store.messages.getRecords();
      const transition = process.run.commitRunFinishState(run, { reason: "run.yielded", status: "ok", resultText: null });
      expect(transition.next).toMatchObject({ type: "continuation", runId: transition.wakeRunId });
      expect(process.runs.active?.runId).toBe(transition.wakeRunId);
      expect(transition.wakeRunId).not.toBe(run.runId);
      expect(process.store.messages.getRecords()).toEqual(records);
      process.runs.active = null;
    });
  });
});
