import { describe, expect, it } from "vitest";
import type { AiAssistantMessage } from "@humansandmachines/gsv/protocol";
import type { InferenceExecutor } from "@humansandmachines/gsv/services/inference-execution";
import type { GatewayEnv } from "../runtime-env";
import { createGenerationService } from "../inference/execution-client";
import { extractGeneratedText } from "../inference/generated-text";
import { adaptGeneratedAssistantMessage } from "./internal/messages";
import { initProcess, processTestConfig, ROOT_IDENTITY, runInProcess, testUsage } from "./do-test-harness";

/** The shape Cerebras returned for a compaction request whose reasoning stayed on. */
const PLANNING = "We need answer user's request: summarize a compacted GSV process conversation segment. Let's extract important facts: the user asked about deployment and the assistant answered.";
const SUMMARY = "The user asked for the deployment checklist. The assistant listed three steps: build the web assets, plan the deployment, then apply it.";

type Executor = "process" | "kernel";

function cerebrasResponse(
  content: AiAssistantMessage["content"],
  overrides: Partial<AiAssistantMessage> = {},
): AiAssistantMessage {
  return {
    role: "assistant", api: "openai-completions", provider: "cerebras", model: "qwen-3.8-27b",
    content, stopReason: "stop", usage: testUsage(240, 60), timestamp: Date.now(), ...overrides,
  };
}

const thinkingOnly = () => cerebrasResponse([{ type: "thinking", thinking: PLANNING }]);
const thinkingThenSummary = () => cerebrasResponse([
  { type: "thinking", thinking: PLANNING },
  { type: "text", text: SUMMARY },
]);

function seedConversation(process: any): string[] {
  process.store.messages.appendMessage("user", "Walk me through the deployment checklist.");
  process.store.messages.appendMessage("assistant", "Build the web assets, plan the deployment, then apply it.");
  process.store.messages.appendMessage("user", "Which step reads the operator configuration?");
  process.store.messages.appendMessage("assistant", "Both the plan and the apply steps read it.");
  process.store.messages.appendMessage("user", "Keep this for later.");
  return historyContents(process);
}

function historyContents(process: any): string[] {
  return process.store.messages.getMessages().map((message: { content: string }) => message.content);
}

/** How many times compaction asked the provider for a summary. */
type ProviderCalls = { calls: number };

/**
 * Feeds provider results into compaction through the boundary production uses:
 * the Process generation service over the inference executor binding, or the
 * Kernel's ai.text.generate result when another executor runs the model.
 */
function installCompactionProvider(
  process: any,
  pid: string,
  executor: Executor,
  respond: (attempt: number) => AiAssistantMessage,
): ProviderCalls {
  const state: ProviderCalls = { calls: 0 };
  const next = () => {
    state.calls += 1;
    return respond(state.calls);
  };
  const config = {
    ...processTestConfig(pid, executor === "kernel" ? { executor: { kind: "kernel" } } : {}),
    generationTimeoutMs: 180_000,
    capabilities: [],
  };
  process.history.resolveCheckpointConfig = async () => config;
  if (executor === "kernel") {
    process.kernel.kernelRpc = async (call: string) => {
      if (call !== "ai.text.generate") throw new Error(`Unexpected kernel call ${call}`);
      const message = next();
      // The Kernel's text field keeps its reasoning fallback for ai.text.generate callers.
      const text = extractGeneratedText(adaptGeneratedAssistantMessage(message));
      return { message, provider: message.provider, model: message.model, text };
    };
    return state;
  }
  const target: InferenceExecutor = {
    generate: async () => next(),
    generateStream: async () => { throw new Error("Compaction does not stream"); },
    abort: async () => {},
    media: async () => { throw new Error("Compaction does not use media"); },
    [Symbol.dispose]: () => {},
  };
  // SAFETY: Compaction reaches the inference executor through this binding alone.
  process.generation = createGenerationService({
    INFERENCE_EXECUTION: { getExecutor: async () => target },
  } as GatewayEnv);
  return state;
}

async function compact(process: any, options?: { signal?: AbortSignal }) {
  const result = await process.history.handleHistoryCompact({ keepLast: 1, generateSummary: true }, options);
  const archiveKeys = (await process.storage.list({ prefix: `${process.history.historyArchiveDir()}/` }))
    .objects.map((object: { key: string }) => object.key);
  return {
    result,
    history: historyContents(process),
    record: process.store.messages.getMessages()[0]?.records?.[0] ?? null,
    segments: process.store.history.listHistorySegments().length,
    archiveKeys,
  };
}

