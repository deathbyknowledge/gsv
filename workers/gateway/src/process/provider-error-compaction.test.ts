import { describe, expect, it } from "vitest";
import {
  assistantResponse,
  captureSignals,
  generationRun,
  initProcess,
  mockGeneration,
  processTestConfig,
  ROOT_IDENTITY,
  runInProcess,
  testUsage,
} from "./do-test-harness";

describe("ambiguous provider errors preserve history", () => {
  it.each(["thrown", "returned"])("does not compact after a %s HTTP 400 with no body", async (mode) => {
    const pid = `provider-empty-400-${mode}`;
    const runId = `run-${pid}`;
    const stub = await initProcess(pid, ROOT_IDENTITY);
    const result = await runInProcess(stub, async (process) => {
      const emitted = captureSignals(process);
      let summaryCalls = 0;
      let generationCalls = 0;
      mockGeneration(process, async () => {
        generationCalls += 1;
        if (mode === "thrown") throw new Error("400 (no body)");
        return assistantResponse([], {
          stopReason: "error",
          errorMessage: "400 (no body)",
          usage: testUsage(),
        });
      }, async () => {
        summaryCalls += 1;
        return "This history must not be replaced.";
      });
      process.store.messages.appendMessage("user", "Keep the previous deployment intact.");
      process.store.messages.appendMessage("assistant", "The previous deployment is intact.");
      process.store.messages.appendMessage("user", "Check its status.", { runId });
      const originalIds = process.store.messages.getMessages().map((message: { id: number }) => message.id);
      process.runs.active = generationRun(runId, processTestConfig(pid, {
        contextWindowTokens: 1_000_000,
      }));

      await process.run.runTick(runId);
      return {
        generationCalls,
        summaryCalls,
        originalIds,
        ids: process.store.messages.getMessages().map((message: { id: number }) => message.id),
        segments: process.store.history.listHistorySegments(),
        active: process.runs.active,
        emitted,
      };
    });

    expect(result.generationCalls).toBe(1);
    expect(result.summaryCalls).toBe(0);
    expect(result.ids).toEqual(expect.arrayContaining(result.originalIds));
    expect(result.segments).toEqual([]);
    expect(result.active).toBeNull();
    expect(result.emitted).toEqual(expect.arrayContaining([{
      signal: "proc.run.finished",
      payload: expect.objectContaining({
        status: "error", reason: mode === "thrown" ? "generation.error" : "generation.empty", runId,
      }),
    }]));
  });
});
