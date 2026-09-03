import { Kernel } from "../kernel/do";
import { getKernelPtr } from "../shared/utils";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  captureSignals, mockGeneration, processTestConfig, generationRun, assistantResponse, runInProcess,
  KIMI_WORKERS_CONTEXT_OVERFLOW_ERROR, ROOT_IDENTITY, initProcess, kimiWorkersConfigWithFallback,
  messageAction, mockRunEventSink, setHistoryPolicy, testUsage, type ProcessTestValue,
} from "./do-test-harness";

function installKimiOverflowRun(
  process: any,
  pid: string,
  runId: string,
  oldContext: [user: string, assistant: string] | null,
  liveContext: string,
  overflow: "auto-compact" | "fail" = "auto-compact",
): void {
  if (oldContext) {
    process.store.messages.appendMessage("user", oldContext[0]);
    process.store.messages.appendMessage("assistant", oldContext[1]);
  }
  process.store.messages.appendMessage("user", liveContext, { runId });
  setHistoryPolicy(process, { overflow });
  process.runs.active = generationRun(runId, kimiWorkersConfigWithFallback(pid));
}

function expectKimiOverflowRetry(
  emitted: Array<{ signal: string; payload: ProcessTestValue }>,
  pid: string,
  runId: string,
): void {
  const retrying = emitted.filter((entry) => entry.signal === "proc.run.retrying");
  expect(retrying).toHaveLength(1);
  expect(retrying[0]?.payload).toMatchObject({
    pid,
    runId,
    attempt: 1,
    nextAttempt: 2,
    maxAttempts: 2,
    reason: KIMI_WORKERS_CONTEXT_OVERFLOW_ERROR,
  });
  expect(retrying[0]?.payload).not.toHaveProperty("fallback");
}

