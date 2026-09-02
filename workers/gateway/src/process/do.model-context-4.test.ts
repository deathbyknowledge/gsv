import type {
  ProcessResourceWriteRequestFrame, ProcessRunAttachRequestFrame,
} from "../protocol/process-frames";
import { bodyFromBytes } from "@humansandmachines/gsv/protocol";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import {
  captureSignals, mockGeneration, processTestConfig, generationRun, assistantResponse, runInProcess,
  ROOT_IDENTITY, initProcess, messageAction, offeredTools, setHistoryPolicy, testUsage,
} from "./do-test-harness";

describe("model context", () => {
  it("persists active-run reply media on the final assistant message and signals", async () => {
    const pid = "mech-final-reply-media";
    const stub = await initProcess(pid, ROOT_IDENTITY);
    const uploaded = await stub.recvFrame({
      type: "req",
      id: crypto.randomUUID(),
      call: "proc.resource.write",
      args: {
        resourceId: "final-report",
        mediaType: "document",
        contentType: "application/pdf",
        filename: "report.pdf",
      },
      body: bodyFromBytes(new Uint8Array([1, 2, 3])),
    } satisfies ProcessResourceWriteRequestFrame);
    if (!uploaded.ok) throw new Error(uploaded.error.message);
    const resource = uploaded.data.resource;
    const result = await runInProcess(stub, async (process) => {
      const emitted = captureSignals(process);
      mockGeneration(process, async () => {
        return assistantResponse([
          { type: "text", text: "Here is the report." },
          messageAction("Here is the report.", "report-message"),
        ]);
      }, async () => {
        return "unused";
      });
      process.store.messages.appendMessage("user", "Send the report.");
      process.runs.active = generationRun("run-final-reply-media", processTestConfig(pid, {
        provider: "workers-ai",
        model: "@cf/test/model",
        contextWindowTokens: 256000
      }));

      const attach = await process.recvFrame({
        type: "req",
        id: crypto.randomUUID(),
        call: "proc.run.attach",
        args: {
          runId: "run-final-reply-media",
          media: [resource],
        },
      } satisfies ProcessRunAttachRequestFrame);
      await process.run.runTick("run-final-reply-media");
      const history = await process.controller.handleProcHistory({});
      return {
        attach,
        emitted,
        history,
        messages: process.store.messages.getMessages(),
      };
    });

    expect(result.attach).toMatchObject({
      ok: true,
      data: {
        ok: true,
        runId: "run-final-reply-media",
        media: [{ type: "resource", ref: { path: resource.ref.path } }],
      },
    });
    expect(
      result.messages.findLast((message: any) => message.role === "assistant"),
    ).toMatchObject({
      role: "assistant",
      content: "Here is the report.",
      media: expect.stringMatching(/root\/\.gsv\/media\/archived-media:[0-9a-f]{64}/),
    });
    expect(result.history).toMatchObject({
      ok: true,
      messages: expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          content: expect.objectContaining({
            text: "Here is the report.",
            media: [
              expect.objectContaining({
                key: expect.stringMatching(/^root\/\.gsv\/media\/archived-media:[0-9a-f]{64}$/),
                path: expect.stringMatching(
                  /^\/root\/\.gsv\/media\/archived-media:[0-9a-f]{64}$/,
                ),
              }),
            ],
          }),
        }),
      ]),
    });
    expect(
      result.emitted.find((entry) => entry.signal === "proc.run.output")?.payload,
    ).toMatchObject({
      runId: "run-final-reply-media",
      media: [
        expect.objectContaining({
          type: "resource",
          ref: expect.objectContaining({
            path: expect.stringMatching(/^\/root\/\.gsv\/media\/archived-media:[0-9a-f]{64}$/),
          }),
        }),
      ],
    });
    expect(
      result.emitted.find((entry) => entry.signal === "proc.run.finished")?.payload,
    ).toMatchObject({
      runId: "run-final-reply-media",
      result: {
        text: "Here is the report.",
      },
    });
    const finishedPayload = result.emitted.find(
      (entry) => entry.signal === "proc.run.finished",
    )?.payload;
    expect(finishedPayload).not.toHaveProperty("result.media");
    // SAFETY: test fixture is constructed with the asserted domain shape.
    const archivedKey = (result.history as any).messages
      .find((message: any) => message.role === "assistant")
      .content.media[0].path.replace(/^\/+/, "");
    const archived = await env.STORAGE.get(archivedKey);
    expect(archived && [...new Uint8Array(await archived.arrayBuffer())]).toEqual([1, 2, 3]);
  });

  it("keeps distinct immutable archives when a live media key is reused", async () => {
    const pid = "mech-immutable-media-identity";
    const stub = await initProcess(pid, ROOT_IDENTITY);
    const liveKey = `var/media/0/${pid}/reused`;

    await env.STORAGE.put(liveKey, new Uint8Array([1, 2, 3]), {
      httpMetadata: { contentType: "image/png" },
    });
    // SAFETY: test fixture is constructed with the asserted domain shape.
    const firstKey = await runInProcess(stub, async (process) => {
      const rewrites = await process.resources.persistArchivedMediaKeys([liveKey]);
      // SAFETY: test fixture is constructed with the asserted domain shape.
      return rewrites.get(liveKey).key as string;
    });

    await env.STORAGE.put(liveKey, new Uint8Array([9, 8, 7]), {
      httpMetadata: { contentType: "image/png" },
    });
    // SAFETY: test fixture is constructed with the asserted domain shape.
    const secondKey = await runInProcess(stub, async (process) => {
      const rewrites = await process.resources.persistArchivedMediaKeys([liveKey]);
      // SAFETY: test fixture is constructed with the asserted domain shape.
      return rewrites.get(liveKey).key as string;
    });

    expect(secondKey).not.toBe(firstKey);
    const first = await env.STORAGE.get(firstKey);
    const second = await env.STORAGE.get(secondKey);
    expect(first && [...new Uint8Array(await first.arrayBuffer())]).toEqual([1, 2, 3]);
    expect(second && [...new Uint8Array(await second.arrayBuffer())]).toEqual([9, 8, 7]);
  });

  it("rejects an existing archive whose ownership metadata is incomplete", async () => {
    const pid = "mech-archive-media-ownership";
    const stub = await initProcess(pid, ROOT_IDENTITY);
    const liveKey = `var/media/0/${pid}/report`;
    await env.STORAGE.put(liveKey, new Uint8Array([1, 2, 3]), {
      httpMetadata: { contentType: "application/pdf" },
    });
    // SAFETY: test fixture is constructed with the asserted domain shape.
    const archivedKey = await runInProcess(stub, async (process) => {
      const rewrites = await process.resources.persistArchivedMediaKeys([liveKey]);
      // SAFETY: test fixture is constructed with the asserted domain shape.
      return rewrites.get(liveKey).key as string;
    });
    const source = await env.STORAGE.head(liveKey);
    expect(source).not.toBeNull();
    await env.STORAGE.put(archivedKey, new Uint8Array([1, 2, 3]), {
      httpMetadata: { contentType: "application/pdf" },
      customMetadata: {
        purpose: "conversation-media",
        sourceEtag: source!.etag,
      },
    });

    await expect(
      runInProcess(stub, async (process) => {
        return process.resources.persistArchivedMediaKeys([liveKey]);
      }),
    ).rejects.toThrow("archived media content-address collision");
  });

  it("rejects an archive without immutable source metadata", async () => {
    const pid = "mech-archive-media-read-metadata";
    const stub = await initProcess(pid, ROOT_IDENTITY);
    const key = `root/.gsv/media/archived-media:${"c".repeat(64)}`;
    await env.STORAGE.put(key, new Uint8Array([1, 2, 3]), {
      httpMetadata: { contentType: "image/png" },
      customMetadata: {
        uid: "0",
        gid: "0",
        mode: "400",
        purpose: "conversation-media",
      },
    });

    const object = await env.STORAGE.head(key);
    const valid = await runInProcess(stub, (process) => {
      return process.resources.isValidOwnedArchiveObject(key, object);
    });
    expect(valid).toBe(false);
  });

  it("keeps immutable source media when the run aborts before a final answer", async () => {
    const pid = "mech-aborted-reply-media";
    const stub = await initProcess(pid, ROOT_IDENTITY);
    const uploaded = await stub.recvFrame({
      type: "req",
      id: crypto.randomUUID(),
      call: "proc.resource.write",
      args: {
        resourceId: "unfinished-report",
        mediaType: "document",
        contentType: "application/pdf",
        filename: "report.pdf",
      },
      body: bodyFromBytes(new Uint8Array([1])),
    } satisfies ProcessResourceWriteRequestFrame);
    if (!uploaded.ok) throw new Error(uploaded.error.message);
    const resource = uploaded.data.resource;
    const key = resource.ref.path.replace(/^\/+/, "");

    await runInProcess(stub, async (process) => {
      process.sendSignal = vi.fn(async () => {});
      process.runs.active = {
        runId: "run-aborted-reply-media",
      };
      const attach = await process.recvFrame({
        type: "req",
        id: crypto.randomUUID(),
        call: "proc.run.attach",
        args: {
          runId: "run-aborted-reply-media",
          media: [resource],
        },
      } satisfies ProcessRunAttachRequestFrame);
      expect(attach).toMatchObject({ ok: true, data: { ok: true } });
      const abort = await process.controller.handleProcAbort({
        runId: "run-aborted-reply-media",
      });
      expect(abort).toMatchObject({ ok: true, aborted: true });
    });

    expect(await env.STORAGE.head(key)).not.toBeNull();
  });

  it("retries reasoning-only model turns", async () => {
    const pid = "mech-chat-thinking-only";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    const result = await runInProcess(stub, async (process) => {
      const emitted = captureSignals(process);
      let calls = 0;
      mockGeneration(process, async () => {
        calls += 1;
        if (calls === 1) {
          return assistantResponse([
            { type: "thinking", thinking: "I found the answer but never emitted it." },
          ], {
            usage: {
              ...testUsage(100, 0),
              cost: {
                input: 0.00005,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0.00005,
              },
            }
          });
        }
        return assistantResponse([
          { type: "text", text: "visible answer" },
          messageAction("visible answer", "visible-answer-message"),
        ], {
          usage: {
            ...testUsage(50, 10),
            cost: {
              input: 0.000025,
              output: 0.000015,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0.00004,
            },
          }
        });
      }, async () => {
        return "unused";
      });

      process.store.messages.appendMessage("user", "answer visibly");
      process.runs.active = generationRun("run-chat-thinking-only", processTestConfig(pid, {
        provider: "workers-ai",
        model: "@cf/nvidia/nemotron-3-120b-a12b",
        reasoning: "high",
        contextWindowTokens: 256000
      }));
      await process.run.runTick("run-chat-thinking-only");
      return {
        calls,
        emitted,
        contextState: process.store.state.getContextState(),
        historyUsage: process.store.state.getHistoryUsage(),
        messages: process.store.messages.getMessages(),
      };
    });

    expect(result.calls).toBe(2);
    expect(
      result.messages
        .filter((message: any) => message.role !== "toolResult")
        .map((message: any) => [message.role, message.content]),
    ).toEqual([
      ["user", "answer visibly"],
      ["assistant", "visible answer"],
    ]);
    expect(result.historyUsage).toMatchObject({
      inputTokens: 150,
      outputTokens: 10,
      totalTokens: 160,
      cost: { total: 0.00009, source: "model-pricing" },
      generations: 2,
    });
    expect(result.contextState?.historyUsage).toMatchObject({
      inputTokens: 150,
      outputTokens: 10,
      cost: { total: 0.00009, source: "model-pricing" },
    });
    // SAFETY: test fixture is constructed with the asserted domain shape.
    const output = result.emitted.find((entry) => entry.signal === "proc.run.output")
      ?.payload as any;
    expect(output?.text).toBe("visible answer");
    // SAFETY: test fixture is constructed with the asserted domain shape.
    const finished = result.emitted.find((entry) => entry.signal === "proc.run.finished")
      ?.payload as any;
    expect(finished).toMatchObject({
      status: "ok",
      reason: "run.yielded",
      result: { text: "visible answer" },
      delivery: { kind: "message" },
    });
  });

  it("fails reasoning-only model turns after retry attempts are exhausted", async () => {
    const pid = "mech-chat-thinking-only-exhausted";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    const result = await runInProcess(stub, async (process) => {
      const emitted = captureSignals(process);
      let calls = 0;
      mockGeneration(process, async () => {
        calls += 1;
        return assistantResponse([{ type: "thinking", thinking: "I found the answer but never emitted it." }]);
      }, async () => {
        return "unused";
      });

      process.store.messages.appendMessage("user", "answer visibly");
      process.runs.active = generationRun("run-chat-thinking-only-exhausted", processTestConfig(pid, {
        provider: "workers-ai",
        model: "@cf/nvidia/nemotron-3-120b-a12b",
        reasoning: "high",
        contextWindowTokens: 256000
      }));
      await process.run.runTick("run-chat-thinking-only-exhausted");
      return {
        calls,
        emitted,
        messages: process.store.messages.getMessages(),
      };
    });

    expect(result.calls).toBe(3);
    expect(result.messages.map((message: any) => [message.role, message.content])).toEqual([
      ["user", "answer visibly"],
      ["system", "Generation failed: LLM returned reasoning but no final response"],
    ]);
    // SAFETY: test fixture is constructed with the asserted domain shape.
    const finished = result.emitted.find((entry) => entry.signal === "proc.run.finished")
      ?.payload as any;
    expect(finished).toMatchObject({
      status: "error",
      reason: "generation.empty",
      error: "Generation failed: LLM returned reasoning but no final response",
    });
  });

  it("retries thrown empty-final provider errors", async () => {
    const pid = "mech-chat-empty-final-throw";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    const result = await runInProcess(stub, async (process) => {
      const emitted = captureSignals(process);
      let calls = 0;
      mockGeneration(process, async () => {
        calls += 1;
        if (calls === 1) {
          throw new Error("LLM returned reasoning but no final response");
        }
        return assistantResponse([
          { type: "text", text: "recovered" },
          messageAction("recovered", "provider-recovery-message"),
        ]);
      }, async () => {
        return "unused";
      });

      process.store.messages.appendMessage("user", "recover please");
      process.runs.active = generationRun("run-chat-empty-final-throw", processTestConfig(pid, {
        provider: "openai",
        model: "gpt-test",
        apiKey: "test-key",
        reasoning: "high"
      }));
      await process.run.runTick("run-chat-empty-final-throw");
      return {
        calls,
        emitted,
        messages: process.store.messages.getMessages(),
      };
    });

    expect(result.calls).toBe(2);
    expect(
      result.messages
        .filter((message: any) => message.role !== "toolResult")
        .map((message: any) => [message.role, message.content]),
    ).toEqual([
      ["user", "recover please"],
      ["assistant", "recovered"],
    ]);
    // SAFETY: test fixture is constructed with the asserted domain shape.
    const finished = result.emitted.find((entry) => entry.signal === "proc.run.finished")
      ?.payload as any;
    expect(finished).toMatchObject({
      status: "ok",
      reason: "run.yielded",
      result: { text: "recovered" },
      delivery: { kind: "message" },
    });
  });

  // SAFETY: test fixture is constructed with the asserted domain shape.
  it("retries raw tool-call markup returned as final text", async () => {
    const pid = "mech-chat-tool-markup-text";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    const result = await runInProcess(stub, async (process) => {
      const emitted = captureSignals(process);
      let calls = 0;
      process.generation = {
        async generate() {
          calls += 1;
          if (calls === 1) {
            return assistantResponse([
                {
                    type: "text",
                    text: "<tool_call>Shell<arg_key>input</arg_key><arg_value>pwd</arg_value><arg_key>target</arg_key><arg_value>gsv</arg_value></tool_call>",
                },
            ]);
          }
          return assistantResponse([
              {
                  type: "toolCall",
                  id: "call-retry-shell",
                  name: "Shell",
                  arguments: { input: "pwd", target: "gsv" },
              },
          ], {
              stopReason: "toolUse"
          });
        },
        async generateText() {
          return "unused";
        },
      };

      process.store.messages.appendMessage("user", "run pwd");
      process.runs.active = generationRun("run-chat-tool-markup-text", processTestConfig(pid, {
        provider: "openai",
        model: "gpt-test",
        apiKey: "test-key",
        reasoning: "high"
      }), {
        tools: offeredTools("Shell"),
        systemPrompt: "Test system prompt.",
        approvalPolicy: {
          default: "auto",
          rules: [{ match: "shell.exec", action: "ask" }],
        }
      });
      await process.run.runTick("run-chat-tool-markup-text");
      return {
        calls,
        emitted,
        messages: process.store.messages.getMessages(),
        pendingHil: process.store.tools.getPendingHilForRun("run-chat-tool-markup-text"),
      };
    });

    expect(result.calls).toBe(2);
    expect(result.messages.map((message: any) => [message.role, message.content])).toEqual([
      ["user", "run pwd"],
      ["assistant", ""],
    ]);
    // SAFETY: test fixture is constructed with the asserted domain shape.
    const retry = result.emitted.find((entry) => entry.signal === "proc.run.retrying")
      ?.payload as any;
    expect(retry).toMatchObject({
      pid,
      runId: "run-chat-tool-markup-text",
      attempt: 1,
      nextAttempt: 2,
      maxAttempts: 3,
      // SAFETY: test fixture is constructed with the asserted domain shape.
      reason: "LLM returned malformed tool call markup as final text",
    });
    expect(result.pendingHil).toMatchObject({
      runId: "run-chat-tool-markup-text",
      toolCallId: "call-retry-shell",
      toolName: "Shell",
      syscall: "shell.exec",
    });
  });

  it("does not retry explicit returned provider errors with empty content", async () => {
    const pid = "mech-chat-provider-error-response";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    const result = await runInProcess(stub, async (process) => {
      const emitted = captureSignals(process);
      let calls = 0;
      mockGeneration(process, async () => {
        calls += 1;
        return assistantResponse([], {
          provider: "workers-ai",
          stopReason: "error",
          errorMessage: "Workers AI binding is not configured for this worker"
        });
      }, async () => {
        return "unused";
      });

      process.store.messages.appendMessage("user", "fail once please");
      process.runs.active = generationRun("run-chat-provider-error-response", processTestConfig(pid, {
        provider: "workers-ai",
        model: "@cf/nvidia/nemotron-3-120b-a12b",
        reasoning: "high",
        contextWindowTokens: 256000
      }));
      await process.run.runTick("run-chat-provider-error-response");
      return {
        calls,
        emitted,
        messages: process.store.messages.getMessages(),
      };
    });

    expect(result.calls).toBe(1);
    expect(result.emitted.some((entry) => entry.signal === "proc.run.retrying")).toBe(false);
    expect(result.messages.map((message: any) => [message.role, message.content])).toEqual([
      ["user", "fail once please"],
      ["system", "Generation failed: Workers AI binding is not configured for this worker"],
    ]);
    // SAFETY: test fixture is constructed with the asserted domain shape.
    const finished = result.emitted.find((entry) => entry.signal === "proc.run.finished")
      ?.payload as any;
    expect(finished).toMatchObject({
      status: "error",
      reason: "generation.empty",
      error: "Generation failed: Workers AI binding is not configured for this worker",
    });
  });

  it("switches to a fallback model after an explicit provider error response", async () => {
    const pid = "mech-chat-provider-error-fallback";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    const result = await runInProcess(stub, async (process) => {
      const emitted = captureSignals(process);
      const calls: Array<{ provider: string; model: string; accountId?: string }> = [];
      mockGeneration(process, async (request: any) => {
        calls.push({
          provider: request.config.provider,
          model: request.config.model,
          accountId: request.config.openAiCodex?.accountId,
        });
        if (calls.length === 1) {
          return assistantResponse([], {
            provider: request.config.provider,
            model: request.config.model,
            stopReason: "error",
            errorMessage: "Custom provider HTTP 403: not authenticated",
            usage: testUsage(1, 0)
          });
        }
        return assistantResponse([
          { type: "text", text: "fallback pong" },
          messageAction("fallback pong", "fallback-message"),
        ], {
          provider: request.config.provider,
          model: request.config.model,
          usage: testUsage(2, 3)
        });
      }, async () => {
        return "unused";
      });

      process.store.messages.appendMessage("user", "fail over please");
      process.runs.active = generationRun("run-chat-provider-error-fallback", processTestConfig(pid, {
        provider: "custom",
        model: "zai-glm-4.7",
        apiKey: "bad-key",
        openAiCodex: { accountId: "primary-account" },
        reasoning: "high",
        contextWindowTokens: 256000,
        fallbacks: [
          {
            modelId: "safe-stack",
            modelName: "Safe Stack",
            provider: "openrouter",
            model: "openai/gpt-5-mini",
            apiKey: "fallback-key",
            providerStyle: "openai-chat-completions",
            transportTarget: "gsv",
            maxTokens: 4096,
            contextWindowTokens: 128000,
            contextWindowSource: "config",
            generationTimeoutMs: 180000,
            generationStreaming: "auto",
          },
        ]
      }));
      await process.run.runTick("run-chat-provider-error-fallback");
      return {
        calls,
        emitted,
        messages: process.store.messages.getMessages(),
      };
    });

    expect(result.calls).toEqual([
      { provider: "custom", model: "zai-glm-4.7", accountId: "primary-account" },
      { provider: "openrouter", model: "openai/gpt-5-mini", accountId: undefined },
    ]);
    expect(
      result.messages
        .filter((message: any) => message.role !== "toolResult")
        .map((message: any) => [message.role, message.content]),
    ).toEqual([
      ["user", "fail over please"],
      ["assistant", "fallback pong"],
    ]);
    const assistant = result.messages.find((message: any) => message.role === "assistant");
    expect(JSON.parse(assistant.metadata)).toMatchObject({
      fallback: {
        used: true,
        from: { provider: "custom", model: "zai-glm-4.7" },
        to: { provider: "openrouter", model: "openai/gpt-5-mini" },
        reason: "Custom provider HTTP 403: not authenticated",
      },
    });
    // SAFETY: test fixture is constructed with the asserted domain shape.
    const retry = result.emitted.find((entry) => entry.signal === "proc.run.retrying")
      ?.payload as any;
    expect(retry).toMatchObject({
      pid,
      runId: "run-chat-provider-error-fallback",
      reason: "Custom provider HTTP 403: not authenticated",
      fallback: {
        from: { provider: "custom", model: "zai-glm-4.7" },
        to: { provider: "openrouter", model: "openai/gpt-5-mini" },
      },
    });
    // SAFETY: test fixture is constructed with the asserted domain shape.
    const finished = result.emitted.find((entry) => entry.signal === "proc.run.finished")
      ?.payload as any;
    expect(finished).toMatchObject({
      status: "ok",
      reason: "run.yielded",
    });
  });

  it("reapplies context policy after switching to a smaller fallback model", async () => {
    const pid = "mech-chat-fallback-auto-compact";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    const result = await runInProcess(stub, async (process) => {
      const emitted = captureSignals(process);
      const calls: Array<{ provider: string; model: string; context: string }> = [];
      const compactionConfigs: Array<{ provider: string; model: string }> = [];
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
            stopReason: "error",
            errorMessage: "Custom provider HTTP 403: not authenticated",
            usage: testUsage(1, 0)
          });
        }
        return assistantResponse([
          { type: "text", text: "fallback after compaction" },
          messageAction("fallback after compaction", "fallback-compaction-message"),
        ], {
          provider: request.config.provider,
          model: request.config.model,
          usage: testUsage(20, 3)
        });
      }, async (request: any) => {
        compactionConfigs.push({
          provider: request.config.provider,
          model: request.config.model,
        });
        expect(JSON.stringify(request.context)).toContain("old context A");
        return "Fallback compact summary.";
      });

      process.store.messages.appendMessage("user", `old context A ${"x".repeat(4000)}`);
      process.store.messages.appendMessage("assistant", `old context B ${"y".repeat(4000)}`);
      process.store.messages.appendMessage("user", "Context that must stay live.", {
        runId: "run-chat-fallback-auto-compact",
      });
      setHistoryPolicy(process, { compactAtPressure: 0.5 });
      process.runs.active = generationRun("run-chat-fallback-auto-compact", processTestConfig(pid, {
        provider: "custom",
        model: "large-primary",
        apiKey: "bad-key",
        maxTokens: 100,
        contextWindowTokens: 100000,
        fallbacks: [
          {
            modelId: "small-fallback",
            modelName: "Small Fallback",
            provider: "openrouter",
            model: "small-fallback",
            apiKey: "fallback-key",
            providerStyle: "openai-chat-completions",
            transportTarget: "gsv",
            maxTokens: 100,
            contextWindowTokens: 1000,
            contextWindowSource: "config",
            generationTimeoutMs: 180000,
            generationStreaming: "auto",
          },
        ]
      }));
      await process.run.runTick("run-chat-fallback-auto-compact");
      return {
        calls,
        compactionConfigs,
        emitted,
        messages: process.store.messages.getMessages(),
        segments: process.store.history.listHistorySegments(),
      };
    });

    expect(result.calls).toHaveLength(2);
    expect(result.calls[0]).toMatchObject({ provider: "custom", model: "large-primary" });
    expect(result.calls[0].context).toContain("old context A");
    expect(result.calls[0].context).not.toContain("Fallback compact summary.");
    expect(result.calls[1]).toMatchObject({ provider: "openrouter", model: "small-fallback" });
    expect(result.calls[1].context).toContain("Fallback compact summary.");
    expect(result.calls[1].context).toContain("Context that must stay live.");
    expect(result.calls[1].context).toContain("Context runway is getting low.");
    expect(result.calls[1].context).not.toContain("old context A");
    expect(result.compactionConfigs).toEqual([
      { provider: "openrouter", model: "small-fallback" },
    ]);
    expect(
      result.messages
        .filter((message: any) => message.role !== "toolResult")
        .map((message: any) => [message.role, message.content]),
    ).toEqual([
      ["system", expect.stringContaining("Fallback compact summary.")],
      ["user", "Context that must stay live."],
      ["system", expect.stringContaining("Context runway is getting low.")],
      ["assistant", "fallback after compaction"],
    ]);
    expect(result.segments).toHaveLength(1);
    // SAFETY: test fixture is constructed with the asserted domain shape.
    const lifecycleEvents = result.emitted
      .filter((entry) => entry.signal === "proc.changed")
      // SAFETY: test fixture is constructed with the asserted domain shape.
      .map((entry) => (entry.payload as any).event)
      .filter(Boolean);
    expect(lifecycleEvents).toEqual([
      "history.compacted",
      "history.auto_compacted",
      "context.runway",
    ]);
  });
});
