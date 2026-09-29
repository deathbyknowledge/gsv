import { describe, expect, it, vi } from "vitest";
import type { AiConfigResult } from "@humansandmachines/gsv/protocol";
import type { Process } from "./do";
import {
  assistantResponse, captureSignals, generationRun, initProcess, messageAction,
  mockGeneration, processTestConfig, ROOT_IDENTITY, runInProcess,
} from "./do-test-harness";
import { parseMessageMetadata, stringifyMessageMetadata } from "./storage/metadata-codec";
import { z } from "zod";

const reason = "Provider validation failed: " + "x".repeat(1_200_000);

describe("retained fallback diagnostics", () => {
  it.each(["throw", "response"])("bounds a %s failure before announcement and persistence", async (failureMode) => {
    const pid = `fallback-diagnostic-${failureMode}`;
    const runId = `${pid}-run`;
    const stub = await initProcess(pid, ROOT_IDENTITY);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const observed = await runInProcess(stub, async (process: Process) => {
        const emitted = captureSignals(process);
        let calls = 0;
        mockGeneration(process, async (request: { config: AiConfigResult }) => {
          calls += 1;
          if (calls === 1) {
            if (failureMode === "throw") throw new Error(reason);
            return assistantResponse([], { stopReason: "error", errorMessage: reason });
          }
          return assistantResponse([
            { type: "text", text: "Fallback completed." },
            messageAction("Fallback completed.", "fallback-diagnostic-send"),
          ], { provider: request.config.provider, model: request.config.model });
        }, async () => "unused");
        process.store.messages.appendMessage("user", "Synthetic fallback check", { runId });
        process.runs.active = generationRun(runId, processTestConfig(pid, {
          provider: "openai-codex", model: "gpt-6-astra", apiKey: "synthetic-primary",
          fallbacks: [{
            modelId: "fallback", modelName: "Fallback", provider: "openrouter", model: "test/model",
            apiKey: "synthetic-fallback", providerStyle: "openai-chat-completions", transportTarget: "gsv",
            maxTokens: 4096, contextWindowTokens: 128000, contextWindowSource: "config",
            generationTimeoutMs: 180000, generationStreaming: "auto",
          }],
        }));
        await process.run.runTick(runId);
        const assistant = process.store.messages.getMessages().find((message) => message.role === "assistant");
        return {
          calls, active: process.runs.active !== null,
          metadata: parseMessageMetadata(assistant?.metadata),
          retry: emitted.find((entry) => entry.signal === "proc.run.retrying")?.payload,
        };
      });
      const fallback = observed.metadata?.fallback;
      expect(fallback?.reason?.length).toBeLessThanOrEqual(4096);
      expect(fallback).toMatchObject({
        used: true,
        from: { provider: "openai-codex", model: "gpt-6-astra" },
        to: { provider: "openrouter", model: "test/model" },
      });
      expect(fallback?.reason?.startsWith("Provider validation failed: ")).toBe(true);
      expect(fallback?.reason?.endsWith(`[truncated; original length ${reason.length} characters]`)).toBe(true);
      expect(z.object({ reason: z.string() }).parse(observed.retry).reason).toBe(fallback?.reason);
      expect(observed.calls).toBe(2);
      expect(observed.active).toBe(false);
      expect(warning.mock.calls.some((args) => args.some((value) => String(value).length > 4300))).toBe(false);
    } finally {
      warning.mockRestore();
    }
  });

  it("preserves full existing diagnostics through metadata read and import serialization", () => {
    const raw = JSON.stringify({ fallback: {
      used: true, from: { provider: "old-provider", model: "old-model" }, reason,
    } });
    expect(parseMessageMetadata(raw)?.fallback?.reason).toBe(reason);
    expect(parseMessageMetadata(stringifyMessageMetadata(raw))?.fallback?.reason).toBe(reason);
  });
});