describe("model context", () => {
  it("switches to a fallback Codex account for the same model stack", async () => {
    const pid = "mech-chat-provider-error-account-fallback";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    const result = await runInProcess(stub, async (process) => {
      const calls: Array<{
        provider: string;
        model: string;
        apiKey: string;
        accountId?: string;
      }> = [];
      process.sendSignal = async () => {};
      mockGeneration(process, async (request: any) => {
        calls.push({
          provider: request.config.provider,
          model: request.config.model,
          apiKey: request.config.apiKey,
          accountId: request.config.openAiCodex?.accountId,
        });
        if (calls.length === 1) {
          return assistantResponse([], {
            provider: request.config.provider,
            model: request.config.model,
            stopReason: "error",
            errorMessage: "Custom provider HTTP 403: quota exceeded",
            usage: testUsage(1, 0)
          });
        }
        return assistantResponse([
          { type: "text", text: "secondary account pong" },
          messageAction("secondary account pong", "secondary-account-message"),
        ], {
          provider: request.config.provider,
          model: request.config.model,
          usage: testUsage(2, 3)
        });
      }, async () => {
        return "unused";
      });

      process.store.messages.appendMessage("user", "try another account");
      process.runs.active = generationRun("run-chat-provider-error-account-fallback", processTestConfig(pid, {
        provider: "openai-codex",
        model: "gpt-5.2-codex",
        apiKey: "shared-token",
        openAiCodex: { accountId: "primary-account" },
        transportTarget: "gsv",
        maxTokens: 4096,
        fallbacks: [
          {
            modelId: "secondary-account",
            modelName: "Secondary Account",
            provider: "openai-codex",
            model: "gpt-5.2-codex",
            apiKey: "shared-token",
            openAiCodex: { accountId: "secondary-account" },
            transportTarget: "gsv",
            maxTokens: 4096,
            contextWindowTokens: 128000,
            contextWindowSource: "config",
            generationTimeoutMs: 180000,
            generationStreaming: "auto",
          },
        ]
      }));
      await process.run.runTick("run-chat-provider-error-account-fallback");
      return {
        calls,
        messages: process.store.messages.getMessages(),
      };
    });

    expect(result.calls).toEqual([
      {
        provider: "openai-codex",
        model: "gpt-5.2-codex",
        apiKey: "shared-token",
        accountId: "primary-account",
      },
      {
        provider: "openai-codex",
        model: "gpt-5.2-codex",
        apiKey: "shared-token",
        accountId: "secondary-account",
      },
    ]);
    expect(
      result.messages
        .filter((message: any) => message.role !== "toolResult")
        .map((message: any) => [message.role, message.content]),
    ).toEqual([
      ["user", "try another account"],
      ["assistant", "secondary account pong"],
    ]);
  });

  it("auto-compacts and retries the same Kimi model after a thrown provider overflow", async () => {
    const pid = "mech-chat-kimi-overflow-throw-compact";
    const runId = "run-chat-kimi-overflow-throw-compact";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    // SAFETY: test fixture is constructed with the asserted domain shape.

    const result = await runInProcess(stub, async (process) => {
      const emitted: Array<{ signal: string; payload: ProcessTestValue }> = [];
      const calls: Array<{ provider: string; model: string; context: string }> = [];
      const timeline: string[] = [];
      let summaryCalls = 0;
      process.sendSignal = async (signal: string, payload: ProcessTestValue) => {
        emitted.push({ signal, payload });
        if (signal === "proc.run.retrying") {
          timeline.push("retrying");
          // SAFETY: test fixture is constructed with the asserted domain shape.
        }
        // SAFETY: test fixture is constructed with the asserted domain shape.
        if (signal === "proc.changed" && (payload as any).event) {
          // SAFETY: test fixture is constructed with the asserted domain shape.
          timeline.push((payload as any).event);
        }
      };
      mockGeneration(process, async (request: any) => {
        calls.push({
          provider: request.config.provider,
          model: request.config.model,
          context: JSON.stringify(request.context),
        });
        timeline.push(`generate:${calls.length}`);
        if (calls.length === 1) {
          throw new Error(KIMI_WORKERS_CONTEXT_OVERFLOW_ERROR);
        }
        return assistantResponse([
          { type: "text", text: "same model after compaction" },
          messageAction("same model after compaction", "same-model-message"),
        ], {
          provider: request.config.provider,
          model: request.config.model,
          usage: testUsage(20, 3)
        });
      }, async (request: any) => {
        summaryCalls += 1;
        expect(request.config).toMatchObject({
          provider: "workers-ai",
          model: "@cf/moonshotai/kimi-k2.6",
        });
        expect(JSON.stringify(request.context)).toContain("old Kimi context A");
        return "Kimi overflow compact summary.";
      });

      installKimiOverflowRun(
        process,
        pid,
        runId,
        ["old Kimi context A", "old Kimi context B"],
        "Kimi context that must stay live.",
      );

      await process.run.runTick(runId);
      return {
        calls,
        emitted,
        messages: process.store.messages.getMessages(),
        segments: process.store.history.listHistorySegments(),
        summaryCalls,
        timeline,
      };
    });

    expect(result.calls).toHaveLength(2);
    expect(result.calls.map(({ provider, model }) => ({ provider, model }))).toEqual([
      { provider: "workers-ai", model: "@cf/moonshotai/kimi-k2.6" },
      { provider: "workers-ai", model: "@cf/moonshotai/kimi-k2.6" },
    ]);
    expect(result.calls[0].context).toContain("old Kimi context A");
    expect(result.calls[1].context).toContain("Kimi overflow compact summary.");
    expect(result.calls[1].context).toContain("Kimi context that must stay live.");
    expect(result.calls[1].context).not.toContain("old Kimi context A");
    expect(result.summaryCalls).toBe(1);
    expect(result.segments).toHaveLength(1);
    expect(
      result.messages
        .filter((message: any) => message.role !== "toolResult")
        .map((message: any) => [message.role, message.content]),
    ).toEqual([
      ["system", expect.stringContaining("Kimi overflow compact summary.")],
      ["user", "Kimi context that must stay live."],
      ["assistant", "same model after compaction"],
    ]);
    expectKimiOverflowRetry(result.emitted, pid, runId);
    expect(result.timeline).toEqual([
      "generate:1",
      "history.compacted",
      "history.auto_compacted",
      "retrying",
      "generate:2",
    ]);
  });

  it("auto-compacts a returned provider overflow, retries Kimi, and records usage once", async () => {
    const pid = "mech-chat-kimi-overflow-response-compact";
    const runId = "run-chat-kimi-overflow-response-compact";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    const result = await runInProcess(stub, async (process) => {
      const emitted = captureSignals(process);
      const calls: Array<{ provider: string; model: string; context: string }> = [];
      let summaryCalls = 0;
      mockGeneration(process, async (request: any) => {
        calls.push({
          provider: request.config.provider,
          model: request.config.model,
          context: JSON.stringify(request.context),
        });
        if (calls.length === 1) {
          return assistantResponse([], {
            provider: request.config.provider,
            model: request.config.model,
            usage: {
              ...testUsage(301552, 0),
              cost: {
                input: 0.12,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0.12,
              },
            },
            stopReason: "error",
            errorMessage: KIMI_WORKERS_CONTEXT_OVERFLOW_ERROR
          });
        }
        return assistantResponse([
          { type: "text", text: "returned overflow recovered" },
          messageAction("returned overflow recovered", "returned-overflow-message"),
        ], {
          provider: request.config.provider,
          model: request.config.model,
          usage: testUsage(20, 3)
        });
      }, async () => {
        summaryCalls += 1;
        return "Returned overflow compact summary.";
      });

      installKimiOverflowRun(
        process,
        pid,
        runId,
        ["old returned overflow context A", "old returned overflow context B"],
        "Returned overflow context that must stay live.",
      );

      await process.run.runTick(runId);
      return {
        calls,
        emitted,
        historyUsage: process.store.state.getHistoryUsage(),
        messages: process.store.messages.getMessages(),
        segments: process.store.history.listHistorySegments(),
        summaryCalls,
      };
    });

    expect(result.calls).toHaveLength(2);
    expect(result.calls.map(({ provider, model }) => ({ provider, model }))).toEqual([
      { provider: "workers-ai", model: "@cf/moonshotai/kimi-k2.6" },
      { provider: "workers-ai", model: "@cf/moonshotai/kimi-k2.6" },
    ]);
    expect(result.calls[1].context).toContain("Returned overflow compact summary.");
    expect(result.calls[1].context).toContain("Returned overflow context that must stay live.");
    expect(result.calls[1].context).not.toContain("old returned overflow context A");
    expect(result.summaryCalls).toBe(1);
    expect(result.segments).toHaveLength(1);
    expect(result.historyUsage).toMatchObject({
      inputTokens: 301_572,
      outputTokens: 3,
      totalTokens: 301_575,
      cost: { total: 0.12, source: "model-pricing" },
      generations: 2,
    });
    expect(
      result.messages
        .filter((message: any) => message.role !== "toolResult")
        .map((message: any) => [message.role, message.content]),
    ).toEqual([
      ["system", expect.stringContaining("Returned overflow compact summary.")],
      ["user", "Returned overflow context that must stay live."],
      ["assistant", "returned overflow recovered"],
    ]);
    expectKimiOverflowRetry(result.emitted, pid, runId);
  });

  it("applies fail policy to provider overflow without compacting or using fallback", async () => {
    const pid = "mech-chat-kimi-overflow-policy-fail";
    const runId = "run-chat-kimi-overflow-policy-fail";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    const result = await runInProcess(stub, async (process) => {
      const emitted = captureSignals(process);
      const calls: Array<{ provider: string; model: string }> = [];
      let summaryCalls = 0;
      mockGeneration(process, async (request: any) => {
        calls.push({
          provider: request.config.provider,
          model: request.config.model,
        });
        if (calls.length === 1) {
          throw new Error(KIMI_WORKERS_CONTEXT_OVERFLOW_ERROR);
        }
        return assistantResponse([{ type: "text", text: "fallback must not run" }], {
          provider: request.config.provider,
          model: request.config.model
        });
      }, async () => {
        summaryCalls += 1;
        return "summary must not run";
      });

      installKimiOverflowRun(
        process,
        pid,
        runId,
        ["old fail-policy context A", "old fail-policy context B"],
        "Fail-policy context that must stay live.",
        "fail",
      );

      await process.run.runTick(runId);
      return {
        calls,
        currentRun: process.runs.active,
        emitted,
        messages: process.store.messages.getMessages(),
        segments: process.store.history.listHistorySegments(),
        summaryCalls,
      };
    });

    expect(result.calls).toEqual([{ provider: "workers-ai", model: "@cf/moonshotai/kimi-k2.6" }]);
    expect(result.summaryCalls).toBe(0);
    expect(result.segments).toHaveLength(0);
    expect(result.currentRun).toBeNull();
    expect(result.messages.slice(0, 3).map((message: any) => message.content)).toEqual([
      "old fail-policy context A",
      "old fail-policy context B",
      "Fail-policy context that must stay live.",
    ]);
    expect(result.messages.at(-1)?.content).toContain("Context limit policy stopped this run.");
    expect(result.emitted.some((entry) => entry.signal === "proc.run.retrying")).toBe(false);
    expect(result.emitted).toEqual(
      expect.arrayContaining([
        {
          signal: "proc.run.finished",
          payload: expect.objectContaining({
            runId,
            status: "error",
            reason: "context.policy.fail",
          }),
        },
      ]),
    );
  });

  it("terminates repeated provider overflow after one compaction without using fallback", async () => {
    const pid = "mech-chat-kimi-overflow-repeated";
    const runId = "run-chat-kimi-overflow-repeated";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    const result = await runInProcess(stub, async (process) => {
      const emitted = captureSignals(process);
      const calls: Array<{ provider: string; model: string }> = [];
      let summaryCalls = 0;
      mockGeneration(process, async (request: any) => {
        calls.push({
          provider: request.config.provider,
          model: request.config.model,
        });
        throw new Error(KIMI_WORKERS_CONTEXT_OVERFLOW_ERROR);
      }, async () => {
        summaryCalls += 1;
        return "Repeated overflow compact summary.";
      });

      installKimiOverflowRun(
        process,
        pid,
        runId,
        ["old repeated-overflow context A", "old repeated-overflow context B"],
        "Repeated-overflow context that must stay live.",
      );

      await process.run.runTick(runId);
      return {
        calls,
        currentRun: process.runs.active,
        emitted,
        messages: process.store.messages.getMessages(),
        segments: process.store.history.listHistorySegments(),
        summaryCalls,
      };
    });

    expect(result.calls).toEqual([
      { provider: "workers-ai", model: "@cf/moonshotai/kimi-k2.6" },
      { provider: "workers-ai", model: "@cf/moonshotai/kimi-k2.6" },
    ]);
    expect(result.summaryCalls).toBe(1);
    expect(result.segments).toHaveLength(1);
    expect(result.currentRun).toBeNull();
    expect(result.messages.at(-1)?.content).toContain(
      "Context limit reached for workers-ai/@cf/moonshotai/kimi-k2.6.",
    );
    expectKimiOverflowRetry(result.emitted, pid, runId);
    expect(result.emitted).toEqual(
      expect.arrayContaining([
        {
          signal: "proc.run.finished",
          payload: expect.objectContaining({
            runId,
            status: "error",
            reason: "context.provider_overflow",
          }),
        },
      ]),
    );
  });

  it("terminates provider overflow when no history prefix can be compacted", async () => {
    const pid = "mech-chat-kimi-overflow-empty-prefix";
    const runId = "run-chat-kimi-overflow-empty-prefix";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    const result = await runInProcess(stub, async (process) => {
      const emitted = captureSignals(process);
      const calls: Array<{ provider: string; model: string }> = [];
      let summaryCalls = 0;
      mockGeneration(process, async (request: any) => {
        calls.push({
          provider: request.config.provider,
          model: request.config.model,
        });
        if (calls.length === 1) {
          throw new Error(KIMI_WORKERS_CONTEXT_OVERFLOW_ERROR);
        }
        return assistantResponse([{ type: "text", text: "fallback must not run" }], {
          provider: request.config.provider,
          model: request.config.model
        });
      }, async () => {
        summaryCalls += 1;
        return "summary must not run";
      });

      installKimiOverflowRun(process, pid, runId, null, "Only live message.");

      await process.run.runTick(runId);
      return {
        calls,
        currentRun: process.runs.active,
        emitted,
        messages: process.store.messages.getMessages(),
        segments: process.store.history.listHistorySegments(),
        summaryCalls,
      };
    });

    expect(result.calls).toEqual([{ provider: "workers-ai", model: "@cf/moonshotai/kimi-k2.6" }]);
    expect(result.summaryCalls).toBe(0);
    expect(result.segments).toHaveLength(0);
    expect(result.currentRun).toBeNull();
    expect(result.messages.at(-1)?.content).toContain(
      "Context pressure reached the compaction boundary, but no completed history prefix can be archived.",
    );
    expect(result.emitted.some((entry) => entry.signal === "proc.run.retrying")).toBe(false);
    expect(result.emitted).toEqual(
      expect.arrayContaining([
        {
          signal: "proc.run.finished",
          payload: expect.objectContaining({
            runId,
            status: "error",
            reason: "context.auto_compact.empty",
          }),
        },
      ]),
    );
  });

  it("surfaces thrown provider context overflow separately from generation errors", async () => {
    const pid = "mech-chat-provider-context-overflow-throw";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    const result = await runInProcess(stub, async (process) => {
      const emitted = captureSignals(process);
      mockGeneration(process, async () => {
        throw new Error("Your input exceeds the context window of this model");
      }, async () => {
        return "";
      });

      process.store.messages.appendMessage("user", "overflow please");
      process.runs.active = generationRun("run-chat-provider-context-overflow-throw", processTestConfig(pid, {
        provider: "openai",
        model: "gpt-test",
        apiKey: "test-key"
      }));
      await process.run.runTick("run-chat-provider-context-overflow-throw");
      return {
        emitted,
        currentRun: process.runs.active,
        messages: process.store.messages.getMessages(),
      };
    });

    expect(result.currentRun).toBeNull();
    const systemMessage = result.messages.find((message: any) => message.role === "system");
    expect(systemMessage?.content).toContain(
      "Context pressure reached the compaction boundary, but no completed history prefix can be archived.",
    );
    expect(systemMessage?.content).not.toContain("Generation failed:");
    expect(result.emitted).toEqual(
      expect.arrayContaining([
        {
          signal: "proc.run.finished",
          payload: expect.objectContaining({
            status: "error",
            reason: "context.auto_compact.empty",
            runId: "run-chat-provider-context-overflow-throw",
          }),
        },
      ]),
    );
  });

  it("surfaces nested thrown provider context overflow separately from generation errors", async () => {
    const pid = "mech-chat-provider-context-overflow-nested";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    const result = await runInProcess(stub, async (process) => {
      const emitted = captureSignals(process);
      mockGeneration(process, async () => {
        throw new Error("request failed", {
          cause: {
            error: {
              message: "Your input exceeds the context window of this model",
            },
          },
        });
      }, async () => {
        return "";
      });

      process.store.messages.appendMessage("user", "overflow please");
      process.runs.active = generationRun("run-chat-provider-context-overflow-nested", processTestConfig(pid, {
        provider: "openai",
        model: "gpt-test",
        apiKey: "test-key"
      }));
      await process.run.runTick("run-chat-provider-context-overflow-nested");
      return {
        currentRun: process.runs.active,
        emitted,
        messages: process.store.messages.getMessages(),
      };
    });

    expect(result.currentRun).toBeNull();
    const systemMessage = result.messages.find((message: any) => message.role === "system");
    expect(systemMessage?.content).toContain(
      "Context pressure reached the compaction boundary, but no completed history prefix can be archived.",
    );
    expect(systemMessage?.content).not.toContain("Generation failed:");
    expect(result.emitted).toEqual(
      expect.arrayContaining([
        {
          signal: "proc.run.finished",
          payload: expect.objectContaining({
            status: "error",
            reason: "context.auto_compact.empty",
            runId: "run-chat-provider-context-overflow-nested",
          }),
        },
      ]),
    );
  });

  it("surfaces returned provider context overflow and records provider usage", async () => {
    const pid = "mech-chat-provider-context-overflow-response";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    const result = await runInProcess(stub, async (process) => {
      const emitted = captureSignals(process);
      mockGeneration(process, async () => {
        return assistantResponse([], {
          provider: "google",
          model: "gemini-test",
          usage: {
            ...testUsage(1196265, 0),
            cost: {
              input: 0.12,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0.12,
            },
          },
          stopReason: "error",
          errorMessage: "The input token count (1196265) exceeds the maximum number of tokens allowed (1048575)"
        });
      }, async () => {
        return "";
      });

      process.store.messages.appendMessage("user", "overflow please");
      process.runs.active = generationRun("run-chat-provider-context-overflow-response", processTestConfig(pid, {
        provider: "google",
        model: "gemini-test",
        apiKey: "test-key",
        contextWindowTokens: 1048575
      }));
      await process.run.runTick("run-chat-provider-context-overflow-response");
      return {
        emitted,
        contextState: process.store.state.getContextState(),
        historyUsage: process.store.state.getHistoryUsage(),
        messages: process.store.messages.getMessages(),
      };
    });

    const systemMessage = result.messages.find((message: any) => message.role === "system");
    expect(systemMessage?.content).toContain(
      "Context pressure reached the compaction boundary, but no completed history prefix can be archived.",
    );
    expect(systemMessage?.content).not.toContain("Generation failed:");
    expect(result.contextState).toMatchObject({
      inputTokens: 1196265,
      source: "provider",
      level: "full",
    });
    expect(result.historyUsage).toMatchObject({
      inputTokens: 1196265,
      totalTokens: 1196265,
      cost: { total: 0.12, source: "provider" },
      generations: 1,
    });
    expect(result.contextState?.historyUsage).toMatchObject({
      inputTokens: 1196265,
      cost: { total: 0.12, source: "provider" },
    });
    expect(result.emitted).toEqual(
      expect.arrayContaining([
        {
          signal: "proc.run.finished",
          payload: expect.objectContaining({
            status: "error",
            reason: "context.auto_compact.empty",
            runId: "run-chat-provider-context-overflow-response",
          }),
        },
      ]),
    );
  });

  // SAFETY: test fixture is constructed with the asserted domain shape.
  it("mirrors provider stream events as proc.run.stream signals with fallbacks configured", async () => {
    const pid = "mech-chat-stream";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    // SAFETY: test fixture is constructed with the asserted domain shape.

    const emitted = await runInProcess(stub, async (process) => {
      const emitted = captureSignals(process);
      mockRunEventSink(process, pid, emitted);
      process.generation = {
        stream() {
          const stream = createAssistantMessageEventStream();
          // SAFETY: test fixture is constructed with the asserted domain shape.
          const partial = {
            role: "assistant",
            content: [{ type: "text", text: "" }],
            api: "test",
            provider: "test",
            model: "test",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
            timestamp: Date.now(),
            // SAFETY: test fixture is constructed with the asserted domain shape.
          } as any;
          stream.push({ type: "start", partial: { ...partial, content: [] } });
          stream.push({ type: "text_start", contentIndex: 0, partial });
          partial.content[0].text = "he";
          stream.push({ type: "text_delta", contentIndex: 0, delta: "he", partial });
          partial.content[0].text = "hello";
          stream.push({ type: "text_delta", contentIndex: 0, delta: "llo", partial });
          stream.push({ type: "text_end", contentIndex: 0, content: "hello", partial });
          stream.push({
            type: "done",
            reason: "stop",
            message: { ...partial, content: [{ type: "text", text: "hello" }] },
          });
          return stream;
        },
        async generate() {
          throw new Error("non-stream generation should not be used");
        },
        async generateText() {
          return "hello";
        },
      };

      process.store.messages.appendMessage("user", "stream please");
      process.runs.active = generationRun("run-chat-stream", processTestConfig(pid, {
        provider: "workers-ai",
        model: "@cf/nvidia/nemotron-3-120b-a12b",
        contextWindowTokens: 256000,
        fallbacks: [
          {
            modelId: "backup-stack",
            modelName: "Backup Stack",
            provider: "workers-ai",
            model: "@cf/moonshotai/kimi-k2.6",
            apiKey: "",
            providerStyle: "auto",
            transportTarget: "gsv",
            maxTokens: 8192,
            contextWindowTokens: 256000,
            contextWindowSource: "config",
            generationTimeoutMs: 180000,
            generationStreaming: "auto",
          },
        ]
      }));
      await process.run.runTick("run-chat-stream");
      return emitted;
    });

    // SAFETY: test fixture is constructed with the asserted domain shape.
    const streamSignals = (emitted as Array<{ signal: string; payload: any }>).filter(
      (entry) => entry.signal === "proc.run.stream",
    );
    expect(streamSignals.map((entry) => entry.payload.event.type)).toEqual([
      "start",
      "text_start",
      "text_delta",
      "text_delta",
      "text_end",
      "done",
    ]);
    expect(streamSignals[2].payload).toMatchObject({
      pid,
      runId: "run-chat-stream",
      seq: 3,
      event: {
        type: "text_delta",
        delta: "he",
      },
    });
    // SAFETY: test fixture is constructed with the asserted domain shape.
    const outputSignal = (emitted as Array<{ signal: string; payload: any }>).find(
      (entry) => entry.signal === "proc.run.output",
    );
    expect(outputSignal?.payload.text).toBe("hello");
  });

  it("transfers hundreds of run events after the Kernel attachment RPC returns", async () => {
    const pid = "mech-chat-stream-transport";
    const runId = "run-chat-stream-transport";
    const eventCount = 256;
    const stub = await initProcess(pid, ROOT_IDENTITY);
    const kernel = await getKernelPtr();

    await kernel.recvFrame(pid, {
      type: "sig",
      signal: "proc.run.started",
      payload: { pid, runId, timestamp: Date.now() },
    });
    // SAFETY: test fixture is constructed with the asserted domain shape.
    await runInDurableObject(kernel, (instance: Kernel) => {
      // SAFETY: test fixture is constructed with the asserted domain shape.
      const k = instance as any;
      k.testRunStreamFrames = [];
      k.testOriginalEnqueueProcessSignal = k.enqueueProcessSignal;
      k.enqueueProcessSignal = async (_processId: string, frame: ProcessTestValue) => {
        k.testRunStreamFrames.push(frame);
      };
    });

    // SAFETY: test fixture is constructed with the asserted domain shape.

    try {
      await runInProcess(stub, async (process) => {
        const sink = await process.streams.openRunEventSink(runId);
        expect(sink).not.toBeNull();

        for (let index = 0; index < eventCount; index += 1) {
          await sink.emit(index + 1, {
            type: "text_delta",
            contentIndex: 0,
            delta: `chunk-${index}`,
            partial: {
              role: "assistant",
              content: [{ type: "text", text: `chunk-${index}` }],
              api: "test",
              provider: "test",
              model: "test",
              timestamp: Date.now(),
            },
          });
        }
        await sink.close();
      });

      // SAFETY: test fixture is constructed with the asserted domain shape.

      await vi.waitFor(async () => {
        const frames = await runInDurableObject(
          kernel,
          (instance: Kernel) =>
            // SAFETY: test fixture is constructed with the asserted domain shape.
            (instance as any).testRunStreamFrames,
        );
        expect(frames).toHaveLength(eventCount);
        expect(frames[0]).toMatchObject({
          signal: "proc.run.stream",
          payload: { pid, runId, seq: 1 },
        });
        expect(frames[eventCount - 1]).toMatchObject({
          signal: "proc.run.stream",
          payload: { pid, runId, seq: eventCount },
        });
      });
      // SAFETY: test fixture is constructed with the asserted domain shape.
    } finally {
      await runInDurableObject(kernel, (instance: Kernel) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const k = instance as any;
        if (k.testOriginalEnqueueProcessSignal) {
          k.enqueueProcessSignal = k.testOriginalEnqueueProcessSignal;
        }
        delete k.testOriginalEnqueueProcessSignal;
        delete k.testRunStreamFrames;
      });
    }
  });
});
