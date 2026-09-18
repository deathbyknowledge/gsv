import { createAssistantMessageEventStream, type AssistantMessage, type ToolCall } from "@humansandmachines/gsv/services/inference-context";
import { describe, expect, it, vi } from "vitest";
import type { Process } from "./do";
import type { MessageRecord } from "./storage/store-codecs";
import {
  ROOT_IDENTITY, captureSignals, generationRun, initProcess, processTestConfig, runInProcess, testUsage,
} from "./do-test-harness";

type StreamedPhase = { phase: string; id: string; delta?: string; reason?: string };

/** A model that writes one Send call, its argument JSON arriving in the given chunks. */
function sendStreamGeneration(callId: string, chunks: readonly string[], finalArguments: ToolCall["arguments"]): Process["generation"] {
  return {
    stream() {
      const stream = createAssistantMessageEventStream();
      const toolCall: ToolCall = { type: "toolCall", id: callId, name: "Send", arguments: {} };
      const partial: AssistantMessage = {
        role: "assistant", content: [toolCall], api: "test", provider: "test", model: "test",
        usage: testUsage(), stopReason: "toolUse", timestamp: Date.now(),
      };
      stream.push({ type: "start", partial: { ...partial, content: [] } });
      stream.push({ type: "toolcall_start", contentIndex: 0, partial });
      for (const delta of chunks) stream.push({ type: "toolcall_delta", contentIndex: 0, delta, partial });
      const finished = { ...toolCall, arguments: finalArguments };
      partial.content[0] = finished;
      stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: finished, partial });
      stream.push({ type: "done", reason: "toolUse", message: { ...partial, content: [finished] } });
      return stream;
    },
    async generate() {
      throw new Error("non-stream generation should not be used");
    },
    async generateText() {
      return "";
    },
  };
}

function recordStreamedPhases(process: Process): StreamedPhase[] {
  const streamed: StreamedPhase[] = [];
  vi.spyOn(process.streams, "emitProjection").mockImplementation(
    async (_runId, projection, phase, delta, reason) => {
      if (phase === "aborted") expect(process.killed).toBe(false);
      const entry: StreamedPhase = { phase, id: projection.id };
      if (delta !== undefined) entry.delta = delta;
      if (reason !== undefined) entry.reason = reason;
      streamed.push(entry);
    },
  );
  return streamed;
}