describe("compaction summary completion", () => {
  it.each<Executor>(["process", "kernel"])(
    "installs only the final text when the %s executor returns reasoning before the summary",
    async (executor) => {
      const pid = `compaction-summary-final-${executor}`;
      const stub = await initProcess(pid, ROOT_IDENTITY);
      const outcome = await runInProcess(stub, async (process) => {
        seedConversation(process);
        const provider = installCompactionProvider(process, pid, executor, thinkingThenSummary);
        return { ...(await compact(process)), calls: provider.calls };
      });
      expect(outcome.result).toMatchObject({ ok: true, archivedMessages: 4 });
      expect(outcome.calls).toBe(1);
      expect(outcome.record).toMatchObject({
        kind: "event",
        payload: {
          kind: "history.compacted", severity: "info", audience: "model",
          payload: { summary: SUMMARY, archivedMessages: 4, archivePath: outcome.result.archivedTo },
        },
      });
      expect(outcome.history).toEqual([expect.stringContaining(`Summary:\n${SUMMARY}`), "Keep this for later."]);
      expect(outcome.history[0]).not.toContain(PLANNING);
      expect(outcome.segments).toBe(1);
      expect(outcome.archiveKeys).toEqual([outcome.result.archivedTo.replace(/^\/+/, "")]);
    },
  );

  it("retries a reasoning-only result once and installs the completed retry", async () => {
    const pid = "compaction-summary-retry";
    const stub = await initProcess(pid, ROOT_IDENTITY);
    const outcome = await runInProcess(stub, async (process) => {
      seedConversation(process);
      const provider = installCompactionProvider(process, pid, "process", (attempt) => (
        attempt === 1 ? thinkingOnly() : thinkingThenSummary()
      ));
      return { ...(await compact(process)), calls: provider.calls };
    });
    expect(outcome.result).toMatchObject({ ok: true, archivedMessages: 4 });
    expect(outcome.calls).toBe(2);
    expect(outcome.record).toMatchObject({ payload: { kind: "history.compacted", payload: { summary: SUMMARY } } });
  });

  it.each<Executor>(["process", "kernel"])(
    "preserves the history when the %s executor returns only reasoning on every attempt",
    async (executor) => {
      const pid = `compaction-summary-reasoning-only-${executor}`;
      const stub = await initProcess(pid, ROOT_IDENTITY);
      const outcome = await runInProcess(stub, async (process) => {
        const seeded = seedConversation(process);
        const provider = installCompactionProvider(process, pid, executor, thinkingOnly);
        return { ...(await compact(process)), seeded, calls: provider.calls };
      });
      expect(outcome.result).toEqual({
        ok: false,
        error: "Failed to generate compaction summary: LLM returned reasoning but no final response",
      });
      expect(outcome.calls).toBe(2);
      expect(outcome.history).toEqual(outcome.seeded);
      expect(outcome.record).toMatchObject({ kind: "message", payload: { text: outcome.seeded[0] } });
      expect(outcome.segments).toBe(0);
      expect(outcome.archiveKeys).toEqual([]);
    },
  );

  const incomplete: Array<[string, () => AiAssistantMessage, string, number]> = [
    ["output-limited reasoning", () => cerebrasResponse([
      { type: "thinking", thinking: PLANNING },
    ], { stopReason: "length", usage: testUsage(240, 768) }),
      "LLM reached the output token limit without text or a tool call", 1],
    ["truncated", () => cerebrasResponse([
      { type: "thinking", thinking: PLANNING },
      { type: "text", text: SUMMARY.slice(0, 48) },
    ], { stopReason: "length" }), "LLM output was truncated before the final response completed", 1],
    ["empty", () => cerebrasResponse([]), "LLM returned empty response", 2],
    ["failed", () => cerebrasResponse([], { stopReason: "error", errorMessage: "upstream connect error" }),
      "upstream connect error", 1],
    ["interrupted", () => cerebrasResponse([{ type: "text", text: SUMMARY }], {
      stopReason: "aborted", errorMessage: "generation cancelled by the executor",
    }), "generation cancelled by the executor", 1],
  ];
  it.each(incomplete)("rejects a %s completion and leaves the history untouched", async (label, respond, failure, attempts) => {
    const pid = `compaction-summary-${label}`;
    const stub = await initProcess(pid, ROOT_IDENTITY);
    const outcome = await runInProcess(stub, async (process) => {
      const seeded = seedConversation(process);
      const provider = installCompactionProvider(process, pid, "process", respond);
      return { ...(await compact(process)), seeded, calls: provider.calls };
    });
    expect(outcome.result).toEqual({ ok: false, error: `Failed to generate compaction summary: ${failure}` });
    expect(outcome.calls).toBe(attempts);
    expect(outcome.history).toEqual(outcome.seeded);
    expect(outcome.segments).toBe(0);
    expect(outcome.archiveKeys).toEqual([]);
  });

  it("discards a completed summary that arrives after the compaction was cancelled", async () => {
    const pid = "compaction-summary-cancelled";
    const stub = await initProcess(pid, ROOT_IDENTITY);
    const outcome = await runInProcess(stub, async (process) => {
      const seeded = seedConversation(process);
      const controller = new AbortController();
      const provider = installCompactionProvider(process, pid, "process", () => {
        controller.abort(new Error("user stopped compaction"));
        return thinkingThenSummary();
      });
      return { ...(await compact(process, { signal: controller.signal })), seeded, calls: provider.calls };
    });
    expect(outcome.result).toEqual({ ok: false, error: "Compaction was cancelled" });
    expect(outcome.calls).toBe(1);
    expect(outcome.history).toEqual(outcome.seeded);
    expect(outcome.segments).toBe(0);
    expect(outcome.archiveKeys).toEqual([]);
  });
});
