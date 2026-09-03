import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { bodyFromText, bodyToText } from "@humansandmachines/gsv/protocol";
import { describe, expect, it } from "vitest";
import {
  captureSignals, mockGeneration, processTestConfig, generationRun, assistantResponse, runInProcess,
  ROOT_IDENTITY, initProcess, messageAction, mockRunEventSink, offeredTools, openAiChatSseChunk,
  responsibilityKernelResult, testUsage,
} from "./do-test-harness";

describe("model context", () => {
  it("keeps generation authoritative when the Kernel rejects stream attachment", async () => {
    const pid = "mech-chat-stream-rejected";
    const runId = "run-chat-stream-rejected";
    const stub = await initProcess(pid, ROOT_IDENTITY, { register: false });

    const response = await runInProcess(stub, async (process) => {
      const message = assistantResponse([{ type: "text", text: "still completed" }], {
          usage: {
              input: 1,
              output: 2,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 3,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          }
      });
      process.runs.active = { runId };
      process.generation = {
        stream() {
          const stream = createAssistantMessageEventStream();
          stream.push({
            type: "text_delta",
            contentIndex: 0,
            delta: "still completed",
            partial: message,
          });
          stream.push({ type: "done", reason: "stop", message });
          return stream;
        },
      };

      return await process.run.generateAssistantResponseLocally(
        {
          runId,
          config: processTestConfig(pid, {
            maxTokens: 1024,
            contextWindowTokens: 8192
          }),
          context: { systemPrompt: "", messages: [], tools: [] },
        },
        {
          installationId: "singleton",
          logicalRequestId: "inference:test-stream-rejected",
          actor: { localUid: 0, processId: pid, runId },
        },
      );
    });

    expect(response).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "still completed" }],
    });
  });

  it("does not open provider event streams from noninteractive workers", async () => {
    const pid = "mech-background-stream";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    const sink = await runInProcess(stub, async (process) => {
      process.store.state.setValue("interactive", "0");
      return await process.streams.openRunEventSink("run-background");
    });

    expect(sink).toBeNull();
  });

  it("retries streamed reasoning-only model turns with monotonic stream sequence numbers", async () => {
    const pid = "mech-chat-stream-retry";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    // SAFETY: test fixture is constructed with the asserted domain shape.

    const result = await runInProcess(stub, async (process) => {
      const emitted = captureSignals(process);
      let calls = 0;
      mockRunEventSink(process, pid, emitted);
      process.generation = {
        stream() {
          calls += 1;
          const stream = createAssistantMessageEventStream();
          // SAFETY: test fixture is constructed with the asserted domain shape.
          const base = {
            role: "assistant",
            content: [],
            api: "test",
            provider: "test",
            model: "test",
            usage: testUsage(),
            stopReason: "stop",
            timestamp: Date.now(),
            // SAFETY: test fixture is constructed with the asserted domain shape.
          } as any;
          stream.push({ type: "start", partial: base });

          if (calls === 1) {
            const partial = { ...base, content: [{ type: "thinking", thinking: "" }] };
            stream.push({ type: "thinking_start", contentIndex: 0, partial });
            partial.content[0].thinking = "thinking only";
            stream.push({
              type: "thinking_delta",
              contentIndex: 0,
              delta: "thinking only",
              partial,
            });
            stream.push({
              type: "thinking_end",
              contentIndex: 0,
              content: "thinking only",
              partial,
            });
            stream.push({
              type: "error",
              reason: "error",
              error: {
                ...partial,
                stopReason: "error",
                errorMessage: "Workers AI returned reasoning but no final response",
              },
            });
            return stream;
          }

          const partial = { ...base, content: [{ type: "text", text: "" }] };
          stream.push({ type: "text_start", contentIndex: 0, partial });
          partial.content[0].text = "visible retry";
          stream.push({ type: "text_delta", contentIndex: 0, delta: "visible retry", partial });
          stream.push({ type: "text_end", contentIndex: 0, content: "visible retry", partial });
          const toolCall = messageAction("visible retry", "streamed-visible-message");
          // SAFETY: test fixture is constructed with the asserted domain shape.
          partial.content.push(toolCall as any);
          partial.stopReason = "toolUse";
          stream.push({ type: "toolcall_start", contentIndex: 1, partial });
          stream.push({
            type: "toolcall_delta",
            contentIndex: 1,
            delta: JSON.stringify(toolCall.arguments),
            partial,
          });
          stream.push({ type: "toolcall_end", contentIndex: 1, toolCall, partial });
          stream.push({
            type: "done",
            reason: "toolUse",
            message: partial,
          });
          return stream;
        },
        async generate() {
          throw new Error("non-stream generation should not be used");
        },
        async generateText() {
          return "visible retry";
        },
      };

      process.store.messages.appendMessage("user", "stream retry please");
      process.runs.active = generationRun("run-chat-stream-retry", processTestConfig(pid, {
        provider: "workers-ai",
        model: "@cf/nvidia/nemotron-3-120b-a12b",
        reasoning: "high",
        contextWindowTokens: 256000
      }));
      await process.run.runTick("run-chat-stream-retry");
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
      ["user", "stream retry please"],
      ["assistant", "visible retry"],
    ]);
    // SAFETY: test fixture is constructed with the asserted domain shape.
    const streamSignals = result.emitted
      .filter((entry) => entry.signal === "proc.run.stream")
      // SAFETY: test fixture is constructed with the asserted domain shape.
      .map((entry) => entry.payload as any);
    expect(streamSignals.map((payload) => payload.event.type)).toEqual([
      "start",
      "thinking_start",
      "thinking_delta",
      "thinking_end",
      "error",
      "start",
      "text_start",
      "text_delta",
      "text_end",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_end",
      "done",
    ]);
    expect(streamSignals.map((payload) => payload.seq)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13,
    ]);
    // SAFETY: test fixture is constructed with the asserted domain shape.
    const outputSignal = result.emitted.find((entry) => entry.signal === "proc.run.output")
      ?.payload as any;
    expect(outputSignal?.text).toBe("visible retry");
  });

  it("emits a retrying signal before a streamed retry succeeds with only tool calls", async () => {
    const pid = "mech-chat-stream-retry-tool-only";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    // SAFETY: test fixture is constructed with the asserted domain shape.

    const result = await runInProcess(stub, async (process) => {
      const emitted = captureSignals(process);
      let calls = 0;
      mockRunEventSink(process, pid, emitted);
      process.generation = {
        stream() {
          calls += 1;
          const stream = createAssistantMessageEventStream();
          // SAFETY: test fixture is constructed with the asserted domain shape.
          const base = {
            role: "assistant",
            content: [],
            api: "test",
            provider: "test",
            model: "test",
            usage: testUsage(),
            stopReason: "stop",
            timestamp: Date.now(),
            // SAFETY: test fixture is constructed with the asserted domain shape.
          } as any;
          stream.push({ type: "start", partial: base });

          if (calls === 1) {
            const partial = { ...base, content: [{ type: "thinking", thinking: "" }] };
            stream.push({ type: "thinking_start", contentIndex: 0, partial });
            partial.content[0].thinking = "abandoned reasoning";
            stream.push({
              type: "thinking_delta",
              contentIndex: 0,
              delta: "abandoned reasoning",
              partial,
            });
            stream.push({
              type: "thinking_end",
              contentIndex: 0,
              content: "abandoned reasoning",
              partial,
            });
            stream.push({
              type: "error",
              reason: "error",
              error: {
                ...partial,
                stopReason: "error",
                errorMessage: "Workers AI returned reasoning but no final response",
              },
            });
            return stream;
          }

          const toolCall = {
            type: "toolCall",
            id: "call-retry-read",
            name: "Read",
            arguments: { path: "/root/retry.txt" },
          };
          const partial = { ...base, content: [toolCall], stopReason: "toolUse" };
          stream.push({ type: "toolcall_start", contentIndex: 0, partial });
          stream.push({
            type: "toolcall_delta",
            contentIndex: 0,
            delta: '{"path":"/root/retry.txt"}',
            partial,
          });
          stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial });
          stream.push({
            type: "done",
            reason: "toolUse",
            message: partial,
          });
          return stream;
        },
        async generate() {
          throw new Error("non-stream generation should not be used");
        },
        async generateText() {
          return "";
        },
      };

      process.store.messages.appendMessage("user", "stream retry to tool please");
      process.runs.active = generationRun("run-chat-stream-retry-tool-only", processTestConfig(pid, {
        provider: "workers-ai",
        model: "@cf/nvidia/nemotron-3-120b-a12b",
        reasoning: "high",
        contextWindowTokens: 256000
      }), {
        tools: offeredTools("Read"),
        systemPrompt: "Test system prompt.",
        approvalPolicy: {
          default: "auto",
          rules: [{ match: "fs.read", action: "ask" }],
        }
      });
      await process.run.runTick("run-chat-stream-retry-tool-only");
      return {
        calls,
        emitted,
        messages: process.store.messages.getMessages(),
        pendingHil: process.store.tools.getPendingHilForRun("run-chat-stream-retry-tool-only"),
      };
    });

    expect(result.calls).toBe(2);
    expect(result.messages.map((message: any) => [message.role, message.content])).toEqual([
      ["user", "stream retry to tool please"],
      ["assistant", ""],
    ]);
    const retrySignalIndex = result.emitted.findIndex(
      (entry) => entry.signal === "proc.run.retrying",
    );
    // SAFETY: test fixture is constructed with the asserted domain shape.
    const firstErrorIndex = result.emitted.findIndex(
      (entry) =>
        // SAFETY: test fixture is constructed with the asserted domain shape.
        entry.signal === "proc.run.stream" && (entry.payload as any).event.type === "error",
    );
    // SAFETY: test fixture is constructed with the asserted domain shape.
    const secondStartIndex = result.emitted.findIndex(
      (entry, index) =>
        index > retrySignalIndex &&
        entry.signal === "proc.run.stream" &&
        // SAFETY: test fixture is constructed with the asserted domain shape.
        (entry.payload as any).event.type === "start",
    );
    expect(firstErrorIndex).toBeGreaterThanOrEqual(0);
    expect(retrySignalIndex).toBeGreaterThan(firstErrorIndex);
    expect(secondStartIndex).toBeGreaterThan(retrySignalIndex);
    expect(result.emitted[retrySignalIndex]?.payload).toMatchObject({
      pid,
      runId: "run-chat-stream-retry-tool-only",
      attempt: 1,
      nextAttempt: 2,
      maxAttempts: 3,
      reason: "Workers AI returned reasoning but no final response",
    });
    expect(result.emitted.some((entry) => entry.signal === "proc.run.output")).toBe(false);
    expect(result.pendingHil).toMatchObject({
      runId: "run-chat-stream-retry-tool-only",
      toolCallId: "call-retry-read",
      toolName: "Read",
      syscall: "fs.read",
    });
  });

  it("uses non-streaming generation when generation streaming is disabled", async () => {
    const pid = "mech-chat-stream-off";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    const emitted = await runInProcess(stub, async (process) => {
      const emitted = captureSignals(process);
      process.generation = {
        stream() {
          throw new Error("stream generation should not be used");
        },
        async generate() {
          return assistantResponse([{ type: "text", text: "hello" }], {
              usage: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 0,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              }
          });
        },
        async generateText() {
          return "hello";
        },
      };

      process.store.messages.appendMessage("user", "do not stream");
      process.runs.active = generationRun("run-chat-stream-off", processTestConfig(pid, {
        provider: "workers-ai",
        model: "@cf/nvidia/nemotron-3-120b-a12b",
        contextWindowTokens: 256000,
        generationStreaming: "off"
      }));
      await process.run.runTick("run-chat-stream-off");
      return emitted;
    });

    // SAFETY: test fixture is constructed with the asserted domain shape.
    expect(
      (emitted as Array<{ signal: string }>).some((entry) => entry.signal === "proc.run.stream"),
    ).toBe(false);
    // SAFETY: test fixture is constructed with the asserted domain shape.
    const outputSignal = (emitted as Array<{ signal: string; payload: any }>).find(
      (entry) => entry.signal === "proc.run.output",
    );
    expect(outputSignal?.payload.text).toBe("hello");
  });

  it("routes kernel text executors through ai.text.generate", async () => {
    const pid = "mech-chat-kernel-executor";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    const result = await runInProcess(stub, async (process) => {
      const kernelCalls: Array<{ call: string; args: any }> = [];
      process.sendSignal = async () => {};
      process.kernel.kernelRpc = async (call: string, args: any) => {
        const responsibilityResult = responsibilityKernelResult(call);
        if (responsibilityResult) return responsibilityResult;
        if (call === "ai.context") {
          return {
            devices: [],
            mcpServers: [],
            system: { timezone: "UTC" },
            skillIndex: [],
            skillIndexMode: "off",
          };
        }
        kernelCalls.push({ call, args });
        if (call !== "ai.text.generate") {
          throw new Error(`unexpected kernel syscall: ${call}`);
        }
        return {
          message: assistantResponse([
              { type: "text", text: "kernel hello" },
              messageAction("kernel hello", "kernel-message"),
          ], {
              provider: "anthropic",
              model: "claude-process",
              usage: {
                  input: 4,
                  output: 2,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 6,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              }
          }),
          provider: "anthropic",
          model: "claude-process",
          text: "kernel hello",
        };
      };
      process.generation = {
        stream() {
          throw new Error("process-local stream should not be used");
        },
        async generate() {
          throw new Error("process-local generate should not be used");
        },
        async generateText() {
          throw new Error("process-local generateText should not be used");
        },
      };

      process.store.state.setAiConfig({
        version: 2,
        modelId: "fast-stack",
        updatedAt: 1,
      });
      process.store.messages.appendMessage("user", "use kernel");
      process.runs.active = generationRun("run-chat-kernel-executor", {
        executor: { kind: "kernel" },
        provider: "anthropic",
        model: "claude-process",
        apiKey: "",
        reasoning: "off",
        maxTokens: 8192,
        contextWindowTokens: 200000,
        contextWindowSource: "config",
        maxContextBytes: 32768,
        generationTimeoutMs: 180000,
        generationStreaming: "auto",
        capabilities: [],
      }, {
        tools: [
          {
            name: "Read",
            description: "Read a file",
            inputSchema: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
            },
          },
        ],
        systemPrompt: "Test system prompt."
      });
      await process.run.runTick("run-chat-kernel-executor");
      return {
        kernelCalls,
        messages: process.store.messages.getMessages(),
      };
    });

    expect(result.kernelCalls).toHaveLength(1);
    expect(result.kernelCalls[0]).toMatchObject({
      call: "ai.text.generate",
      args: {
        systemPrompt: "Test system prompt.",
        messages: [
          {
            role: "user",
            content: "use kernel",
          },
        ],
        tools: expect.arrayContaining([
          expect.objectContaining({ name: "Read" }),
          expect.objectContaining({ name: "Shell" }),
        ]),
        config: { modelId: "fast-stack" },
      },
    });
    expect(
      result.messages.findLast((message: any) => message.role === "assistant"),
    ).toMatchObject({
      role: "assistant",
      content: "kernel hello",
    });
  });

  it("routes device text executors through ai.text.generate target", async () => {
    const pid = "mech-chat-device-executor";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    const result = await runInProcess(stub, async (process) => {
      const kernelCalls: Array<{ call: string; args: any; runSignal: boolean }> = [];
      process.kernel.kernelRpc = async (call: string, args: any, signal?: AbortSignal) => {
        kernelCalls.push({
          call,
          args,
          runSignal: signal === process.run.runAbortSignal("run-chat-device-executor"),
        });
        return {
          message: assistantResponse([{ type: "text", text: "device routed" }], {
              provider: "device",
              model: "local-model",
              usage: {
                  input: 1,
                  output: 1,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 2,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              }
          }),
          provider: "device",
          model: "local-model",
          text: "device routed",
        };
      };
      mockGeneration(process, async () => {
        throw new Error("process-local generate should not be used");
      }, async () => {
        throw new Error("process-local generateText should not be used");
      });

      const message = await process.run.generateAssistantResponse({
        runId: "run-chat-device-executor",
        config: {
          executor: { kind: "device", target: "local-gpu" },
          provider: "device",
          model: "local-model",
          apiKey: "",
          maxTokens: 8192,
          contextWindowTokens: 200000,
          contextWindowSource: "config",
          maxContextBytes: 32768,
          generationTimeoutMs: 180000,
          capabilities: [],
        },
        context: {
          systemPrompt: "Test system prompt.",
          messages: [{ role: "user", content: "use device", timestamp: Date.now() }],
        },
        sessionAffinityKey: pid,
      });
      return { kernelCalls, message };
    });

    expect(result.kernelCalls).toHaveLength(1);
    expect(result.kernelCalls[0]).toMatchObject({
      call: "ai.text.generate",
      runSignal: true,
      args: {
        target: "local-gpu",
        systemPrompt: "Test system prompt.",
        messages: [
          {
            role: "user",
            content: "use device",
          },
        ],
      },
    });
    expect(result.message).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "device routed" }],
    });
  });

  it("routes process custom-provider fetches through the kernel device request path", async () => {
    const pid = "mech-chat-custom-provider-transport-target";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    const result = await runInProcess(stub, async (process) => {
      const deviceRequests: Array<{ target: string; call: string; args: any; ttlMs?: number }> =
        [];
      process.sendSignal = async () => {};
      process.kernel.kernelRpc = async (call: string, _args: any) => {
        const responsibilityResult = responsibilityKernelResult(call);
        if (responsibilityResult) return responsibilityResult;
        if (call === "ai.context") {
          return {
            devices: [],
            mcpServers: [],
            system: { timezone: "UTC" },
            skillIndex: [],
            skillIndexMode: "off",
          };
        }
        throw new Error(`unexpected synchronous kernel syscall: ${call}`);
      };
      process.kernel.requestKernelNetFetch = async (
        target: string,
        args: any,
        ttlMs?: number,
        requestBody?: any,
      ) => {
        deviceRequests.push({ target, call: "net.fetch", args, ttlMs });
        const requestText = requestBody ? await bodyToText(requestBody) : "";
        expect(target).toBe("linux-machine");
        expect(ttlMs).toBe(180000);
        expect(args).toMatchObject({
          url: "http://localhost:18081/v1/chat/completions",
          method: "POST",
          timeoutMs: 180000,
        });
        expect(JSON.parse(requestText)).toMatchObject({
          model: "local-chat",
          stream: true,
        });

        const body = [
          openAiChatSseChunk({
            id: "chatcmpl-device",
            model: "local-chat",
            choices: [{ delta: { content: "device hello" } }],
          }),
          openAiChatSseChunk({
            choices: [{ delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 3, completion_tokens: 2 },
          }),
          "data: [DONE]\n\n",
        ].join("");
        return {
          type: "res",
          id: "device-fetch",
          ok: true,
          data: {
            ok: true,
            url: args.url,
            status: 200,
            statusText: "OK",
            headers: { "content-type": "text/event-stream" },
            redirected: false,
          },
          body: bodyFromText(body),
        };
      };

      process.store.messages.appendMessage("user", "use local gateway");
      process.runs.active = {
        runId: "run-chat-custom-provider-transport-target",
        config: {
          executor: { kind: "process", pid },
          provider: "custom",
          model: "local-chat",
          apiKey: "",
          baseUrl: "http://localhost:18081/v1",
          providerStyle: "openai-chat-completions",
          transportTarget: "linux-machine",
          reasoning: "off",
          maxTokens: 8192,
          contextWindowTokens: 200000,
          contextWindowSource: "config",
          maxContextBytes: 32768,
          generationTimeoutMs: 180000,
          generationStreaming: "auto",
          capabilities: [],
        },
        tools: [],
        devices: [],
        systemPrompt: "Test system prompt.",
        approvalPolicy: { default: "auto", rules: [] },
      };
      await process.run.runTick("run-chat-custom-provider-transport-target");
      return {
        deviceRequests,
        messages: process.store.messages.getMessages(),
      };
    });

    expect(result.deviceRequests).toHaveLength(1);
    expect(
      result.messages.findLast((message: any) => message.role === "assistant"),
    ).toMatchObject({
      role: "assistant",
      content: "device hello",
    });
  });
});