describe("Send text streaming", () => {
  it("shows the text as the model writes it, then commits the same message without another delta", async () => {
    const pid = "mech-send-stream";
    const runId = "run-send-stream";
    const text = "Hello, wörld 😀 there\nend";
    const chunks = ['{"yield":true,"te', 'xt":"Hel', 'lo, w\\u00f6rld \\ud83d', '\\ude00 there\\n', 'end"', "}"];
    const stub = await initProcess(pid, ROOT_IDENTITY);

    const result = await runInProcess(stub, async (process) => {
      const emitted = captureSignals(process);
      const streamed = recordStreamedPhases(process);
      process.run.scheduleTick = vi.fn(async () => {});
      process.run.commitRunControlMessage = vi.fn(async () => {
        streamed.push({ phase: "committed", id: `draft:${runId}:send-stream-1` });
        return { conversationId: "conv:home", id: "sent", text };
      });
      process.generation = sendStreamGeneration("send-stream-1", chunks, { yield: true, text });
      process.store.messages.appendMessage("user", "Say hello.", { runId });
      process.runs.active = generationRun(runId, processTestConfig(pid), { conversationId: "conv:home" });

      await process.run.runTick(runId);
      return { emitted, streamed, commits: process.run.commitRunControlMessage.mock.calls };
    });

    const phases = result.streamed.map((entry) => entry.phase);
    expect(phases[0]).toBe("started");
    expect(phases.at(-1)).toBe("committed");
    expect(phases.slice(1, -1)).toEqual(["delta", "delta", "delta", "delta"]);
    expect(result.streamed.every((entry) => entry.id === `draft:${runId}:send-stream-1`)).toBe(true);
    expect(result.streamed.map((entry) => entry.delta ?? "").join("")).toBe(text);
    // the escaped surrogate pair split across chunks arrives whole, never as a lone half
    expect(result.streamed.map((entry) => entry.delta)).toContain("😀 there\n");
    expect(result.commits).toHaveLength(1);
    expect(result.commits[0][2]).toMatchObject({
      call: "proc.message.commit",
      args: { runId, actionId: "send-stream-1", text },
    });
    expect(
      result.emitted.findLast((entry) => entry.signal === "proc.run.finished")?.payload,
    ).toMatchObject({ status: "ok", reason: "run.yielded" });
  });

  it("withdraws the streamed text when the finished Send fails validation", async () => {
    const pid = "mech-send-stream-invalid";
    const runId = "run-send-stream-invalid";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    const result = await runInProcess(stub, async (process) => {
      const streamed = recordStreamedPhases(process);
      process.run.scheduleTick = vi.fn(async () => {});
      process.run.commitRunControlMessage = vi.fn(async () => {
        throw new Error("an invalid Send must not commit");
      });
      process.generation = sendStreamGeneration(
        "send-stream-2",
        ['{"purpose":"reply","text":"Par', 'tial","yield":"later"}'],
        { purpose: "reply", text: "Partial", yield: "later" },
      );
      process.store.messages.appendMessage("user", "Say hello.", { runId });
      process.runs.active = generationRun(runId, processTestConfig(pid), { conversationId: "conv:home" });

      await process.run.runTick(runId);
      return { streamed, commits: process.run.commitRunControlMessage.mock.calls, messages: process.store.messages.getMessages() };
    });

    expect(result.streamed).toEqual([
      { phase: "started", id: `draft:${runId}:send-stream-2` },
      { phase: "delta", id: `draft:${runId}:send-stream-2`, delta: "Par" },
      { phase: "delta", id: `draft:${runId}:send-stream-2`, delta: "tial" },
      {
        phase: "aborted",
        id: `draft:${runId}:send-stream-2`,
        reason: "Send accepts text (a string) and yield (a boolean) and nothing else",
      },
    ]);
    expect(result.commits).toHaveLength(0);
    const toolResult = result.messages.find((message: MessageRecord) => message.role === "toolResult");
    expect(toolResult).toMatchObject({
      toolCallId: "send-stream-2",
    });
    expect(JSON.parse(toolResult.toolCalls)).toMatchObject({ isError: true });
  });

  it.each(["abort", "reset", "supersede", "kill", "kill-archive"])("withdraws the live preview on %s", async (operation) => {
    const pid = `mech-send-stream-${operation}`;
    const runId = `${pid}-run`;
    const stub = await initProcess(pid, ROOT_IDENTITY);
    const result = await runInProcess(stub, async (process) => {
      captureSignals(process);
      const streamed = recordStreamedPhases(process);
      process.run.scheduleTick = vi.fn(async () => {});
      process.maybeStartTaskTitleGeneration = vi.fn();
      process.store.messages.appendMessage("user", "Say hello.", { runId });
      process.runs.active = generationRun(runId, processTestConfig(pid), { conversationId: "conv:home" });
      await process.streams.append(runId, "send", "Partial");
      if (operation === "abort") await process.controller.handleProcAbort({ runId });
      else if (operation === "reset") await process.controller.resetExecutionState("test reset");
      else if (operation.startsWith("kill")) await process.controller.handleProcKill({ archive: operation === "kill-archive" });
      else await process.controller.handleProcSend({ message: "New input" });
      return { streamed, activeRunId: process.runs.active?.runId, killed: process.killed };
    });
    expect(result.streamed.map((entry) => entry.phase)).toEqual(["started", "delta", "aborted"]);
    expect(result.activeRunId).not.toBe(runId);
    expect(result.killed).toBe(operation.startsWith("kill"));
  });
});
