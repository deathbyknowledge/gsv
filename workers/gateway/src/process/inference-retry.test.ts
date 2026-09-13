import { evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Process } from "./do";
import type { InferenceAttribution } from "../inference/provider";
import { runStateSchema } from "./run/state";
import {
  assistantResponse, captureSignals, generationRun, initProcess, messageAction,
  mockGeneration, processTestConfig, ROOT_IDENTITY, runInProcess, testUsage,
} from "./do-test-harness";

describe("Process inference retry identity", () => {
  it.each(["empty", "malformed", "retryable-error"] as const)(
    "dispatches three distinct provider attempts after %s results",
    async (failure) => {
      const pid = `inference-retry-${failure}`;
      const runId = `run-${pid}`;
      const stub = await initProcess(pid, ROOT_IDENTITY);
      const result = await runInProcess(stub, async (process: Process) => {
        const signals = captureSignals(process);
        const requests: InferenceAttribution[] = [];
        const terminalIds = new Set<string>();
        mockGeneration(process, async (request: Parameters<Process["generation"]["generate"]>[0]) => {
          if (!request.attribution) throw new Error("Missing inference attribution");
          requests.push(request.attribution);
          if (terminalIds.has(request.attribution.logicalRequestId)) {
            throw new Error("Inference execution identity has already been used");
          }
          terminalIds.add(request.attribution.logicalRequestId);
          if (terminalIds.size < 3) {
            if (failure === "retryable-error") throw new Error("LLM returned reasoning but no final response");
            return assistantResponse(failure === "empty"
              ? [{ type: "thinking", thinking: "No final output" }]
              : [{ type: "text", text: "<tool_call>Shell<arg_key>input</arg_key><arg_value>pwd</arg_value></tool_call>" }],
            { usage: testUsage(10, 1) });
          }
          return assistantResponse([messageAction("Recovered", "retry-success")], { usage: testUsage(10, 1) });
        }, async () => "unused");
        process.store.messages.appendMessage("user", "Retry this generation");
        process.runs.active = runStateSchema.parse(generationRun(runId, processTestConfig(pid, { generationStreaming: "off" })));
        await process.run.runTick(runId);
        return { requests, signals, providerCalls: terminalIds.size, usage: process.store.state.getHistoryUsage() };
      });
      expect(result.providerCalls).toBe(3);
      expect(result.requests).toHaveLength(3);
      expect(new Set(result.requests.map((request) => request.logicalRequestId)).size).toBe(3);
      expect(result.requests.map((request) => request.actor.runId)).toEqual([runId, runId, runId]);
      expect(result.signals.findLast((event) => event.signal === "proc.run.finished")?.payload).toMatchObject({ status: "ok" });
      expect(result.usage?.generations).toBe(failure === "retryable-error" ? 1 : 3);
    },
  );

  it("persists a deliberate retry before notification and keeps its identity across eviction", async () => {
    const pid = "inference-retry-eviction";
    const runId = `run-${pid}`;
    const stub = await initProcess(pid, ROOT_IDENTITY);
    const config = { provider: "openai", model: "same-model" };
    const before = await runInProcess(stub, async (process: Process) => {
      process.runs.active = { runId };
      const first = await process.run.buildInferenceAttribution(config, "run", runId);
      process.sendSignal = async () => { throw new Error("Notification reply lost"); };
      await expect(process.run.beginGenerationRetry({ runId, attempt: 1, maxAttempts: 3, reason: "empty", cause: "empty" }))
        .rejects.toThrow("Notification reply lost");
      const retry = await process.run.buildInferenceAttribution(config, "run", runId);
      expect(retry.logicalRequestId).not.toBe(first.logicalRequestId);
      return retry;
    });
    await evictDurableObject(stub);
    const restored = await runInProcess(stub, async (process: Process) => {
      const first = await process.run.buildInferenceAttribution(config, "run", runId);
      const repeated = await process.run.buildInferenceAttribution(config, "run", runId);
      expect(repeated).toEqual(first);
      return first;
    });
    expect(restored).toEqual(before);
  });

  it("rotates same-model fallback attempts without mutating a stopped or replaced run", async () => {
    const pid = "inference-retry-fallback";
    const runId = `run-${pid}`;
    const stub = await initProcess(pid, ROOT_IDENTITY);
    await runInProcess(stub, async (process: Process) => {
      captureSignals(process);
      const config = { ...processTestConfig(pid), generationTimeoutMs: 180_000, capabilities: [] };
      process.runs.active = { runId };
      const first = await process.run.buildInferenceAttribution(config, "run", runId);
      await process.run.beginGenerationFallback({ runId, reason: "try another credential", from: config,
        to: { ...config, apiKey: "synthetic-other-key" }, fallbackIndex: 1, fallbackCount: 1 });
      const fallback = await process.run.buildInferenceAttribution(config, "run", runId);
      expect(fallback.logicalRequestId).not.toBe(first.logicalRequestId);
      process.runs.active = { runId: "replacement" };
      const saved = process.store.state.getValue("currentRun");
      expect(await process.run.beginGenerationRetry({ runId, attempt: 1, maxAttempts: 3, reason: "empty", cause: "empty" })).toBe("stopped");
      expect(process.store.state.getValue("currentRun")).toBe(saved);
      process.run.runAbortSignal("replacement");
      process.runAbortControllers.get("replacement")!.abort();
      expect(await process.run.beginGenerationRetry({ runId: "replacement", attempt: 1, maxAttempts: 3, reason: "empty", cause: "empty" })).toBe("stopped");
      expect(process.store.state.getValue("currentRun")).toBe(saved);
    });
  });

  it("gives compaction retries and a later manual operation distinct persisted attempts", async () => {
    const pid = "inference-retry-compaction";
    const stub = await initProcess(pid, ROOT_IDENTITY);
    const previous = await runInProcess(stub, async (process: Process) => {
      process.history.resolveCheckpointConfig = async () => ({ ...processTestConfig(pid), generationTimeoutMs: 180_000, capabilities: [] });
      process.store.messages.appendMessage("user", "Summarize this unchanged history");
      const requests: InferenceAttribution[] = [];
      mockGeneration(process, async () => { throw new Error("Unexpected regular generation"); },
        async (request: Parameters<Process["generation"]["generateText"]>[0]) => {
          if (!request.attribution) throw new Error("Missing compaction attribution");
          requests.push(request.attribution);
          throw new Error(requests.length === 1 ? "LLM returned reasoning but no final response" : "Provider unavailable");
        });
      await expect(process.history.generateHistoryCompactionSummary(process.store.messages.getMessages())).rejects.toThrow();
      expect(requests).toHaveLength(2);
      expect(requests[0].logicalRequestId).not.toBe(requests[1].logicalRequestId);
      return requests;
    });
    await evictDurableObject(stub);
    await runInProcess(stub, async (process: Process) => {
      process.history.resolveCheckpointConfig = async () => ({ ...processTestConfig(pid), generationTimeoutMs: 180_000, capabilities: [] });
      const requests: InferenceAttribution[] = [];
      mockGeneration(process, async () => { throw new Error("Unexpected regular generation"); },
        async (request: Parameters<Process["generation"]["generateText"]>[0]) => {
          if (!request.attribution) throw new Error("Missing compaction attribution");
          requests.push(request.attribution);
          return "A summary";
        });
      expect(await process.history.generateHistoryCompactionSummary(process.store.messages.getMessages())).toBe("A summary");
      expect(previous.map((request) => request.logicalRequestId)).not.toContain(requests[0].logicalRequestId);
      const saved = process.store.state.getValue("compactionInferenceAttempt");
      await expect(process.history.generateHistoryCompactionSummary(process.store.messages.getMessages(), AbortSignal.abort()))
        .rejects.toThrow();
      expect(requests).toHaveLength(1);
      expect(process.store.state.getValue("compactionInferenceAttempt")).toBe(saved);
    });
  });

  it("keeps the first compaction identity and rotates a same-model credential fallback", async () => {
    const pid = "inference-compaction-fallback";
    const stub = await initProcess(pid, ROOT_IDENTITY);
    await runInProcess(stub, async (process: Process) => {
      const base = { ...processTestConfig(pid), generationTimeoutMs: 180_000, capabilities: [] };
      const config = { ...base, fallbacks: [{ ...base, apiKey: "synthetic-fallback" }] };
      process.history.resolveCheckpointConfig = async () => config;
      process.store.messages.appendMessage("user", "Compaction fallback source");
      const legacy = await process.run.buildInferenceAttribution(config, "compaction", undefined, `${pid}:compaction`);
      const requests: InferenceAttribution[] = [];
      mockGeneration(process, async () => { throw new Error("Unexpected regular generation"); },
        async (request: Parameters<Process["generation"]["generateText"]>[0]) => {
          if (!request.attribution) throw new Error("Missing compaction attribution");
          requests.push(request.attribution);
          if (requests.length === 1) throw new Error("Invalid API key");
          return "Fallback summary";
        });
      expect(await process.history.generateHistoryCompactionSummary(process.store.messages.getMessages())).toBe("Fallback summary");
      expect(requests).toHaveLength(2);
      expect(requests[0].logicalRequestId).toBe(legacy.logicalRequestId);
      expect(requests[1].logicalRequestId).not.toBe(legacy.logicalRequestId);
    });
  });
});
