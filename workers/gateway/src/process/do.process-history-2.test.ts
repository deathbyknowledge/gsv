import { describe, expect, it } from "vitest";
import {
  captureSignals, mockGeneration, processTestConfig, generationRun, runInProcess, ROOT_IDENTITY,
  initProcess, setHistoryPolicy,
} from "./do-test-harness";

describe("process history", () => {
  it("stops when the retained tail is still too large after auto-compaction", async () => {
    const pid = "mech-conversation-auto-compact-insufficient";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    const result = await runInProcess(stub, async (process) => {
      const emitted = captureSignals(process);
      let generated = false;
      mockGeneration(process, async () => {
        generated = true;
        throw new Error("chat generation should not run");
      }, async () => {
        return "Compact summary.";
      });
      process.store.messages.appendMessage("user", "old context");
      process.store.messages.appendMessage("user", `retained ${"x".repeat(4000)}`, {
        runId: "run-auto-compact-insufficient",
      });
      setHistoryPolicy(process, { compactAtPressure: 0.5 });
      process.runs.active = generationRun("run-auto-compact-insufficient", {
        executor: { kind: "process", pid },
        provider: "workers-ai",
        model: "@cf/test/model",
        apiKey: "",
        maxTokens: 100,
        contextWindowTokens: 1000,
        contextWindowSource: "config",
        maxContextBytes: 32768,
      });
      await process.run.runTick("run-auto-compact-insufficient");
      return {
        emitted,
        generated,
        currentRun: process.runs.active,
        messages: process.store.messages.getMessages(),
        segments: process.store.history.listHistorySegments(),
      };
    });

    expect(result.generated).toBe(false);
    expect(result.currentRun).toBeNull();
    expect(result.segments).toHaveLength(1);
    expect(result.messages.at(-1)?.content).toContain(
      "Auto-compaction could not reduce this process history to its configured context target.",
    );
    expect(result.emitted).toEqual(
      expect.arrayContaining([
        {
          signal: "proc.run.finished",
          payload: expect.objectContaining({
            status: "error",
            reason: "context.auto_compact.insufficient",
          }),
        },
      ]),
    );
  });

  it("surfaces provider account failures during auto-compaction", async () => {
    const pid = "mech-conversation-auto-compact-provider-billing";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    const result = await runInProcess(stub, async (process) => {
      const emitted = captureSignals(process);
      mockGeneration(process, async () => {
        throw new Error("chat generation should not run after compaction failure");
      }, async (request: any) => {
        expect(request.options).toMatchObject({ maxTokens: 768, reasoning: "off" });
        throw new Error("insufficient funds");
      });

      process.store.messages.appendMessage("user", "old context A");
      process.store.messages.appendMessage("assistant", "old context B");
      process.store.messages.appendMessage("user", "Context that must stay live.", {
        runId: "run-auto-compact-provider-billing",
      });
      setHistoryPolicy(process, { compactAtPressure: 0.01, compactToPressure: 0.005 });
      process.runs.active = generationRun("run-auto-compact-provider-billing", processTestConfig(pid, {
        provider: "deepseek",
        model: "deepseek-chat",
        apiKey: "test-key",
        maxTokens: 100,
        contextWindowTokens: 1000
      }));
      await process.run.runTick("run-auto-compact-provider-billing");
      return {
        emitted,
        currentRun: process.runs.active,
        messages: process.store.messages.getMessages(),
        segments: process.store.history.listHistorySegments(),
      };
    });

    expect(result.currentRun).toBeNull();
    expect(result.segments).toHaveLength(0);
    const systemMessage = result.messages.find((message: any) => message.role === "system");
    expect(systemMessage?.content).toContain("Auto-compaction failed before model call");
    expect(systemMessage?.content).toContain(
      "Provider account issue from deepseek/deepseek-chat: insufficient funds",
    );
    expect(systemMessage?.content).toContain(
      "Check credits, quota, or billing for the configured AI provider.",
    );
    expect(systemMessage?.content).not.toContain("returned no text");
    expect(result.emitted).toEqual(
      expect.arrayContaining([
        {
          signal: "proc.run.finished",
          payload: expect.objectContaining({
            status: "error",
            reason: "context.auto_compact.failed",
            runId: "run-auto-compact-provider-billing",
          }),
        },
      ]),
    );
  });

  it("does not apply auto-compaction after the run is aborted during summary generation", async () => {
    const pid = "mech-conversation-auto-compact-abort";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    const result = await runInProcess(stub, async (process) => {
      const emitted = captureSignals(process);
      mockGeneration(process, async () => {
        throw new Error("chat generation should not run after abort");
      }, async (request: any) => {
        expect(request.options).toMatchObject({ maxTokens: 768, reasoning: "off" });
        await process.controller.handleProcAbort({});
        return "Summary that should not be applied.";
      });

      process.store.messages.appendMessage("user", "old context A");
      process.store.messages.appendMessage("assistant", "old context B");
      process.store.messages.appendMessage("user", "Context that must stay live.", {
        runId: "run-auto-compact-abort",
      });
      setHistoryPolicy(process, { compactAtPressure: 0.01, compactToPressure: 0.005 });
      process.runs.active = generationRun("run-auto-compact-abort", processTestConfig(pid, {
        provider: "workers-ai",
        model: "@cf/test/model",
        maxTokens: 100,
        contextWindowTokens: 1000
      }));
      await process.run.runTick("run-auto-compact-abort");
      return {
        emitted,
        currentRun: process.runs.active,
        messages: process.store.messages.getMessages(),
        segments: process.store.history.listHistorySegments(),
      };
    });

    expect(result.currentRun).toBeNull();
    expect(result.messages.map((message: any) => [message.role, message.content])).toEqual([
      ["user", "old context A"],
      ["assistant", "old context B"],
      ["user", "Context that must stay live."],
    ]);
    expect(result.segments).toHaveLength(0);
    expect(result.emitted).toEqual(
      expect.arrayContaining([
        {
          signal: "proc.run.finished",
          payload: expect.objectContaining({
            aborted: true,
            runId: "run-auto-compact-abort",
          }),
        },
      ]),
    );
    // SAFETY: test fixture is constructed with the asserted domain shape.
    const lifecycleEvents = result.emitted
      .filter((entry) => entry.signal === "proc.changed")
      // SAFETY: test fixture is constructed with the asserted domain shape.
      .map((entry) => (entry.payload as any).event)
      .filter(Boolean);
    expect(lifecycleEvents).toEqual([]);
  });
});
