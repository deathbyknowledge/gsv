import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { env, runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { Process } from "./do";
import { Kernel } from "../kernel/do";
import type { ProcessIdentity } from "@humansandmachines/gsv/protocol";
import type { RequestFrame, ResponseFrame, ResponseOkFrame } from "../protocol/frames";
import { getProcessByPid, getKernelPtr } from "../shared/utils";

const ROOT_IDENTITY: ProcessIdentity = {
  uid: 0,
  gid: 0,
  gids: [0],
  username: "root",
  home: "/root",
  cwd: "/root",
};
const DEFAULT_PROFILE = "task" as const;
const GENERATION_SERVICE_MARKER = "__gsvGenerationService";

function makeReq(call: string, args: unknown): RequestFrame {
  return { type: "req", id: crypto.randomUUID(), call, args } as RequestFrame;
}

function isTransientProviderFailure(content: string): boolean {
  return content.startsWith("Generation failed: An error occurred while processing your request.")
    && content.includes("You can retry your request")
    && content.includes("request ID");
}

function skipTransientProviderFailure(messages: Array<{ role: string; content: string }>): boolean {
  const failure = messages.find((message) =>
    message.role === "system" && isTransientProviderFailure(message.content)
  );
  if (!failure) {
    return false;
  }
  console.warn(`[test] ignoring transient provider failure: ${failure.content}`);
  return true;
}

function visibleAssistantText(messages: Array<{ role: string; content: string }>): string {
  return messages
    .filter((message) => message.role === "assistant" && message.content.trim().length > 0)
    .map((message) => message.content)
    .join("\n");
}

function testUsage(input = 0, output = 0) {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

async function stubGeneration(
  stub: DurableObjectStub<Process>,
  generate: (request: any) => string | Promise<string>,
) {
  await runInDurableObject(stub, (instance: Process) => {
    const process = instance as any;
    process.generation = {
      [GENERATION_SERVICE_MARKER]: true,
      async generate(request: any) {
        const text = await generate(request);
        return {
          role: "assistant",
          content: [{ type: "text", text }],
          api: "test",
          provider: "test",
          model: "test",
          stopReason: "stop",
          timestamp: Date.now(),
        };
      },
      async generateText() {
        return "";
      },
    };
  });
}

/**
 * Register a process in the Kernel's ProcessRegistry and seed capabilities.
 * Must be called before the Process DO can communicate with the kernel.
 */
async function registerInKernel(pid: string, identity: ProcessIdentity) {
  const kernel = await getKernelPtr();
  await runInDurableObject(kernel, (instance: Kernel) => {
    const k = instance as any;
    k.caps.seed();
    k.procs.spawn(pid, identity, { profile: DEFAULT_PROFILE });
  });
}

/**
 * Poll until the Process DO's currentRun is null (run finished).
 * The agents SDK alarm handler does cross-DO async work that isn't
 * fully awaited by runDurableObjectAlarm, so we poll.
 */
async function waitForRunComplete(
  stub: DurableObjectStub<Process>,
  timeoutMs = 5000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const done = await runInDurableObject(stub, (instance: Process) => {
      return (instance as any).store.getValue("currentRun") === null;
    });
    if (done) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Timed out waiting for run to complete");
}

async function driveProcessUntilIdle(
  stub: DurableObjectStub<Process>,
  timeoutMs = 50_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await runDurableObjectAlarm(stub);
    const done = await runInDurableObject(stub, (instance: Process) => {
      return (instance as any).store.getValue("currentRun") === null;
    });
    if (done) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Timed out driving process to idle");
}

/**
 * Initialize a Process DO with identity (via proc.setidentity RPC).
 * Optionally registers it in the kernel first.
 */
async function initProcess(pid: string, identity: ProcessIdentity, opts?: { register?: boolean }) {
  if (opts?.register !== false) {
    await registerInKernel(pid, identity);
  }
  const stub = await getProcessByPid(pid);
  const res = await stub.recvFrame(makeReq("proc.setidentity", { pid, identity, profile: DEFAULT_PROFILE }));
  expect((res as ResponseFrame).ok).toBe(true);
  return stub;
}

// ---------------------------------------------------------------------------
// Tier 1: Mechanical tests (no LLM)
// ---------------------------------------------------------------------------

describe("Process DO — mechanical", () => {
  it("projects proc.run signals into kernel process activity", async () => {
    const pid = "mech-kernel-process-activity";
    await registerInKernel(pid, ROOT_IDENTITY);
    const kernel = await getKernelPtr();

    const state = await runInDurableObject(kernel, async (instance: Kernel) => {
      const k = instance as any;
      await k.handleProcessSignal(pid, {
        type: "sig",
        signal: "proc.run.started",
        payload: {
          pid,
          runId: "run-activity",
          conversationId: "thread",
          queuedCount: 1,
          timestamp: 1000,
        },
      });
      const running = k.procs.get(pid);

      await k.handleProcessSignal(pid, {
        type: "sig",
        signal: "proc.run.retrying",
        payload: {
          pid,
          runId: "run-activity",
          conversationId: "thread",
          queuedCount: 1,
          timestamp: 1050,
        },
      });
      const retrying = k.procs.get(pid);

      await k.handleProcessSignal(pid, {
        type: "sig",
        signal: "proc.run.hil.requested",
        payload: {
          pid,
          runId: "run-activity",
          conversationId: "thread",
          queuedCount: 1,
          timestamp: 1100,
        },
      });
      const waiting = k.procs.get(pid);

      await k.handleProcessSignal(pid, {
        type: "sig",
        signal: "proc.run.finished",
        payload: {
          pid,
          runId: "run-activity",
          conversationId: "thread",
          queuedCount: 0,
          timestamp: 1200,
        },
      });
      const idle = k.procs.get(pid);

      return { running, retrying, waiting, idle };
    });

    expect(state.running).toMatchObject({
      state: "running",
      activeRunId: "run-activity",
      activeConversationId: "thread",
      queuedCount: 1,
      lastActiveAt: 1000,
    });
    expect(state.retrying).toMatchObject({
      state: "running",
      activeRunId: "run-activity",
      activeConversationId: "thread",
      queuedCount: 1,
      lastActiveAt: 1050,
    });
    expect(state.waiting).toMatchObject({
      state: "waiting_hil",
      activeRunId: "run-activity",
      activeConversationId: "thread",
      queuedCount: 1,
      lastActiveAt: 1100,
    });
    expect(state.idle).toMatchObject({
      state: "idle",
      activeRunId: null,
      activeConversationId: null,
      queuedCount: 0,
      lastActiveAt: 1200,
    });
  });

  describe("kernel process RPC exposure", () => {
    it("allows non-root processes to call internal ai.config", async () => {
      const pid = "mech-kernel-ai-config";
      const identity: ProcessIdentity = {
        uid: 1000,
        gid: 1000,
        gids: [1000, 100],
        username: "sam",
        home: "/home/sam",
        cwd: "/home/sam",
      };

      await registerInKernel(pid, identity);
      const kernel = await getKernelPtr();

      const response = await runInDurableObject(kernel, (instance: Kernel) =>
        instance.recvFrame(pid, makeReq("ai.config", {})),
      );

      expect(response).not.toBeNull();
      expect((response as ResponseFrame).ok).toBe(true);
    });

    it("includes CodeMode in ai.tools for default user capabilities", async () => {
      const pid = "mech-kernel-ai-tools-codemode";
      const identity: ProcessIdentity = {
        uid: 1000,
        gid: 1000,
        gids: [1000, 100],
        username: "sam",
        home: "/home/sam",
        cwd: "/home/sam",
      };

      await registerInKernel(pid, identity);
      const kernel = await getKernelPtr();

      const response = await runInDurableObject(kernel, (instance: Kernel) =>
        instance.recvFrame(pid, makeReq("ai.tools", {})),
      ) as ResponseOkFrame;

      expect(response.ok).toBe(true);
      const data = response.data as {
        tools: Array<{ name: string; inputSchema: { required?: string[] } }>;
      };
      const codeMode = data.tools.find((tool) => tool.name === "CodeMode");
      expect(codeMode).toBeDefined();
      expect(codeMode?.inputSchema.required).toEqual(["code"]);
      expect(data.tools.find((tool) => tool.name === "ProcessMessage")).toBeUndefined();
    });
  });

  describe("proc.setidentity", () => {
    it("stores pid and identity", async () => {
      const pid = "mech-setid-1";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      await runInDurableObject(stub, (instance: Process) => {
        expect(instance.pid).toBe(pid);
        expect(instance.identity.uid).toBe(0);
        expect(instance.identity.username).toBe("root");
        expect(instance.identity.home).toBe("/root");
        expect(instance.initialized).toBe(true);
      });
    });

    it("overwrites on re-call", async () => {
      const pid = "mech-setid-2";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      const newIdentity: ProcessIdentity = {
        uid: 1000,
        gid: 1000,
        gids: [1000, 100],
        username: "alice",
        home: "/home/alice",
        cwd: "/home/alice",
      };
      await stub.recvFrame(makeReq("proc.setidentity", { pid, identity: newIdentity, profile: "mcp" }));

      await runInDurableObject(stub, (instance: Process) => {
        expect(instance.identity.uid).toBe(1000);
        expect(instance.identity.username).toBe("alice");
      });
    });
  });

  describe("proc.ai.config", () => {
    it("stores snapshots, redacts reads by default, patches fields, and clears", async () => {
      const pid = "mech-ai-config";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      const setResponse = await stub.recvFrame(makeReq("proc.ai.config.set", {
        values: {
          "config/ai/provider": "openai",
          "config/ai/model": "gpt-4.1-mini",
          "config/ai/api_key": "sk-process",
          "config/ai/max_tokens": "",
          "config/ai/max_context_bytes": "   ",
        },
        profile: {
          id: "fast",
          name: "Fast",
        },
      })) as ResponseOkFrame;
      expect(setResponse.ok).toBe(true);
      expect((setResponse.data as any).config).toMatchObject({
        profile: { id: "fast", name: "Fast" },
        values: {
          "config/ai/provider": "openai",
          "config/ai/model": "gpt-4.1-mini",
          "config/ai/api_key": "redacted",
        },
      });

      const redactedGet = await stub.recvFrame(makeReq("proc.ai.config.get", {})) as ResponseOkFrame;
      expect((redactedGet.data as any).config.values["config/ai/api_key"]).toBe("redacted");

      const rawGet = await stub.recvFrame(makeReq("proc.ai.config.get", { redacted: false })) as ResponseOkFrame;
      expect((rawGet.data as any).config.values["config/ai/api_key"]).toBe("sk-process");
      expect((rawGet.data as any).config.values).not.toHaveProperty("config/ai/max_tokens");
      expect((rawGet.data as any).config.values).not.toHaveProperty("config/ai/max_context_bytes");

      const patchResponse = await stub.recvFrame(makeReq("proc.ai.config.set", {
        key: "config/ai/model",
        value: "gpt-4.2",
      })) as ResponseOkFrame;
      expect((patchResponse.data as any).config.profile).toBeUndefined();
      expect((patchResponse.data as any).config.values["config/ai/model"]).toBe("gpt-4.2");

      const clearResponse = await stub.recvFrame(makeReq("proc.ai.config.set", { clear: true })) as ResponseOkFrame;
      expect((clearResponse.data as any).config).toBeNull();
      const afterClear = await stub.recvFrame(makeReq("proc.ai.config.get", {})) as ResponseOkFrame;
      expect((afterClear.data as any).config).toBeNull();
    });

    it("keeps profile-only snapshots for server-side secret resolution", async () => {
      const pid = "mech-ai-config-profile-only";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      const setResponse = await stub.recvFrame(makeReq("proc.ai.config.set", {
        values: {},
        profile: {
          id: "fast",
          name: "Fast",
        },
      })) as ResponseOkFrame;

      expect((setResponse.data as any).config).toMatchObject({
        profile: { id: "fast", name: "Fast" },
        values: {},
      });

      const getResponse = await stub.recvFrame(makeReq("proc.ai.config.get", { redacted: false })) as ResponseOkFrame;
      expect((getResponse.data as any).config).toMatchObject({
        profile: { id: "fast", name: "Fast" },
        values: {},
      });
    });
  });

  describe("model context", () => {
    it("includes process system messages as model-visible events", async () => {
      const pid = "mech-system-context-1";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        process.store.appendMessage("system", "Delegated task finished with result GREEN.");
        process.store.appendMessage("user", "What was the result?");

        const messages = await process.buildContextMessages("default");
        expect(messages).toHaveLength(2);
        expect(messages[0]).toMatchObject({ role: "user" });
        expect((messages[0] as any).content).toContain("[Process Event]:");
        expect((messages[0] as any).content).toContain("Delegated task finished with result GREEN.");
        expect(messages[1]).toMatchObject({
          role: "user",
          content: "What was the result?",
        });
      });
    });

    it("keeps process events after matching tool results in provider context", async () => {
      const pid = "mech-system-context-tool-order";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        process.store.appendMessage("assistant", "Let me check that.", {
          toolCalls: JSON.stringify({
            toolCalls: [
              {
                type: "toolCall",
                id: "call_shell",
                name: "Shell",
                arguments: { input: "sleep 10 && date", target: "gsv" },
              },
            ],
          }),
        });
        process.store.appendMessage(
          "system",
          "Delegated task from process `worker` finished.",
        );
        process.store.appendToolResult(
          "call_shell",
          "shell.exec",
          JSON.stringify({ ok: true, stdout: "done" }),
          false,
        );

        const messages = await process.buildContextMessages("default");
        expect(messages.map((message: any) => message.role)).toEqual([
          "assistant",
          "toolResult",
          "user",
        ]);
        expect((messages[1] as any).toolCallId).toBe("call_shell");
        expect((messages[2] as any).content).toContain("[Process Event]:");
        expect((messages[2] as any).content).toContain("Delegated task from process `worker` finished");
      });
    });

    it("does not drop tool results after 200 stored messages", async () => {
      const pid = "mech-context-tool-result-after-200";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        for (let i = 1; i <= 199; i += 1) {
          process.store.appendMessage("user", `filler-${i}`);
        }
        process.store.appendMessage("assistant", "", {
          toolCalls: JSON.stringify({
            toolCalls: [
              {
                type: "toolCall",
                id: "call-boundary|fc_boundary",
                name: "Search",
                arguments: { query: "thinking-status" },
              },
            ],
          }),
        });
        process.store.appendToolResult(
          "call-boundary|fc_boundary",
          "fs.search",
          JSON.stringify({ ok: true, count: 0, matches: [] }),
          false,
        );

        const messages = await process.buildContextMessages("default");
        expect(messages).toHaveLength(201);
        expect(messages[199]).toMatchObject({
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-boundary|fc_boundary",
              name: "Search",
            },
          ],
        });
        expect(messages[200]).toMatchObject({
          role: "toolResult",
          toolCallId: "call-boundary|fc_boundary",
          toolName: "Search",
        });
      });
    });

    it("emits live proc.changed message signals for scheduled runtime events", async () => {
      const pid = "mech-schedule-live-message";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      const result = await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        const emitted: Array<{ signal: string; payload: unknown }> = [];
        process.sendSignal = async (signal: string, payload: unknown) => {
          emitted.push({ signal, payload });
        };

        await instance.recvFrame({
          type: "sig",
          signal: "schedule.event",
          payload: {
            scheduleId: "sched-1",
            scheduleName: "nightly",
            message: "run the nightly check",
            scheduledAtMs: 1_000,
            firedAtMs: 2_000,
          },
        } as any);

        const messages = process.store.getMessages();
        return { emitted, messages };
      });

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]).toMatchObject({
        role: "system",
      });
      expect(result.messages[0].content).toContain("Scheduled event `nightly` fired.");
      expect(result.emitted).toHaveLength(2);
      expect(result.emitted[0]).toMatchObject({
        signal: "proc.changed",
        payload: expect.objectContaining({
          pid,
          changes: ["messages"],
          conversationId: "default",
          messageId: result.messages[0].id,
          role: "system",
          content: result.messages[0].content,
          timestamp: result.messages[0].createdAt,
        }),
      });
      expect(result.emitted[1]).toMatchObject({
        signal: "proc.run.started",
        payload: expect.objectContaining({
          pid,
          conversationId: "default",
          reason: "schedule.event",
        }),
      });
    });

    it("emits and persists context pressure for a completed model turn", async () => {
      const pid = "mech-context-pressure";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      const emitted = await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        const emitted: Array<{ signal: string; payload: unknown }> = [];
        process.sendSignal = async (signal: string, payload: unknown) => {
          emitted.push({ signal, payload });
        };
        process.generation = {
          async generate() {
            return {
              role: "assistant",
              content: [{ type: "text", text: "done" }],
              api: "test",
              provider: "test",
              model: "test",
              usage: {
                input: 1234,
                output: 56,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 1290,
                cost: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  total: 0,
                },
              },
              stopReason: "stop",
              timestamp: Date.now(),
            };
          },
          async generateText() {
            return "done";
          },
        };

        process.store.appendMessage("user", "measure context");
        process.currentRun = {
          runId: "run-context-pressure",
          queued: false,
          conversationId: "default",
          config: {
            executor: { kind: "process", pid },
            profile: "task",
            provider: "workers-ai",
            model: "@cf/nvidia/nemotron-3-120b-a12b",
            apiKey: "",
            reasoning: "off",
            maxTokens: 8192,
            contextWindowTokens: 256000,
            contextWindowSource: "config",
            maxContextBytes: 32768,
          },
          tools: [],
          devices: [],
          systemPrompt: "Test system prompt.",
          approvalPolicy: { default: "auto", rules: [] },
        };
        await process.continueAgentLoop("run-context-pressure");
        return emitted;
      });

      const history = (await stub.recvFrame(makeReq("proc.history", {}))) as ResponseOkFrame;
      expect(history.ok).toBe(true);
      expect((history.data as any).context).toMatchObject({
        conversationId: "default",
        provider: "workers-ai",
        model: "@cf/nvidia/nemotron-3-120b-a12b",
        reasoning: "off",
        contextWindowTokens: 256000,
        inputTokens: 1290,
        outputTokens: 56,
        totalTokens: 1290,
        source: "provider",
      });

      const contextSignals = (emitted as Array<{ signal: string; payload: any }>)
        .filter((entry) => entry.signal === "proc.changed" && Array.isArray((entry.payload as { changes?: unknown[] }).changes) && ((entry.payload as { changes?: unknown[] }).changes ?? []).includes("context"));
      expect(contextSignals).toHaveLength(2);
      expect(contextSignals[0].payload.context.source).toBe("estimate");
      expect(contextSignals[1].payload.context).toMatchObject({
        inputTokens: 1290,
        source: "provider",
      });
    });

    it("includes interaction origin in model context without rewriting stored content", async () => {
      const pid = "mech-origin-context";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        process.sendSignal = async () => {};
        process.generation = {
          async generate(request: any) {
            const first = request.context.messages[0];
            const second = request.context.messages[1];
            const third = request.context.messages[2];
            expect(first.role).toBe("user");
            expect(first.content).toContain("[From: WhatsApp group GSV Dev from @sam]");
            expect(first.content).toContain("check this from the group");
            expect(second.role).toBe("user");
            expect(second.content).toBe("same source follow-up");
            expect(third.role).toBe("user");
            expect(third.content).toContain("[From: GSV Web Desktop]");
            expect(third.content).toContain("now from chat");
            return {
              role: "assistant",
              content: [{ type: "text", text: "noted" }],
              api: "test",
              provider: "test",
              model: "test",
              stopReason: "stop",
              timestamp: Date.now(),
            };
          },
          async generateText() {
            return "noted";
          },
        };

        process.store.appendMessage("user", "check this from the group", {
          origin: JSON.stringify({
            kind: "adapter",
            adapter: "whatsapp",
            accountId: "primary",
            surface: { kind: "group", id: "group-1", name: "GSV Dev" },
            actorId: "wa:+123",
            actorLabel: "@sam",
            messageId: "wa-msg-1",
          }),
        });
        process.store.appendMessage("user", "same source follow-up", {
          origin: JSON.stringify({
            kind: "adapter",
            adapter: "whatsapp",
            accountId: "primary",
            surface: { kind: "group", id: "group-1", name: "GSV Dev" },
            actorId: "wa:+123",
            actorLabel: "@sam",
            messageId: "wa-msg-2",
          }),
        });
        process.store.appendMessage("user", "now from chat", {
          origin: JSON.stringify({
            kind: "client",
            connectionId: "conn-1",
            clientId: "gsv-ui",
            platform: "browser",
          }),
        });
        process.currentRun = {
          runId: "run-origin-context",
          queued: false,
          conversationId: "default",
          config: {
            profile: "task",
            provider: "workers-ai",
            model: "@cf/nvidia/nemotron-3-120b-a12b",
            apiKey: "",
            reasoning: "off",
            maxTokens: 8192,
            contextWindowTokens: 256000,
            contextWindowSource: "config",
            maxContextBytes: 32768,
          },
          tools: [],
          devices: [],
          systemPrompt: "Test system prompt.",
          approvalPolicy: { default: "auto", rules: [] },
        };
        await process.continueAgentLoop("run-origin-context");

        const messages = process.store.getMessages();
        expect(messages.map((message: any) => message.content)).toEqual([
          "check this from the group",
          "same source follow-up",
          "now from chat",
          "noted",
        ]);
      });
    });

    it("includes assistant thinking blocks in live proc.run.output signals", async () => {
      const pid = "mech-chat-text-thinking";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      const emitted = await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        const emitted: Array<{ signal: string; payload: unknown }> = [];
        process.sendSignal = async (signal: string, payload: unknown) => {
          emitted.push({ signal, payload });
        };
        process.generation = {
          async generate() {
            return {
              role: "assistant",
              content: [
                { type: "thinking", thinking: "Need to preserve this reasoning." },
                { type: "text", text: "done" },
              ],
              api: "test",
              provider: "test",
              model: "test",
              stopReason: "stop",
              timestamp: Date.now(),
            };
          },
          async generateText() {
            return "done";
          },
        };

        process.store.openConversation({ conversationId: "side", title: "Side" });
        process.store.appendMessage("user", "include reasoning", { conversationId: "side" });
        process.currentRun = {
          runId: "run-chat-text-thinking",
          queued: false,
          conversationId: "side",
          config: {
            profile: "task",
            provider: "workers-ai",
            model: "@cf/nvidia/nemotron-3-120b-a12b",
            apiKey: "",
            reasoning: "high",
            maxTokens: 8192,
            contextWindowTokens: 256000,
            contextWindowSource: "config",
            maxContextBytes: 32768,
          },
          tools: [],
          devices: [],
          systemPrompt: "Test system prompt.",
          approvalPolicy: { default: "auto", rules: [] },
        };
        await process.continueAgentLoop("run-chat-text-thinking");
        return emitted;
      });

      const textSignal = (emitted as Array<{ signal: string; payload: any }>)
        .find((entry) => entry.signal === "proc.run.output");
      expect(textSignal?.payload).toMatchObject({
        text: "done",
        pid,
        runId: "run-chat-text-thinking",
        conversationId: "side",
        thinking: [
          { type: "thinking", thinking: "Need to preserve this reasoning." },
        ],
      });
    });

    it("retries reasoning-only model turns", async () => {
      const pid = "mech-chat-thinking-only";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      const result = await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        const emitted: Array<{ signal: string; payload: unknown }> = [];
        let calls = 0;
        process.sendSignal = async (signal: string, payload: unknown) => {
          emitted.push({ signal, payload });
        };
        process.generation = {
          async generate() {
            calls += 1;
            if (calls === 1) {
              return {
                role: "assistant",
                content: [
                  { type: "thinking", thinking: "I found the answer but never emitted it." },
                ],
                api: "test",
                provider: "test",
                model: "test",
                usage: {
                  ...testUsage(100, 0),
                  cost: {
                    input: 0.00005,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    total: 0.00005,
                  },
                },
                stopReason: "stop",
                timestamp: Date.now(),
              };
            }
            return {
              role: "assistant",
              content: [
                { type: "text", text: "visible answer" },
              ],
              api: "test",
              provider: "test",
              model: "test",
              usage: {
                ...testUsage(50, 10),
                cost: {
                  input: 0.000025,
                  output: 0.000015,
                  cacheRead: 0,
                  cacheWrite: 0,
                  total: 0.00004,
                },
              },
              stopReason: "stop",
              timestamp: Date.now(),
            };
          },
          async generateText() {
            return "unused";
          },
        };

        process.store.appendMessage("user", "answer visibly");
        process.currentRun = {
          runId: "run-chat-thinking-only",
          queued: false,
          conversationId: "default",
          config: {
            profile: "task",
            provider: "workers-ai",
            model: "@cf/nvidia/nemotron-3-120b-a12b",
            apiKey: "",
            reasoning: "high",
            maxTokens: 8192,
            contextWindowTokens: 256000,
            contextWindowSource: "config",
            maxContextBytes: 32768,
          },
          tools: [],
          devices: [],
          systemPrompt: "Test system prompt.",
          approvalPolicy: { default: "auto", rules: [] },
        };
        await process.continueAgentLoop("run-chat-thinking-only");
        return {
          calls,
          emitted,
          contextState: process.store.getContextState("default"),
          conversationUsage: process.store.getConversationUsage("default"),
          messages: process.store.getMessages(),
        };
      });

      expect(result.calls).toBe(2);
      expect(result.messages.map((message: any) => [message.role, message.content])).toEqual([
        ["user", "answer visibly"],
        ["assistant", "visible answer"],
      ]);
      expect(result.conversationUsage).toMatchObject({
        inputTokens: 150,
        outputTokens: 10,
        totalTokens: 160,
        cost: { total: 0.00009, source: "model-pricing" },
        generations: 2,
      });
      expect(result.contextState?.conversationUsage).toMatchObject({
        inputTokens: 150,
        outputTokens: 10,
        cost: { total: 0.00009, source: "model-pricing" },
      });
      const output = result.emitted.find((entry) => entry.signal === "proc.run.output")?.payload as any;
      expect(output?.text).toBe("visible answer");
      const finished = result.emitted.find((entry) => entry.signal === "proc.run.finished")?.payload as any;
      expect(finished).toMatchObject({
        status: "ok",
        reason: "turn.complete",
        text: "visible answer",
      });
    });

    it("fails reasoning-only model turns after retry attempts are exhausted", async () => {
      const pid = "mech-chat-thinking-only-exhausted";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      const result = await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        const emitted: Array<{ signal: string; payload: unknown }> = [];
        let calls = 0;
        process.sendSignal = async (signal: string, payload: unknown) => {
          emitted.push({ signal, payload });
        };
        process.generation = {
          async generate() {
            calls += 1;
            return {
              role: "assistant",
              content: [
                { type: "thinking", thinking: "I found the answer but never emitted it." },
              ],
              api: "test",
              provider: "test",
              model: "test",
              stopReason: "stop",
              timestamp: Date.now(),
            };
          },
          async generateText() {
            return "unused";
          },
        };

        process.store.appendMessage("user", "answer visibly");
        process.currentRun = {
          runId: "run-chat-thinking-only-exhausted",
          queued: false,
          conversationId: "default",
          config: {
            profile: "task",
            provider: "workers-ai",
            model: "@cf/nvidia/nemotron-3-120b-a12b",
            apiKey: "",
            reasoning: "high",
            maxTokens: 8192,
            contextWindowTokens: 256000,
            contextWindowSource: "config",
            maxContextBytes: 32768,
          },
          tools: [],
          devices: [],
          systemPrompt: "Test system prompt.",
          approvalPolicy: { default: "auto", rules: [] },
        };
        await process.continueAgentLoop("run-chat-thinking-only-exhausted");
        return {
          calls,
          emitted,
          messages: process.store.getMessages(),
        };
      });

      expect(result.calls).toBe(3);
      expect(result.messages.map((message: any) => [message.role, message.content])).toEqual([
        ["user", "answer visibly"],
        ["system", "Generation failed: LLM returned reasoning but no final response"],
      ]);
      const finished = result.emitted.find((entry) => entry.signal === "proc.run.finished")?.payload as any;
      expect(finished).toMatchObject({
        status: "error",
        reason: "generation.empty",
        error: "Generation failed: LLM returned reasoning but no final response",
      });
    });

    it("retries thrown empty-final provider errors", async () => {
      const pid = "mech-chat-empty-final-throw";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      const result = await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        const emitted: Array<{ signal: string; payload: unknown }> = [];
        let calls = 0;
        process.sendSignal = async (signal: string, payload: unknown) => {
          emitted.push({ signal, payload });
        };
        process.generation = {
          async generate() {
            calls += 1;
            if (calls === 1) {
              throw new Error("LLM returned reasoning but no final response");
            }
            return {
              role: "assistant",
              content: [{ type: "text", text: "recovered" }],
              api: "test",
              provider: "test",
              model: "test",
              stopReason: "stop",
              timestamp: Date.now(),
            };
          },
          async generateText() {
            return "unused";
          },
        };

        process.store.appendMessage("user", "recover please");
        process.currentRun = {
          runId: "run-chat-empty-final-throw",
          queued: false,
          conversationId: "default",
          config: {
            profile: "task",
            provider: "openai",
            model: "gpt-test",
            apiKey: "test-key",
            reasoning: "high",
            maxTokens: 8192,
            contextWindowTokens: 128000,
            contextWindowSource: "config",
            maxContextBytes: 32768,
          },
          tools: [],
          devices: [],
          systemPrompt: "Test system prompt.",
          approvalPolicy: { default: "auto", rules: [] },
        };
        await process.continueAgentLoop("run-chat-empty-final-throw");
        return {
          calls,
          emitted,
          messages: process.store.getMessages(),
        };
      });

      expect(result.calls).toBe(2);
      expect(result.messages.map((message: any) => [message.role, message.content])).toEqual([
        ["user", "recover please"],
        ["assistant", "recovered"],
      ]);
      const finished = result.emitted.find((entry) => entry.signal === "proc.run.finished")?.payload as any;
      expect(finished).toMatchObject({
        status: "ok",
        reason: "turn.complete",
        text: "recovered",
      });
    });

    it("retries raw tool-call markup returned as final text", async () => {
      const pid = "mech-chat-tool-markup-text";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      const result = await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        const emitted: Array<{ signal: string; payload: unknown }> = [];
        let calls = 0;
        process.sendSignal = async (signal: string, payload: unknown) => {
          emitted.push({ signal, payload });
        };
        process.generation = {
          async generate() {
            calls += 1;
            if (calls === 1) {
              return {
                role: "assistant",
                content: [{
                  type: "text",
                  text: "<tool_call>Shell<arg_key>input</arg_key><arg_value>pwd</arg_value><arg_key>target</arg_key><arg_value>gsv</arg_value></tool_call>",
                }],
                api: "test",
                provider: "test",
                model: "test",
                stopReason: "stop",
                timestamp: Date.now(),
              };
            }
            return {
              role: "assistant",
              content: [{
                type: "toolCall",
                id: "call-retry-shell",
                name: "Shell",
                arguments: { input: "pwd", target: "gsv" },
              }],
              api: "test",
              provider: "test",
              model: "test",
              stopReason: "toolUse",
              timestamp: Date.now(),
            };
          },
          async generateText() {
            return "unused";
          },
        };

        process.store.appendMessage("user", "run pwd");
        process.currentRun = {
          runId: "run-chat-tool-markup-text",
          queued: false,
          conversationId: "default",
          config: {
            profile: "task",
            provider: "openai",
            model: "gpt-test",
            apiKey: "test-key",
            reasoning: "high",
            maxTokens: 8192,
            contextWindowTokens: 128000,
            contextWindowSource: "config",
            maxContextBytes: 32768,
          },
          tools: [],
          devices: [],
          systemPrompt: "Test system prompt.",
          approvalPolicy: {
            default: "auto",
            rules: [{ match: "shell.exec", action: "ask" }],
          },
        };
        await process.continueAgentLoop("run-chat-tool-markup-text");
        return {
          calls,
          emitted,
          messages: process.store.getMessages(),
          pendingHil: process.store.getPendingHilForRun("run-chat-tool-markup-text"),
        };
      });

      expect(result.calls).toBe(2);
      expect(result.messages.map((message: any) => [message.role, message.content])).toEqual([
        ["user", "run pwd"],
        ["assistant", ""],
      ]);
      const retry = result.emitted.find((entry) => entry.signal === "proc.run.retrying")?.payload as any;
      expect(retry).toMatchObject({
        pid,
        runId: "run-chat-tool-markup-text",
        conversationId: "default",
        attempt: 1,
        nextAttempt: 2,
        maxAttempts: 3,
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

      const result = await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        const emitted: Array<{ signal: string; payload: unknown }> = [];
        let calls = 0;
        process.sendSignal = async (signal: string, payload: unknown) => {
          emitted.push({ signal, payload });
        };
        process.generation = {
          async generate() {
            calls += 1;
            return {
              role: "assistant",
              content: [],
              api: "test",
              provider: "workers-ai",
              model: "test",
              stopReason: "error",
              errorMessage: "Workers AI binding is not configured for this worker",
              timestamp: Date.now(),
            };
          },
          async generateText() {
            return "unused";
          },
        };

        process.store.appendMessage("user", "fail once please");
        process.currentRun = {
          runId: "run-chat-provider-error-response",
          queued: false,
          conversationId: "default",
          config: {
            profile: "task",
            provider: "workers-ai",
            model: "@cf/nvidia/nemotron-3-120b-a12b",
            apiKey: "",
            reasoning: "high",
            maxTokens: 8192,
            contextWindowTokens: 256000,
            contextWindowSource: "config",
            maxContextBytes: 32768,
          },
          tools: [],
          devices: [],
          systemPrompt: "Test system prompt.",
          approvalPolicy: { default: "auto", rules: [] },
        };
        await process.continueAgentLoop("run-chat-provider-error-response");
        return {
          calls,
          emitted,
          messages: process.store.getMessages(),
        };
      });

      expect(result.calls).toBe(1);
      expect(result.emitted.some((entry) => entry.signal === "proc.run.retrying")).toBe(false);
      expect(result.messages.map((message: any) => [message.role, message.content])).toEqual([
        ["user", "fail once please"],
        ["system", "Generation failed: Workers AI binding is not configured for this worker"],
      ]);
      const finished = result.emitted.find((entry) => entry.signal === "proc.run.finished")?.payload as any;
      expect(finished).toMatchObject({
        status: "error",
        reason: "generation.empty",
        error: "Generation failed: Workers AI binding is not configured for this worker",
      });
    });

    it("surfaces thrown provider context overflow separately from generation errors", async () => {
      const pid = "mech-chat-provider-context-overflow-throw";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      const result = await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        const emitted: Array<{ signal: string; payload: unknown }> = [];
        process.sendSignal = async (signal: string, payload: unknown) => {
          emitted.push({ signal, payload });
        };
        process.generation = {
          async generate() {
            throw new Error("Your input exceeds the context window of this model");
          },
          async generateText() {
            return "";
          },
        };

        process.store.appendMessage("user", "overflow please");
        process.currentRun = {
          runId: "run-chat-provider-context-overflow-throw",
          queued: false,
          conversationId: "default",
          config: {
            profile: "task",
            provider: "openai",
            model: "gpt-test",
            apiKey: "test-key",
            reasoning: "off",
            maxTokens: 8192,
            contextWindowTokens: 128000,
            contextWindowSource: "config",
            maxContextBytes: 32768,
          },
          tools: [],
          devices: [],
          systemPrompt: "Test system prompt.",
          approvalPolicy: { default: "auto", rules: [] },
        };
        await process.continueAgentLoop("run-chat-provider-context-overflow-throw");
        return {
          emitted,
          currentRun: process.currentRun,
          messages: process.store.getMessages(),
        };
      });

      expect(result.currentRun).toBeNull();
      const systemMessage = result.messages.find((message: any) => message.role === "system");
      expect(systemMessage?.content).toContain("Context limit reached for openai/gpt-test.");
      expect(systemMessage?.content).toContain("Provider message: Your input exceeds the context window of this model");
      expect(systemMessage?.content).not.toContain("Generation failed:");
      expect(result.emitted).toEqual(expect.arrayContaining([
        {
          signal: "proc.run.finished",
          payload: expect.objectContaining({
            status: "error",
            reason: "context.provider_overflow",
            runId: "run-chat-provider-context-overflow-throw",
          }),
        },
      ]));
    });

    it("surfaces nested thrown provider context overflow separately from generation errors", async () => {
      const pid = "mech-chat-provider-context-overflow-nested";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      const result = await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        process.sendSignal = async () => {};
        process.generation = {
          async generate() {
            throw new Error("request failed", {
              cause: {
                error: {
                  message: "Your input exceeds the context window of this model",
                },
              },
            });
          },
          async generateText() {
            return "";
          },
        };

        process.store.appendMessage("user", "overflow please");
        process.currentRun = {
          runId: "run-chat-provider-context-overflow-nested",
          queued: false,
          conversationId: "default",
          config: {
            profile: "task",
            provider: "openai",
            model: "gpt-test",
            apiKey: "test-key",
            reasoning: "off",
            maxTokens: 8192,
            contextWindowTokens: 128000,
            contextWindowSource: "config",
            maxContextBytes: 32768,
          },
          tools: [],
          devices: [],
          systemPrompt: "Test system prompt.",
          approvalPolicy: { default: "auto", rules: [] },
        };
        await process.continueAgentLoop("run-chat-provider-context-overflow-nested");
        return {
          currentRun: process.currentRun,
          messages: process.store.getMessages(),
        };
      });

      expect(result.currentRun).toBeNull();
      const systemMessage = result.messages.find((message: any) => message.role === "system");
      expect(systemMessage?.content).toContain("Context limit reached for openai/gpt-test.");
      expect(systemMessage?.content).toContain("Provider message: Your input exceeds the context window of this model");
      expect(systemMessage?.content).not.toContain("Generation failed:");
    });

    it("surfaces returned provider context overflow and records provider usage", async () => {
      const pid = "mech-chat-provider-context-overflow-response";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      const result = await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        const emitted: Array<{ signal: string; payload: unknown }> = [];
        process.sendSignal = async (signal: string, payload: unknown) => {
          emitted.push({ signal, payload });
        };
        process.generation = {
          async generate() {
            return {
              role: "assistant",
              content: [],
              api: "test",
              provider: "google",
              model: "gemini-test",
              usage: {
                ...testUsage(1_196_265, 0),
                cost: {
                  input: 0.12,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  total: 0.12,
                },
              },
              stopReason: "error",
              errorMessage: "The input token count (1196265) exceeds the maximum number of tokens allowed (1048575)",
              timestamp: Date.now(),
            };
          },
          async generateText() {
            return "";
          },
        };

        process.store.appendMessage("user", "overflow please");
        process.currentRun = {
          runId: "run-chat-provider-context-overflow-response",
          queued: false,
          conversationId: "default",
          config: {
            profile: "task",
            provider: "google",
            model: "gemini-test",
            apiKey: "test-key",
            reasoning: "off",
            maxTokens: 8192,
            contextWindowTokens: 1_048_575,
            contextWindowSource: "config",
            maxContextBytes: 32768,
          },
          tools: [],
          devices: [],
          systemPrompt: "Test system prompt.",
          approvalPolicy: { default: "auto", rules: [] },
        };
        await process.continueAgentLoop("run-chat-provider-context-overflow-response");
        return {
          emitted,
          contextState: process.store.getContextState("default"),
          conversationUsage: process.store.getConversationUsage("default"),
          messages: process.store.getMessages(),
        };
      });

      const systemMessage = result.messages.find((message: any) => message.role === "system");
      expect(systemMessage?.content).toContain("Context limit reached for google/gemini-test.");
      expect(systemMessage?.content).toContain("Provider message: The input token count");
      expect(systemMessage?.content).not.toContain("Generation failed:");
      expect(result.contextState).toMatchObject({
        inputTokens: 1196265,
        source: "provider",
        level: "full",
      });
      expect(result.conversationUsage).toMatchObject({
        inputTokens: 1196265,
        totalTokens: 1196265,
        cost: { total: 0.12, source: "provider" },
        generations: 1,
      });
      expect(result.contextState?.conversationUsage).toMatchObject({
        inputTokens: 1196265,
        cost: { total: 0.12, source: "provider" },
      });
      expect(result.emitted).toEqual(expect.arrayContaining([
        {
          signal: "proc.run.finished",
          payload: expect.objectContaining({
            status: "error",
            reason: "context.provider_overflow",
            runId: "run-chat-provider-context-overflow-response",
          }),
        },
      ]));
    });

    it("mirrors provider stream events as proc.run.stream signals", async () => {
      const pid = "mech-chat-stream";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      const emitted = await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        const emitted: Array<{ signal: string; payload: unknown }> = [];
        process.sendSignal = async (signal: string, payload: unknown) => {
          emitted.push({ signal, payload });
        };
        process.generation = {
          stream() {
            const stream = createAssistantMessageEventStream();
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
            } as any;
            stream.push({ type: "start", partial: { ...partial, content: [] } });
            stream.push({ type: "text_start", contentIndex: 0, partial });
            partial.content[0].text = "he";
            stream.push({ type: "text_delta", contentIndex: 0, delta: "he", partial });
            partial.content[0].text = "hello";
            stream.push({ type: "text_delta", contentIndex: 0, delta: "llo", partial });
            stream.push({ type: "text_end", contentIndex: 0, content: "hello", partial });
            stream.push({ type: "done", reason: "stop", message: { ...partial, content: [{ type: "text", text: "hello" }] } });
            return stream;
          },
          async generate() {
            throw new Error("non-stream generation should not be used");
          },
          async generateText() {
            return "hello";
          },
        };

        process.store.appendMessage("user", "stream please");
        process.currentRun = {
          runId: "run-chat-stream",
          queued: false,
          conversationId: "default",
          config: {
            profile: "task",
            provider: "workers-ai",
            model: "@cf/nvidia/nemotron-3-120b-a12b",
            apiKey: "",
            reasoning: "off",
            maxTokens: 8192,
            contextWindowTokens: 256000,
            contextWindowSource: "config",
            maxContextBytes: 32768,
          },
          tools: [],
          devices: [],
          systemPrompt: "Test system prompt.",
          approvalPolicy: { default: "auto", rules: [] },
        };
        await process.continueAgentLoop("run-chat-stream");
        return emitted;
      });

      const streamSignals = (emitted as Array<{ signal: string; payload: any }>)
        .filter((entry) => entry.signal === "proc.run.stream");
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
        conversationId: "default",
        seq: 3,
        event: {
          type: "text_delta",
          delta: "he",
        },
      });
      const outputSignal = (emitted as Array<{ signal: string; payload: any }>)
        .find((entry) => entry.signal === "proc.run.output");
      expect(outputSignal?.payload.text).toBe("hello");
    });

    it("retries streamed reasoning-only model turns with monotonic stream sequence numbers", async () => {
      const pid = "mech-chat-stream-retry";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      const result = await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        const emitted: Array<{ signal: string; payload: unknown }> = [];
        let calls = 0;
        process.sendSignal = async (signal: string, payload: unknown) => {
          emitted.push({ signal, payload });
        };
        process.generation = {
          stream() {
            calls += 1;
            const stream = createAssistantMessageEventStream();
            const base = {
              role: "assistant",
              content: [],
              api: "test",
              provider: "test",
              model: "test",
              usage: testUsage(),
              stopReason: "stop",
              timestamp: Date.now(),
            } as any;
            stream.push({ type: "start", partial: base });

            if (calls === 1) {
              const partial = { ...base, content: [{ type: "thinking", thinking: "" }] };
              stream.push({ type: "thinking_start", contentIndex: 0, partial });
              partial.content[0].thinking = "thinking only";
              stream.push({ type: "thinking_delta", contentIndex: 0, delta: "thinking only", partial });
              stream.push({ type: "thinking_end", contentIndex: 0, content: "thinking only", partial });
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
            stream.push({
              type: "done",
              reason: "stop",
              message: { ...partial, content: [{ type: "text", text: "visible retry" }] },
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

        process.store.appendMessage("user", "stream retry please");
        process.currentRun = {
          runId: "run-chat-stream-retry",
          queued: false,
          conversationId: "default",
          config: {
            profile: "task",
            provider: "workers-ai",
            model: "@cf/nvidia/nemotron-3-120b-a12b",
            apiKey: "",
            reasoning: "high",
            maxTokens: 8192,
            contextWindowTokens: 256000,
            contextWindowSource: "config",
            maxContextBytes: 32768,
          },
          tools: [],
          devices: [],
          systemPrompt: "Test system prompt.",
          approvalPolicy: { default: "auto", rules: [] },
        };
        await process.continueAgentLoop("run-chat-stream-retry");
        return {
          calls,
          emitted,
          messages: process.store.getMessages(),
        };
      });

      expect(result.calls).toBe(2);
      expect(result.messages.map((message: any) => [message.role, message.content])).toEqual([
        ["user", "stream retry please"],
        ["assistant", "visible retry"],
      ]);
      const streamSignals = result.emitted
        .filter((entry) => entry.signal === "proc.run.stream")
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
        "done",
      ]);
      expect(streamSignals.map((payload) => payload.seq)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
      ]);
      const outputSignal = result.emitted.find((entry) => entry.signal === "proc.run.output")?.payload as any;
      expect(outputSignal?.text).toBe("visible retry");
    });

    it("emits a retrying signal before a streamed retry succeeds with only tool calls", async () => {
      const pid = "mech-chat-stream-retry-tool-only";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      const result = await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        const emitted: Array<{ signal: string; payload: unknown }> = [];
        let calls = 0;
        process.sendSignal = async (signal: string, payload: unknown) => {
          emitted.push({ signal, payload });
        };
        process.generation = {
          stream() {
            calls += 1;
            const stream = createAssistantMessageEventStream();
            const base = {
              role: "assistant",
              content: [],
              api: "test",
              provider: "test",
              model: "test",
              usage: testUsage(),
              stopReason: "stop",
              timestamp: Date.now(),
            } as any;
            stream.push({ type: "start", partial: base });

            if (calls === 1) {
              const partial = { ...base, content: [{ type: "thinking", thinking: "" }] };
              stream.push({ type: "thinking_start", contentIndex: 0, partial });
              partial.content[0].thinking = "abandoned reasoning";
              stream.push({ type: "thinking_delta", contentIndex: 0, delta: "abandoned reasoning", partial });
              stream.push({ type: "thinking_end", contentIndex: 0, content: "abandoned reasoning", partial });
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
              delta: "{\"path\":\"/root/retry.txt\"}",
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

        process.store.appendMessage("user", "stream retry to tool please");
        process.currentRun = {
          runId: "run-chat-stream-retry-tool-only",
          queued: false,
          conversationId: "default",
          config: {
            profile: "task",
            provider: "workers-ai",
            model: "@cf/nvidia/nemotron-3-120b-a12b",
            apiKey: "",
            reasoning: "high",
            maxTokens: 8192,
            contextWindowTokens: 256000,
            contextWindowSource: "config",
            maxContextBytes: 32768,
          },
          tools: [],
          devices: [],
          systemPrompt: "Test system prompt.",
          approvalPolicy: {
            default: "auto",
            rules: [{ match: "fs.read", action: "ask" }],
          },
        };
        await process.continueAgentLoop("run-chat-stream-retry-tool-only");
        return {
          calls,
          emitted,
          messages: process.store.getMessages(),
          pendingHil: process.store.getPendingHilForRun("run-chat-stream-retry-tool-only"),
        };
      });

      expect(result.calls).toBe(2);
      expect(result.messages.map((message: any) => [message.role, message.content])).toEqual([
        ["user", "stream retry to tool please"],
        ["assistant", ""],
      ]);
      const retrySignalIndex = result.emitted.findIndex((entry) => entry.signal === "proc.run.retrying");
      const firstErrorIndex = result.emitted.findIndex((entry) =>
        entry.signal === "proc.run.stream" && (entry.payload as any).event.type === "error"
      );
      const secondStartIndex = result.emitted.findIndex((entry, index) =>
        index > retrySignalIndex &&
        entry.signal === "proc.run.stream" &&
        (entry.payload as any).event.type === "start"
      );
      expect(firstErrorIndex).toBeGreaterThanOrEqual(0);
      expect(retrySignalIndex).toBeGreaterThan(firstErrorIndex);
      expect(secondStartIndex).toBeGreaterThan(retrySignalIndex);
      expect(result.emitted[retrySignalIndex]?.payload).toMatchObject({
        pid,
        runId: "run-chat-stream-retry-tool-only",
        conversationId: "default",
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

      const emitted = await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        const emitted: Array<{ signal: string; payload: unknown }> = [];
        process.sendSignal = async (signal: string, payload: unknown) => {
          emitted.push({ signal, payload });
        };
        process.generation = {
          [GENERATION_SERVICE_MARKER]: true,
          stream() {
            throw new Error("stream generation should not be used");
          },
          async generate() {
            return {
              role: "assistant",
              content: [{ type: "text", text: "hello" }],
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
            };
          },
          async generateText() {
            return "hello";
          },
        };

        process.store.appendMessage("user", "do not stream");
        process.currentRun = {
          runId: "run-chat-stream-off",
          queued: false,
          conversationId: "default",
          config: {
            profile: "task",
            provider: "workers-ai",
            model: "@cf/nvidia/nemotron-3-120b-a12b",
            apiKey: "",
            reasoning: "off",
            maxTokens: 8192,
            contextWindowTokens: 256000,
            contextWindowSource: "config",
            maxContextBytes: 32768,
            generationStreaming: "off",
          },
          tools: [],
          devices: [],
          systemPrompt: "Test system prompt.",
          approvalPolicy: { default: "auto", rules: [] },
        };
        await process.continueAgentLoop("run-chat-stream-off");
        return emitted;
      });

      expect((emitted as Array<{ signal: string }>).some((entry) => entry.signal === "proc.run.stream")).toBe(false);
      const outputSignal = (emitted as Array<{ signal: string; payload: any }>)
        .find((entry) => entry.signal === "proc.run.output");
      expect(outputSignal?.payload.text).toBe("hello");
    });

    it("routes kernel text executors through ai.text.generate", async () => {
      const pid = "mech-chat-kernel-executor";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      const result = await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        const kernelCalls: Array<{ call: string; args: any }> = [];
        process.sendSignal = async () => {};
        process.kernelRpc = async (call: string, args: any) => {
          kernelCalls.push({ call, args });
          if (call !== "ai.text.generate") {
            throw new Error(`unexpected kernel syscall: ${call}`);
          }
          return {
            message: {
              role: "assistant",
              content: [{ type: "text", text: "kernel hello" }],
              api: "test",
              provider: "anthropic",
              model: "claude-process",
              usage: {
                input: 4,
                output: 2,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 6,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              stopReason: "stop",
              timestamp: Date.now(),
            },
            provider: "anthropic",
            model: "claude-process",
            text: "kernel hello",
          };
        };
        process.generation = {
          [GENERATION_SERVICE_MARKER]: true,
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

        process.store.setAiConfigSnapshot({
          version: 1,
          values: {
            "config/ai/provider": "anthropic",
            "config/ai/model": "claude-process",
          },
          profile: {
            id: "fast-stack",
            name: "Fast Stack",
            appliedAt: 1,
          },
          updatedAt: 1,
        });
        process.store.appendMessage("user", "use kernel");
        process.currentRun = {
          runId: "run-chat-kernel-executor",
          queued: false,
          conversationId: "default",
          config: {
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
          },
          tools: [{
            name: "Read",
            description: "Read a file",
            inputSchema: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
            },
          }],
          devices: [],
          systemPrompt: "Test system prompt.",
          approvalPolicy: { default: "auto", rules: [] },
        };
        await process.continueAgentLoop("run-chat-kernel-executor");
        return {
          kernelCalls,
          messages: process.store.getMessages(),
        };
      });

      expect(result.kernelCalls).toHaveLength(1);
      expect(result.kernelCalls[0]).toMatchObject({
        call: "ai.text.generate",
        args: {
          systemPrompt: "Test system prompt.",
          messages: [{
            role: "user",
            content: "use kernel",
          }],
          tools: [{
            name: "Read",
          }],
          config: {
            processOverrides: {
              "config/ai/provider": "anthropic",
              "config/ai/model": "claude-process",
            },
            processProfile: {
              id: "fast-stack",
              name: "Fast Stack",
              appliedAt: 1,
            },
          },
        },
      });
      expect(result.messages[result.messages.length - 1]).toMatchObject({
        role: "assistant",
        content: "kernel hello",
      });
    });
  });

  describe("proc.send", () => {
    it("appends user message, starts run, loop completes", async () => {
      const pid = "mech-send-1";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      const res = (await stub.recvFrame(
        makeReq("proc.send", { message: "Hello agent" }),
      )) as ResponseOkFrame;

      expect(res.ok).toBe(true);
      const data = res.data as { ok: true; status: string; runId: string };
      expect(data.status).toBe("started");
      expect(data.runId).toBeTruthy();
      expect(data).not.toHaveProperty("queued");

      // Fire the alarm and wait for the agent loop to complete.
      // The test worker has no AI binding configured, so the LLM call
      // errors out gracefully, but the full lifecycle (tick →
      // continueAgentLoop → finishRun) should still run.
      await runDurableObjectAlarm(stub);
      await waitForRunComplete(stub);

      await runInDurableObject(stub, (instance: Process) => {
        const store = (instance as any).store;
        expect(store.messageCount()).toBe(2);
        expect(store.getMessages()[0].role).toBe("user");
        expect(store.getMessages()[0].content).toBe("Hello agent");
        expect(store.getMessages()[1].role).toBe("system");
        expect(store.getMessages()[1].content).toContain("Generation failed:");
        expect(store.getValue("currentRun")).toBeNull();
      });
    });

    it("queues message, finishRun dequeues and processes it", async () => {
      const pid = "mech-send-queued";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      // Start first run
      const res1 = (await stub.recvFrame(
        makeReq("proc.send", { message: "First message" }),
      )) as ResponseOkFrame;
      expect(res1.ok).toBe(true);

      // Send second message while run is active — should be queued
      const res2 = (await stub.recvFrame(
        makeReq("proc.send", { message: "Second message" }),
      )) as ResponseOkFrame;
      expect((res2.data as any).queued).toBe(true);

      // Fire alarm for run 1 — fails (no AI binding in tests), finishRun dequeues
      // "Second message" and starts run 2
      await runDurableObjectAlarm(stub);
      await waitForRunComplete(stub);

      // Fire alarm for run 2 — fails again, finishRun finds empty queue, done
      await runDurableObjectAlarm(stub);
      await waitForRunComplete(stub);

      await runInDurableObject(stub, (instance: Process) => {
        const store = (instance as any).store;
        const msgs = store.getMessages();
        const userMsgs = msgs.filter((m: any) => m.role === "user");
        expect(userMsgs).toHaveLength(2);
        expect(userMsgs[0].content).toBe("First message");
        expect(userMsgs[1].content).toBe("Second message");
        expect(store.queueSize()).toBe(0);
        expect(store.getValue("currentRun")).toBeNull();
      });
    });

    it("stores process-scoped media, reads it back, and hydrates image context blocks", async () => {
      const pid = "mech-send-media";
      const stub = await initProcess(pid, ROOT_IDENTITY);
      let mediaKey = "";

      const res = (await stub.recvFrame(
        makeReq("proc.send", {
          message: "Describe this image.",
          media: [
            {
              type: "image",
              mimeType: "image/png",
              data: "AQID",
              filename: "proof.png",
            },
          ],
        }),
      )) as ResponseOkFrame;

      expect(res.ok).toBe(true);

      await runInDurableObject(stub, async (instance: Process) => {
        const store = (instance as any).store;
        const record = store.getMessages()[0];
        expect(record.role).toBe("user");
        expect(record.media).toBeTruthy();

        const media = JSON.parse(record.media!);
        expect(media).toHaveLength(1);
        expect(media[0].key).toContain(`/0/${pid}/`);
        mediaKey = media[0].key;

        const stored = await env.STORAGE.get(media[0].key);
        expect(stored).not.toBeNull();

        const messages = await (instance as any).buildContextMessages();
        const user = messages[0] as any;
        expect(Array.isArray(user.content)).toBe(true);
        expect(user.content[0]).toEqual({ type: "text", text: "Describe this image." });
        expect(user.content[1].type).toBe("image");
        expect(user.content[1].mimeType).toBe("image/png");
        expect(user.content[1].data).toBe("AQID");
      });

      const read = (await stub.recvFrame(
        makeReq("proc.media.read", { key: mediaKey, mimeType: "image/png" }),
      )) as ResponseOkFrame;
      expect(read.ok).toBe(true);
      expect(read.data).toMatchObject({
        ok: true,
        key: mediaKey,
        mimeType: "image/png",
        dataUrl: "data:image/png;base64,AQID",
      });
    });
  });

  describe("proc.ipc.*", () => {
    it("delivers same-owner process messages through the kernel", async () => {
      const sourcePid = "mech-ipc-source";
      const targetPid = "mech-ipc-target";
      const identity: ProcessIdentity = {
        uid: 1000,
        gid: 1000,
        gids: [1000, 100],
        username: "sam",
        home: "/home/sam",
        cwd: "/home/sam",
      };

      await registerInKernel(sourcePid, identity);
      const target = await initProcess(targetPid, identity);
      await runInDurableObject(target, (instance: Process) => {
        (instance as any).currentRun = {
          runId: "existing-target-run",
          queued: false,
          conversationId: "default",
        };
      });

      const kernel = await getKernelPtr();
      const response = await runInDurableObject(kernel, (instance: Kernel) =>
        instance.recvFrame(
          sourcePid,
          makeReq("proc.ipc.send", {
            pid: targetPid,
            conversationId: "mail",
            message: "Please summarize the current build status.",
            metadata: { kind: "delegation" },
          }),
        ),
      ) as ResponseOkFrame;

      expect(response.ok).toBe(true);
      expect(response.data).toMatchObject({
        ok: true,
        status: "started",
        pid: targetPid,
        sourcePid,
        conversationId: "mail",
        queued: true,
      });

      await runInDurableObject(target, (instance: Process) => {
        const process = instance as any;
        const store = process.store;
        const messages = store.getMessages({ conversationId: "mail" });
        expect(messages).toHaveLength(0);
        expect(store.queueSize("mail")).toBe(1);
        const queued = store.drainQueue("mail");
        expect(queued[0].message).toContain(`Message from sam (${sourcePid}).`);
        expect(queued[0].message).toContain("Please summarize the current build status.");
        expect(queued[0].message).toContain('"kind": "delegation"');
        expect(process.currentRun).toMatchObject({
          conversationId: "default",
        });
        process.currentRun = null;
      });
    });

    it("rejects cross-owner process messages in the kernel", async () => {
      const sourcePid = "mech-ipc-foreign-source";
      const targetPid = "mech-ipc-foreign-target";
      const sourceIdentity: ProcessIdentity = {
        uid: 1000,
        gid: 1000,
        gids: [1000, 100],
        username: "sam",
        home: "/home/sam",
        cwd: "/home/sam",
      };
      const targetIdentity: ProcessIdentity = {
        uid: 1001,
        gid: 1001,
        gids: [1001, 100],
        username: "lee",
        home: "/home/lee",
        cwd: "/home/lee",
      };

      await registerInKernel(sourcePid, sourceIdentity);
      await registerInKernel(targetPid, targetIdentity);

      const kernel = await getKernelPtr();
      const response = await runInDurableObject(kernel, (instance: Kernel) =>
        instance.recvFrame(
          sourcePid,
          makeReq("proc.ipc.send", {
            pid: targetPid,
            message: "This should not cross uid boundaries.",
          }),
        ),
      ) as ResponseOkFrame;

      expect(response.ok).toBe(true);
      expect(response.data).toEqual({
        ok: false,
        error: "Permission denied: target process belongs to another user",
      });
    });

    it("registers bounded calls and delivers replies back to the source process", async () => {
      const sourcePid = "mech-ipc-call-source";
      const targetPid = "mech-ipc-call-target";
      const identity: ProcessIdentity = {
        uid: 1000,
        gid: 1000,
        gids: [1000, 100],
        username: "sam",
        home: "/home/sam",
        cwd: "/home/sam",
      };

      const source = await initProcess(sourcePid, identity);
      const target = await initProcess(targetPid, identity);
      await runInDurableObject(source, (instance: Process) => {
        (instance as any).scheduleTick = () => {};
      });
      await runInDurableObject(target, (instance: Process) => {
        (instance as any).currentRun = {
          runId: "existing-target-run",
          queued: false,
          conversationId: "default",
        };
      });

      const kernel = await getKernelPtr();
      const response = await runInDurableObject(kernel, (instance: Kernel) =>
        instance.recvFrame(
          sourcePid,
          makeReq("proc.ipc.call", {
            pid: targetPid,
            conversationId: "mail",
            message: "Please reply with the status.",
            timeoutMs: 30_000,
          }),
        ),
      ) as ResponseOkFrame;

      expect(response.ok).toBe(true);
      const data = response.data as any;
      expect(data).toMatchObject({
        ok: true,
        status: "started",
        pid: targetPid,
        sourcePid,
        conversationId: "mail",
        queued: true,
      });
      expect(data.callId).toBeTruthy();
      expect(data.deadlineAt).toBeGreaterThan(Date.now());

      await runInDurableObject(target, (instance: Process) => {
        const store = (instance as any).store;
        const queued = store.drainQueue("mail");
        expect(queued).toHaveLength(1);
        expect(queued[0].message).toContain(`Delegated task from sam (${sourcePid}).`);
        expect(queued[0].message).toContain("Please complete this task before");
        expect(queued[0].message).toContain("Your final answer will be returned to the caller automatically.");
        expect(queued[0].message).not.toContain("Call id:");
        expect(queued[0].message).not.toContain("Reply target:");
        store.enqueue(data.runId, queued[0].message, undefined, undefined, "mail");
      });

      await runInDurableObject(kernel, async (instance: Kernel) => {
        await (instance as any).handleProcessSignal(targetPid, {
          type: "sig",
          signal: "proc.run.finished",
          payload: {
            pid: targetPid,
            runId: data.runId,
            text: "status is green",
          },
        });
      });

      await runInDurableObject(source, (instance: Process) => {
        const process = instance as any;
        const store = process.store;
        const messages = store.getMessages();
        expect(messages).toHaveLength(1);
        expect(messages[0].role).toBe("system");
        expect(messages[0].content).toContain(`Delegated task from process \`${targetPid}\` finished.`);
        expect(messages[0].content).toContain(`Task id: \`${data.callId}\`.`);
        expect(messages[0].content).toContain("status is green");
        expect(process.currentRun).toMatchObject({
          conversationId: "default",
        });
        process.currentRun = null;
      });
    });

    it("awaits IPC reply delivery before returning from process signal recvFrame", async () => {
      const sourcePid = "mech-ipc-await-source";
      const targetPid = "mech-ipc-await-target";
      const source = await initProcess(sourcePid, ROOT_IDENTITY);
      await initProcess(targetPid, ROOT_IDENTITY);
      await runInDurableObject(source, (instance: Process) => {
        (instance as any).scheduleTick = () => {};
      });

      const kernel = await getKernelPtr();
      const response = await runInDurableObject(kernel, (instance: Kernel) =>
        instance.recvFrame(
          sourcePid,
          makeReq("proc.ipc.call", {
            pid: targetPid,
            message: "Return the status.",
            timeoutMs: 30_000,
          }),
        ),
      ) as ResponseOkFrame;

      const data = response.data as any;
      expect(data.ok).toBe(true);

      await runInDurableObject(kernel, async (instance: Kernel) => {
        const k = instance as any;
        const original = k.deliverIpcCallSignal;
        k.deliverIpcCallSignal = async (...args: unknown[]) => {
          await new Promise((resolve) => setTimeout(resolve, 25));
          return original.apply(k, args);
        };
        try {
          await instance.recvFrame(targetPid, {
            type: "sig",
            signal: "proc.run.finished",
            payload: {
              pid: targetPid,
              runId: data.runId,
              text: "worker completed",
            },
          });
        } finally {
          k.deliverIpcCallSignal = original;
        }
      });

      await runInDurableObject(source, (instance: Process) => {
        const messages = (instance as any).store.getMessages();
        const reply = messages.find((message: any) =>
          message.role === "system"
          && message.content.includes(`Task id: \`${data.callId}\``)
        );
        expect(reply).toBeTruthy();
        expect(reply.content).toContain("worker completed");
        (instance as any).currentRun = null;
      });
    });

    it("defers the fallback wake run until a busy source run finishes", async () => {
      const sourcePid = "mech-ipc-busy-source";
      const targetPid = "mech-ipc-busy-target";
      const source = await initProcess(sourcePid, ROOT_IDENTITY);

      await runInDurableObject(source, (instance: Process) => {
        const process = instance as any;
        process.scheduleTick = vi.fn();
        process.currentRun = {
          runId: "active-source-run",
          queued: false,
          conversationId: "default",
        };
      });

      await source.recvFrame({
        type: "sig",
        signal: "ipc.reply",
        payload: {
          callId: "busy-call",
          sourcePid,
          targetPid,
          runId: "target-run",
          deadlineAt: Date.now() + 30_000,
          status: "completed",
          response: { text: "busy result", usage: null },
        },
      });

      await runInDurableObject(source, (instance: Process) => {
        const process = instance as any;
        const messages = process.store.getMessages();
        expect(messages).toHaveLength(1);
        expect(messages[0].role).toBe("system");
        expect(messages[0].content).toContain(`Delegated task from process \`${targetPid}\` finished.`);
        expect(messages[0].content).toContain("busy result");
        expect(process.currentRun).toMatchObject({
          runId: "active-source-run",
          pendingRuntimeEvents: 1,
        });
        expect(process.store.queueSize("default")).toBe(0);
        expect(process.scheduleTick).not.toHaveBeenCalled();
      });

      await runInDurableObject(source, async (instance: Process) => {
        const process = instance as any;
        await process.finishRun({
          reason: "turn.complete",
          status: "ok",
          text: "parent finished before reading the event",
        });
      });

      await runInDurableObject(source, (instance: Process) => {
        const process = instance as any;
        const userMessages = process.store.getMessages()
          .filter((message: any) => message.role === "user");
        expect(userMessages.at(-1)?.content).toContain("A delegated task event arrived while you were busy.");
        expect(process.store.queueSize("default")).toBe(0);
        expect(process.currentRun?.runId).not.toBe("active-source-run");
        expect(process.currentRun).toMatchObject({ conversationId: "default" });
        process.currentRun = null;
      });
    });

    it("uses a busy bounded IPC reply on the next tool-result turn", async () => {
      const sourcePid = "mech-ipc-next-turn-source";
      const targetPid = "mech-ipc-next-turn-target";
      const source = await initProcess(sourcePid, ROOT_IDENTITY);

      const result = await runInDurableObject(source, async (instance: Process) => {
        const process = instance as any;
        const generatedInputs: string[] = [];
        process.sendSignal = async () => {};
        process.generation = {
          async generate(request: any) {
            generatedInputs.push(JSON.stringify(request.context.messages));
            return {
              role: "assistant",
              content: [{ type: "text", text: "used delegated result" }],
              api: "test",
              provider: "test",
              model: "test",
              stopReason: "stop",
              timestamp: Date.now(),
            };
          },
          async generateText() {
            return "";
          },
        };
        process.store.appendMessage("user", "Wait for delegated work.", {
          runId: "active-source-turn",
        });
        process.store.appendMessage("assistant", "Waiting on a command.", {
          runId: "active-source-turn",
          toolCalls: JSON.stringify({
            toolCalls: [
              {
                type: "toolCall",
                id: "call_shell",
                name: "Shell",
                arguments: { input: "sleep 10", target: "gsv" },
              },
            ],
          }),
        });
        process.store.register("call_shell", "active-source-turn", "shell.exec", {
          input: "sleep 10",
          target: "gsv",
        });
        process.store.resolve("call_shell", { ok: true, stdout: "done" });
        process.currentRun = {
          runId: "active-source-turn",
          queued: false,
          conversationId: "default",
          config: {
            profile: "task",
            provider: "workers-ai",
            model: "@cf/test/model",
            apiKey: "",
            reasoning: "off",
            maxTokens: 8192,
          },
          tools: [],
          devices: [],
          mcpServers: [],
          systemPrompt: "Test system prompt.",
          approvalPolicy: { default: "auto", rules: [] },
        };

        await process.recvFrame({
          type: "sig",
          signal: "ipc.reply",
          payload: {
            callId: "next-turn-call",
            sourcePid,
            targetPid,
            runId: "target-run",
            deadlineAt: Date.now() + 30_000,
            status: "completed",
            response: { text: "next-turn result", usage: null },
          },
        });

        expect(process.currentRun).toMatchObject({
          runId: "active-source-turn",
          pendingRuntimeEvents: 1,
        });
        expect(process.store.queueSize("default")).toBe(0);

        await process.continueAgentLoop("active-source-turn");

        return {
          generatedInputs,
          queueSize: process.store.queueSize("default"),
          currentRun: process.currentRun,
          messages: process.store.getMessages(),
        };
      });

      expect(result.generatedInputs).toHaveLength(1);
      expect(result.generatedInputs[0]).toContain("next-turn result");
      expect(result.queueSize).toBe(0);
      expect(result.currentRun).toBeNull();
      const assistant = result.messages
        .filter((message: any) => message.role === "assistant")
        .pop();
      expect(assistant?.content).toContain("used delegated result");
    });

    it("drives a bounded IPC reply through the target and source agent loops", async () => {
      const sourcePid = "mech-ipc-loop-source";
      const targetPid = "mech-ipc-loop-target";
      const token = "IPC_GREEN_E2E";
      const source = await initProcess(sourcePid, ROOT_IDENTITY);
      const target = await initProcess(targetPid, ROOT_IDENTITY);

      await stubGeneration(target, (request) => {
        const input = JSON.stringify(request.context.messages);
        expect(input).toContain(`Delegated task from root (${sourcePid}).`);
        expect(input).toContain(`Reply with exactly this token and nothing else: ${token}`);
        return token;
      });
      await stubGeneration(source, (request) => {
        const input = JSON.stringify(request.context.messages);
        expect(input).toContain("Delegated task");
        expect(input).toContain("finished");
        expect(input).toContain(token);
        return token;
      });

      const kernel = await getKernelPtr();
      const response = await runInDurableObject(kernel, (instance: Kernel) =>
        instance.recvFrame(
          sourcePid,
          makeReq("proc.ipc.call", {
            pid: targetPid,
            conversationId: "ipc-real",
            message: `Reply with exactly this token and nothing else: ${token}. Do not call tools.`,
            timeoutMs: 60_000,
          }),
        ),
      ) as ResponseOkFrame;

      expect(response.ok).toBe(true);
      const data = response.data as any;
      expect(data).toMatchObject({
        ok: true,
        status: "started",
        pid: targetPid,
        sourcePid,
        conversationId: "ipc-real",
      });
      expect(data.callId).toBeTruthy();
      expect(data.runId).toBeTruthy();

      await driveProcessUntilIdle(target, 10_000);

      let replyMessage: any = null;
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        replyMessage = await runInDurableObject(source, (instance: Process) => {
          const messages = (instance as any).store.getMessages();
          return messages.find((message: any) =>
            message.role === "system"
            && message.content.includes(`Task id: \`${data.callId}\``)
          ) ?? null;
        });
        if (replyMessage) break;
        await new Promise((r) => setTimeout(r, 100));
      }

      expect(replyMessage).toBeTruthy();
      expect(replyMessage.content).toContain(token);

      await driveProcessUntilIdle(source, 10_000);

      await runInDurableObject(source, (instance: Process) => {
        const messages = (instance as any).store.getMessages();
        const assistant = messages.filter((message: any) => message.role === "assistant").pop();
        expect(assistant).toBeDefined();
        expect(assistant!.content).toContain(token);
      });
    });

    it("delivers bounded call timeouts to the source process", async () => {
      const sourcePid = "mech-ipc-timeout-source";
      const targetPid = "mech-ipc-timeout-target";
      const source = await initProcess(sourcePid, ROOT_IDENTITY);
      await initProcess(targetPid, ROOT_IDENTITY);
      await runInDurableObject(source, (instance: Process) => {
        (instance as any).scheduleTick = () => {};
      });

      const kernel = await getKernelPtr();
      const response = await runInDurableObject(kernel, (instance: Kernel) =>
        instance.recvFrame(
          sourcePid,
          makeReq("proc.ipc.call", {
            pid: targetPid,
            message: "This call will timeout in the test.",
            timeoutMs: 10_000,
          }),
        ),
      ) as ResponseOkFrame;

      const data = response.data as any;
      expect(data.ok).toBe(true);

      await runInDurableObject(kernel, async (instance: Kernel) => {
        const k = instance as any;
        const timedOut = k.ipcCalls.timeout(data.callId, data.deadlineAt + 1);
        expect(timedOut).toBeTruthy();
        await k.deliverIpcCallSignal("ipc.timeout", timedOut, {
          error: timedOut.error,
        });
      });

      await runInDurableObject(source, (instance: Process) => {
        const process = instance as any;
        const messages = process.store.getMessages();
        expect(messages).toHaveLength(1);
        expect(messages[0].role).toBe("system");
        expect(messages[0].content).toContain(`Delegated task to process \`${targetPid}\` timed out.`);
        expect(messages[0].content).toContain(`Task id: \`${data.callId}\`.`);
        process.currentRun = null;
      });
    });

    it("queues delivered IPC when the target process is already running", async () => {
      const pid = "mech-ipc-queued";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      await runInDurableObject(stub, (instance: Process) => {
        const process = instance as any;
        process.scheduleTick = () => {};
        process.currentRun = {
          runId: "active-run",
          queued: false,
          conversationId: "default",
        };
      });

      const response = await stub.recvFrame(makeReq("proc.ipc.deliver", {
        sourcePid: "source-process",
        source: ROOT_IDENTITY,
        conversationId: "side",
        message: "Queued IPC work.",
        metadata: { priority: "normal" },
        sentAt: 1_700_000_000_000,
      })) as ResponseOkFrame;

      expect(response.ok).toBe(true);
      expect(response.data).toMatchObject({
        ok: true,
        status: "started",
        pid,
        sourcePid: "source-process",
        conversationId: "side",
        queued: true,
      });

      await runInDurableObject(stub, (instance: Process) => {
        const process = instance as any;
        const store = process.store;
        expect(store.messageCount("side")).toBe(0);
        expect(store.queueSize("side")).toBe(1);
        const queued = store.drainQueue("side");
        expect(queued[0].message).toContain("Queued IPC work.");
        expect(queued[0].message).toContain('"priority": "normal"');
        process.currentRun = null;
      });
    });
  });

  describe("proc.conversation.*", () => {
    it("opens, gets, and lists process conversations", async () => {
      const pid = "mech-conversation-open";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      const openRes = (await stub.recvFrame(
        makeReq("proc.conversation.open", {
          conversationId: "build",
          title: "Build thread",
        }),
      )) as ResponseOkFrame;

      expect(openRes.ok).toBe(true);
      expect(openRes.data).toMatchObject({
        ok: true,
        pid,
        created: true,
        conversation: {
          id: "build",
          generation: 1,
          status: "open",
          title: "Build thread",
          messageCount: 0,
        },
      });

      const getRes = (await stub.recvFrame(
        makeReq("proc.conversation.get", { conversationId: "build" }),
      )) as ResponseOkFrame;
      expect(getRes.data).toMatchObject({
        ok: true,
        pid,
        conversation: {
          id: "build",
          status: "open",
        },
      });

      const listRes = (await stub.recvFrame(
        makeReq("proc.conversation.list", {}),
      )) as ResponseOkFrame;
      const listData = listRes.data as any;
      expect(listData.ok).toBe(true);
      expect(listData.conversations.map((conversation: any) => conversation.id).sort()).toEqual([
        "build",
        "default",
      ]);
    });

    it("closes conversations and rejects new sends to them", async () => {
      const pid = "mech-conversation-close";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      await stub.recvFrame(makeReq("proc.conversation.open", { conversationId: "closed" }));

      const closeRes = (await stub.recvFrame(
        makeReq("proc.conversation.close", { conversationId: "closed" }),
      )) as ResponseOkFrame;
      expect(closeRes.data).toEqual({
        ok: true,
        pid,
        conversationId: "closed",
        closed: true,
      });

      const sendRes = (await stub.recvFrame(
        makeReq("proc.send", {
          conversationId: "closed",
          message: "should not start",
        }),
      )) as ResponseOkFrame;
      expect(sendRes.ok).toBe(true);
      expect(sendRes.data).toEqual({
        ok: false,
        error: "Conversation is closed: closed",
      });

      const listOpenRes = (await stub.recvFrame(
        makeReq("proc.conversation.list", {}),
      )) as ResponseOkFrame;
      expect((listOpenRes.data as any).conversations.map((conversation: any) => conversation.id)).toEqual([
        "default",
      ]);

      const listAllRes = (await stub.recvFrame(
        makeReq("proc.conversation.list", { includeClosed: true }),
      )) as ResponseOkFrame;
      expect((listAllRes.data as any).conversations.map((conversation: any) => conversation.id).sort()).toEqual([
        "closed",
        "default",
      ]);
    });

    it("resets one conversation without clearing another", async () => {
      const pid = "mech-conversation-reset";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      await runInDurableObject(stub, (instance: Process) => {
        const store = (instance as any).store;
        store.appendMessage("user", "default survives");
        store.openConversation({ conversationId: "side", title: "Side" });
        store.appendMessage("user", "side archive me", { conversationId: "side" });
      });

      const resetRes = (await stub.recvFrame(
        makeReq("proc.conversation.reset", { conversationId: "side" }),
      )) as ResponseOkFrame;
      const resetData = resetRes.data as any;

      expect(resetData).toMatchObject({
        ok: true,
        pid,
        conversationId: "side",
        generation: 2,
        archivedMessages: 1,
      });
      expect(resetData.archivedTo).toContain(`/root/conversations/side/`);

      const archiveKey = resetData.archivedTo.replace(/^\//, "");
      const obj = await env.STORAGE.get(archiveKey);
      expect(obj).not.toBeNull();

      const generationsRes = (await stub.recvFrame(
        makeReq("proc.conversation.generations", { conversationId: "side" }),
      )) as ResponseOkFrame;
      expect((generationsRes.data as any).generations).toEqual([1, 2]);

      const manifestRes = (await stub.recvFrame(
        makeReq("proc.conversation.generation.manifest", {
          conversationId: "side",
          generation: 1,
        }),
      )) as ResponseOkFrame;
      expect((manifestRes.data as any).manifest).toMatchObject({
        conversationId: "side",
        generation: 1,
        current: false,
        archives: [
          expect.objectContaining({
            kind: "reset",
            messages: 1,
            archivePath: resetData.archivedTo,
          }),
        ],
        segments: [],
        live: null,
      });

      const timelineRes = (await stub.recvFrame(
        makeReq("proc.conversation.timeline", { conversationId: "side" }),
      )) as ResponseOkFrame;
      expect((timelineRes.data as any).timeline).toEqual([
        expect.objectContaining({
          type: "archive",
          archiveKind: "reset",
          generation: 1,
          archivePath: resetData.archivedTo,
        }),
        expect.objectContaining({
          type: "live",
          generation: 2,
          messageCount: 0,
        }),
      ]);

      await runInDurableObject(stub, (instance: Process) => {
        const store = (instance as any).store;
        expect(store.messageCount()).toBe(1);
        expect(store.getMessages()[0].content).toBe("default survives");
        expect(store.messageCount("side")).toBe(0);
        expect(store.getConversation("side")).toMatchObject({
          id: "side",
          generation: 2,
          status: "open",
          title: "Side",
        });
      });
    });

    it("resets active conversation runtime and promotes queued work elsewhere", async () => {
      const pid = "mech-conversation-reset-runtime";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      await runInDurableObject(stub, (instance: Process) => {
        const process = instance as any;
        const store = process.store;
        process.scheduleTick = () => {};
        store.openConversation({ conversationId: "side" });
        store.appendMessage("user", "side before reset", { conversationId: "side" });
        store.register("call-side", "run-side", "fs.read", { path: "/tmp/side.txt" }, "side");
        store.enqueue("run-side-next", "side queued", undefined, undefined, "side");
        store.enqueue("run-default-next", "default queued");
        process.currentRun = {
          runId: "run-side",
          queued: false,
          conversationId: "side",
        };
      });

      const resetRes = (await stub.recvFrame(
        makeReq("proc.conversation.reset", {
          conversationId: "side",
          archive: false,
        }),
      )) as ResponseOkFrame;
      expect(resetRes.data).toMatchObject({
        ok: true,
        pid,
        conversationId: "side",
        generation: 2,
        archivedMessages: 1,
      });
      expect((resetRes.data as any).archivedTo).toBeUndefined();

      await runInDurableObject(stub, (instance: Process) => {
        const process = instance as any;
        const store = process.store;
        expect(store.messageCount("side")).toBe(0);
        expect(store.queueSize("side")).toBe(0);
        expect(store.getResults("run-side")).toHaveLength(0);
        expect(process.currentRun).toMatchObject({
          runId: "run-default-next",
          conversationId: "default",
        });
        const defaultMessages = store.getMessages();
        expect(defaultMessages[0]).toMatchObject({
          role: "user",
          content: "default queued",
          generation: 1,
        });
        process.currentRun = null;
      });
    });

    it("compacts a conversation prefix into an archived segment", async () => {
      const pid = "mech-conversation-compact";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      const messageIds = await runInDurableObject(stub, (instance: Process) => {
        const process = instance as any;
        const store = process.store;
        process.__signals = [];
        process.sendSignal = async (signal: string, payload: unknown) => {
          process.__signals.push({ signal, payload });
        };
        store.openConversation({ conversationId: "thread", title: "Thread" });
        return [
          store.appendMessage("user", "old user", { conversationId: "thread" }),
          store.appendMessage("assistant", "old assistant", { conversationId: "thread" }),
          store.appendMessage("user", "keep this", { conversationId: "thread" }),
        ];
      });

      const compactRes = (await stub.recvFrame(
        makeReq("proc.conversation.compact", {
          conversationId: "thread",
          keepLast: 1,
          summary: "The old exchange established the thread context.",
        }),
      )) as ResponseOkFrame;
      const data = compactRes.data as any;

      expect(data).toMatchObject({
        ok: true,
        pid,
        conversationId: "thread",
        archivedMessages: 2,
        summaryMessageId: messageIds[0],
        segment: {
          conversationId: "thread",
          generation: 1,
          kind: "compaction",
          fromMessageId: messageIds[0],
          toMessageId: messageIds[1],
          summaryMessageId: messageIds[0],
        },
      });
      expect(data.archivedTo).toMatch(
        new RegExp(`/root/conversations/thread/.+\\.jsonl\\.gz$`),
      );

      const archiveKey = data.archivedTo.replace(/^\//, "");
      expect(await env.STORAGE.get(archiveKey)).not.toBeNull();

      await runInDurableObject(stub, (instance: Process) => {
        const store = (instance as any).store;
        const messages = store.getMessages({ conversationId: "thread" });
        expect(messages).toHaveLength(2);
        expect(messages[0]).toMatchObject({
          id: messageIds[0],
          role: "system",
        });
        expect(messages[0].content).toContain("Conversation compacted.");
        expect(messages[0].content).toContain(data.archivedTo);
        expect(messages[0].content).toContain("The old exchange established the thread context.");
        expect(messages[1]).toMatchObject({
          id: messageIds[2],
          role: "user",
          content: "keep this",
        });
        expect((instance as any).__signals).toEqual([
          {
            signal: "proc.changed",
            payload: expect.objectContaining({
              event: "conversation.compacted",
              pid,
              conversationId: "thread",
              archivedMessages: 2,
              archivedTo: data.archivedTo,
              summaryMessageId: messageIds[0],
              segment: expect.objectContaining({
                id: data.segment.id,
              }),
            }),
          },
        ]);
      });

      const segmentsRes = (await stub.recvFrame(
        makeReq("proc.conversation.segments", { conversationId: "thread" }),
      )) as ResponseOkFrame;
      expect((segmentsRes.data as any).segments).toEqual([
        expect.objectContaining({
          id: data.segment.id,
          archivePath: data.archivedTo,
          summaryMessageId: messageIds[0],
        }),
      ]);

      const timelineRes = (await stub.recvFrame(
        makeReq("proc.conversation.timeline", { conversationId: "thread" }),
      )) as ResponseOkFrame;
      expect((timelineRes.data as any).timeline).toEqual([
        expect.objectContaining({
          type: "segment",
          id: data.segment.id,
          generation: 1,
        }),
        expect.objectContaining({
          type: "live",
          generation: 1,
          messageCount: 2,
          firstMessageId: messageIds[0],
          lastMessageId: messageIds[2],
        }),
      ]);
    });

    it("can generate the compaction summary from selected messages", async () => {
      const pid = "mech-conversation-compact-generated";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      await runInDurableObject(stub, (instance: Process) => {
        const process = instance as any;
        const store = process.store;
        store.openConversation({ conversationId: "thread", title: "Thread" });
        store.appendMessage("user", "old user goal", { conversationId: "thread" });
        store.appendMessage("assistant", "old assistant decision", { conversationId: "thread" });
        store.appendMessage("user", "keep this", { conversationId: "thread" });
        process.currentRun = {
          runId: "config-source",
          queued: false,
          conversationId: "other",
          config: {
            profile: "task",
            provider: "workers-ai",
            model: "@cf/test/model",
            apiKey: "",
            reasoning: "off",
            maxTokens: 4096,
          },
        };
        process.generation = {
          async generate() {
            throw new Error("unexpected chat generation");
          },
          async generateText(request: any) {
            expect(request.options).toMatchObject({ maxTokens: 768, reasoning: "off" });
            expect(request.context.messages[0].content).toContain("old user goal");
            return "Generated compact summary.";
          },
        };
      });

      const compactRes = (await stub.recvFrame(
        makeReq("proc.conversation.compact", {
          conversationId: "thread",
          keepLast: 1,
          generateSummary: true,
        }),
      )) as ResponseOkFrame;
      expect(compactRes.data).toMatchObject({
        ok: true,
        pid,
        conversationId: "thread",
        archivedMessages: 2,
      });

      await runInDurableObject(stub, (instance: Process) => {
        const process = instance as any;
        const messages = process.store.getMessages({ conversationId: "thread" });
        expect(messages[0].content).toContain("Generated compact summary.");
        process.currentRun = null;
      });
    });

    it("reads compacted segment archives with pagination", async () => {
      const pid = "mech-conversation-segment-read";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      await runInDurableObject(stub, (instance: Process) => {
        const store = (instance as any).store;
        store.openConversation({ conversationId: "thread", title: "Thread" });
        store.appendMessage("user", "old user", { conversationId: "thread", createdAt: 10 });
        store.appendMessage("assistant", "old assistant", { conversationId: "thread", createdAt: 20 });
        store.appendMessage("user", "keep this", { conversationId: "thread", createdAt: 30 });
      });

      const compactRes = (await stub.recvFrame(
        makeReq("proc.conversation.compact", {
          conversationId: "thread",
          keepLast: 1,
          summary: "Earlier context.",
        }),
      )) as ResponseOkFrame;
      const compactData = compactRes.data as any;

      const firstPageRes = (await stub.recvFrame(
        makeReq("proc.conversation.segment.read", {
          conversationId: "thread",
          segmentId: compactData.segment.id,
          limit: 1,
        }),
      )) as ResponseOkFrame;
      const firstPage = firstPageRes.data as any;
      expect(firstPage).toMatchObject({
        ok: true,
        pid,
        conversationId: "thread",
        messageCount: 2,
        truncated: true,
        segment: {
          id: compactData.segment.id,
          archivePath: compactData.archivedTo,
        },
      });
      expect(firstPage.messages).toEqual([
        {
          id: expect.any(Number),
          role: "user",
          content: "old user",
          timestamp: 10,
        },
      ]);

      const secondPageRes = (await stub.recvFrame(
        makeReq("proc.conversation.segment.read", {
          conversationId: "thread",
          segmentId: compactData.segment.id,
          limit: 1,
          offset: 1,
        }),
      )) as ResponseOkFrame;
      expect((secondPageRes.data as any).messages).toEqual([
        {
          id: expect.any(Number),
          role: "assistant",
          content: {
            text: "old assistant",
            thinking: [],
            toolCalls: [],
          },
          timestamp: 20,
        },
      ]);
      expect((secondPageRes.data as any).truncated).toBe(false);
    });

    it("forks a live conversation from a message", async () => {
      const pid = "mech-conversation-fork-message";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      const messageIds = await runInDurableObject(stub, (instance: Process) => {
        const process = instance as any;
        const store = process.store;
        process.__signals = [];
        process.sendSignal = async (signal: string, payload: unknown) => {
          process.__signals.push({ signal, payload });
        };
        store.openConversation({ conversationId: "thread", title: "Thread" });
        return [
          store.appendMessage("user", "first", { conversationId: "thread" }),
          store.appendMessage("assistant", "second", { conversationId: "thread" }),
          store.appendMessage("user", "third", { conversationId: "thread" }),
        ];
      });

      const forkRes = (await stub.recvFrame(
        makeReq("proc.conversation.fork", {
          conversationId: "thread",
          throughMessageId: messageIds[1],
          targetConversationId: "branch",
          title: "Branch",
        }),
      )) as ResponseOkFrame;
      expect(forkRes.data).toMatchObject({
        ok: true,
        pid,
        sourceConversationId: "thread",
        throughMessageId: messageIds[1],
        restoredMessages: 2,
        includedLiveSuffix: false,
        targetConversation: {
          id: "branch",
          title: "Branch",
          messageCount: 2,
        },
      });

      const historyRes = (await stub.recvFrame(
        makeReq("proc.history", { conversationId: "branch" }),
      )) as ResponseOkFrame;
      expect((historyRes.data as any).messages.map((message: any) => ({
        id: message.id,
        role: message.role,
        content: message.content,
      }))).toEqual([
        { id: expect.any(Number), role: "user", content: "first" },
        { id: expect.any(Number), role: "assistant", content: "second" },
      ]);

      await runInDurableObject(stub, (instance: Process) => {
        const process = instance as any;
        expect(process.store.getMessages({ conversationId: "thread" }).map((message: any) => message.content)).toEqual([
          "first",
          "second",
          "third",
        ]);
        expect(process.__signals).toEqual([
          {
            signal: "proc.changed",
            payload: expect.objectContaining({
              event: "conversation.forked",
              pid,
              sourceConversationId: "thread",
              targetConversationId: "branch",
              throughMessageId: messageIds[1],
              restoredMessages: 2,
            }),
          },
        ]);
      });
    });

    it("forks a compacted segment into a new conversation", async () => {
      const pid = "mech-conversation-fork-segment";
      const stub = await initProcess(pid, ROOT_IDENTITY);
      const archivedOrigin = {
        kind: "adapter",
        adapter: "whatsapp",
        accountId: "primary",
        surface: { kind: "group", id: "group-1", name: "GSV Dev" },
        actorId: "wa:+123",
        actorLabel: "@sam",
      };
      const liveOrigin = {
        kind: "client",
        connectionId: "conn-1",
        clientId: "gsv-ui",
        platform: "browser",
      };

      await runInDurableObject(stub, (instance: Process) => {
        const store = (instance as any).store;
        store.openConversation({ conversationId: "thread", title: "Thread" });
        store.appendMessage("user", "old user", {
          conversationId: "thread",
          createdAt: 10,
          origin: JSON.stringify(archivedOrigin),
        });
        store.appendMessage("assistant", "old assistant", { conversationId: "thread", createdAt: 20 });
        store.appendMessage("user", "keep this", {
          conversationId: "thread",
          createdAt: 30,
          origin: JSON.stringify(liveOrigin),
        });
      });

      const compactRes = (await stub.recvFrame(
        makeReq("proc.conversation.compact", {
          conversationId: "thread",
          keepLast: 1,
          summary: "Earlier context.",
        }),
      )) as ResponseOkFrame;
      const compactData = compactRes.data as any;

      await runInDurableObject(stub, (instance: Process) => {
        const store = (instance as any).store;
        store.appendMessage("user", "later live message", {
          conversationId: "thread",
          createdAt: compactData.segment.createdAt + 1000,
        });
      });

      const forkRes = (await stub.recvFrame(
        makeReq("proc.conversation.fork", {
          conversationId: "thread",
          segmentId: compactData.segment.id,
          targetConversationId: "thread-restored",
          title: "Restored thread",
        }),
      )) as ResponseOkFrame;
      const forkData = forkRes.data as any;

      expect(forkData).toMatchObject({
        ok: true,
        pid,
        sourceConversationId: "thread",
        restoredMessages: 3,
        includedLiveSuffix: true,
        targetConversation: {
          id: "thread-restored",
          title: "Restored thread",
          messageCount: 3,
        },
        segment: {
          id: compactData.segment.id,
          archivePath: compactData.archivedTo,
        },
      });

      await runInDurableObject(stub, (instance: Process) => {
        const store = (instance as any).store;
        const restored = store.getMessages({ conversationId: "thread-restored" });
        expect(restored.map((message: any) => [message.role, message.content])).toEqual([
          ["user", "old user"],
          ["assistant", "old assistant"],
          ["user", "keep this"],
        ]);
        expect(JSON.parse(restored[0].origin)).toEqual(archivedOrigin);
        expect(JSON.parse(restored[2].origin)).toEqual(liveOrigin);

        const source = store.getMessages({ conversationId: "thread" });
        expect(source.map((message: any) => message.content)).toEqual([
          expect.stringContaining("Conversation compacted."),
          "keep this",
          "later live message",
        ]);
      });
    });

    it("rejects compaction while that conversation is active", async () => {
      const pid = "mech-conversation-compact-active";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      await runInDurableObject(stub, (instance: Process) => {
        const process = instance as any;
        const store = process.store;
        store.appendMessage("user", "active message");
        process.currentRun = {
          runId: "run-active-compact",
          queued: false,
          conversationId: "default",
        };
      });

      const compactRes = (await stub.recvFrame(
        makeReq("proc.conversation.compact", {
          keepLast: 0,
          summary: "Should fail.",
        }),
      )) as ResponseOkFrame;
      expect(compactRes.data).toEqual({
        ok: false,
        error: "Conversation is active: default",
      });

      await runInDurableObject(stub, (instance: Process) => {
        (instance as any).currentRun = null;
      });
    });

    it("gets and sets visible conversation context policy", async () => {
      const pid = "mech-conversation-policy";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      const defaultRes = (await stub.recvFrame(
        makeReq("proc.conversation.policy.get", { conversationId: "thread" }),
      )) as ResponseOkFrame;
      expect(defaultRes.data).toMatchObject({
        ok: true,
        pid,
        policy: {
          conversationId: "thread",
          overflow: "auto-compact",
          compactAtPressure: 0.9,
          keepLast: 80,
          updatedAt: 0,
        },
      });

      const setRes = (await stub.recvFrame(
        makeReq("proc.conversation.policy.set", {
          conversationId: "thread",
          overflow: "auto-compact",
          compactAtPressure: 0.82,
          keepLast: 42,
        }),
      )) as ResponseOkFrame;
      expect(setRes.data).toMatchObject({
        ok: true,
        pid,
        policy: {
          conversationId: "thread",
          overflow: "auto-compact",
          compactAtPressure: 0.82,
          keepLast: 42,
        },
      });

      const nextRes = (await stub.recvFrame(
        makeReq("proc.conversation.policy.get", { conversationId: "thread" }),
      )) as ResponseOkFrame;
      expect(nextRes.data).toMatchObject({
        ok: true,
        pid,
        policy: {
          conversationId: "thread",
          overflow: "auto-compact",
          compactAtPressure: 0.82,
          keepLast: 42,
        },
      });
    });

    it("auto-compacts before the model call when policy threshold is crossed", async () => {
      const pid = "mech-conversation-auto-compact";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      const emitted = await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        const emitted: Array<{ signal: string; payload: unknown }> = [];
        process.sendSignal = async (signal: string, payload: unknown) => {
          emitted.push({ signal, payload });
        };
        process.generation = {
          [GENERATION_SERVICE_MARKER]: true,
          async generate(request: any) {
            const serialized = JSON.stringify(request.context);
            expect(serialized).toContain("Context that must stay live.");
            expect(serialized).toContain("Auto compact summary.");
            expect(serialized).not.toContain("old context A");
            return {
              role: "assistant",
              content: [{ type: "text", text: "after compaction" }],
              api: "test",
              provider: "test",
              model: "test",
              usage: {
                input: 100,
                output: 10,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 110,
                cost: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  total: 0,
                },
              },
              stopReason: "stop",
              timestamp: Date.now(),
            };
          },
          async generateText(request: any) {
            expect(request.options).toMatchObject({ maxTokens: 768, reasoning: "off" });
            expect(JSON.stringify(request.context)).toContain("old context A");
            return "Auto compact summary.";
          },
        };

        process.store.appendMessage("user", "old context A");
        process.store.appendMessage("assistant", "old context B");
        process.store.appendMessage("user", "Context that must stay live.");
        process.store.setValue("conversationPolicy:default", JSON.stringify({
          conversationId: "default",
          overflow: "auto-compact",
          compactAtPressure: 0.01,
          keepLast: 1,
          updatedAt: Date.now(),
        }));
        process.currentRun = {
          runId: "run-auto-compact",
          queued: false,
          conversationId: "default",
          config: {
            profile: "task",
            provider: "workers-ai",
            model: "@cf/test/model",
            apiKey: "",
            reasoning: "off",
            maxTokens: 100,
            contextWindowTokens: 1000,
            contextWindowSource: "config",
            maxContextBytes: 32768,
          },
          tools: [],
          devices: [],
          systemPrompt: "Test system prompt.",
          approvalPolicy: { default: "auto", rules: [] },
        };
        await process.continueAgentLoop("run-auto-compact");
        return {
          emitted,
          messages: process.store.getMessages(),
          segments: process.store.listConversationSegments(),
        };
      });

      expect(emitted.messages.map((message: any) => [message.role, message.content])).toEqual([
        ["system", expect.stringContaining("Auto compact summary.")],
        ["user", "Context that must stay live."],
        ["assistant", "after compaction"],
      ]);
      expect(emitted.segments).toHaveLength(1);
      expect(emitted.segments[0]).toMatchObject({
        kind: "compaction",
      });
      const lifecycleEvents = emitted.emitted
        .filter((entry) => entry.signal === "proc.changed")
        .map((entry) => (entry.payload as any).event)
        .filter(Boolean);
      expect(lifecycleEvents).toEqual([
        "conversation.compacted",
        "conversation.auto_compacted",
      ]);
    });

    it("surfaces provider account failures during auto-compaction", async () => {
      const pid = "mech-conversation-auto-compact-provider-billing";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      const result = await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        const emitted: Array<{ signal: string; payload: unknown }> = [];
        process.sendSignal = async (signal: string, payload: unknown) => {
          emitted.push({ signal, payload });
        };
        process.generation = {
          [GENERATION_SERVICE_MARKER]: true,
          async generate() {
            throw new Error("chat generation should not run after compaction failure");
          },
          async generateText(request: any) {
            expect(request.options).toMatchObject({ maxTokens: 768, reasoning: "off" });
            throw new Error("insufficient funds");
          },
        };

        process.store.appendMessage("user", "old context A");
        process.store.appendMessage("assistant", "old context B");
        process.store.appendMessage("user", "Context that must stay live.");
        process.store.setValue("conversationPolicy:default", JSON.stringify({
          conversationId: "default",
          overflow: "auto-compact",
          compactAtPressure: 0.01,
          keepLast: 1,
          updatedAt: Date.now(),
        }));
        process.currentRun = {
          runId: "run-auto-compact-provider-billing",
          queued: false,
          conversationId: "default",
          config: {
            profile: "task",
            provider: "deepseek",
            model: "deepseek-chat",
            apiKey: "test-key",
            reasoning: "off",
            maxTokens: 100,
            contextWindowTokens: 1000,
            contextWindowSource: "config",
            maxContextBytes: 32768,
          },
          tools: [],
          devices: [],
          systemPrompt: "Test system prompt.",
          approvalPolicy: { default: "auto", rules: [] },
        };
        await process.continueAgentLoop("run-auto-compact-provider-billing");
        return {
          emitted,
          currentRun: process.currentRun,
          messages: process.store.getMessages(),
          segments: process.store.listConversationSegments(),
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
      expect(result.emitted).toEqual(expect.arrayContaining([
        {
          signal: "proc.run.finished",
          payload: expect.objectContaining({
            status: "error",
            reason: "context.auto_compact.failed",
            runId: "run-auto-compact-provider-billing",
          }),
        },
      ]));
    });

    it("does not apply auto-compaction after the run is aborted during summary generation", async () => {
      const pid = "mech-conversation-auto-compact-abort";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      const result = await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        const emitted: Array<{ signal: string; payload: unknown }> = [];
        process.sendSignal = async (signal: string, payload: unknown) => {
          emitted.push({ signal, payload });
        };
        process.generation = {
          [GENERATION_SERVICE_MARKER]: true,
          async generate() {
            throw new Error("chat generation should not run after abort");
          },
          async generateText(request: any) {
            expect(request.options).toMatchObject({ maxTokens: 768, reasoning: "off" });
            await process.handleProcAbort();
            return "Summary that should not be applied.";
          },
        };

        process.store.appendMessage("user", "old context A");
        process.store.appendMessage("assistant", "old context B");
        process.store.appendMessage("user", "Context that must stay live.");
        process.store.setValue("conversationPolicy:default", JSON.stringify({
          conversationId: "default",
          overflow: "auto-compact",
          compactAtPressure: 0.01,
          keepLast: 1,
          updatedAt: Date.now(),
        }));
        process.currentRun = {
          runId: "run-auto-compact-abort",
          queued: false,
          conversationId: "default",
          config: {
            profile: "task",
            provider: "workers-ai",
            model: "@cf/test/model",
            apiKey: "",
            reasoning: "off",
            maxTokens: 100,
            contextWindowTokens: 1000,
            contextWindowSource: "config",
            maxContextBytes: 32768,
          },
          tools: [],
          devices: [],
          systemPrompt: "Test system prompt.",
          approvalPolicy: { default: "auto", rules: [] },
        };
        await process.continueAgentLoop("run-auto-compact-abort");
        return {
          emitted,
          currentRun: process.currentRun,
          messages: process.store.getMessages(),
          segments: process.store.listConversationSegments(),
        };
      });

      expect(result.currentRun).toBeNull();
      expect(result.messages.map((message: any) => [message.role, message.content])).toEqual([
        ["user", "old context A"],
        ["assistant", "old context B"],
        ["user", "Context that must stay live."],
      ]);
      expect(result.segments).toHaveLength(0);
      expect(result.emitted).toEqual(expect.arrayContaining([
        {
          signal: "proc.run.finished",
          payload: expect.objectContaining({
            aborted: true,
            runId: "run-auto-compact-abort",
          }),
        },
      ]));
      const lifecycleEvents = result.emitted
        .filter((entry) => entry.signal === "proc.changed")
        .map((entry) => (entry.payload as any).event)
        .filter(Boolean);
      expect(lifecycleEvents).toEqual([]);
    });
  });

  describe("proc.abort", () => {
    it("returns aborted=false when no run is active", async () => {
      const pid = "mech-abort-idle";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      const res = (await stub.recvFrame(
        makeReq("proc.abort", {}),
      )) as ResponseOkFrame;

      expect(res.ok).toBe(true);
      expect(res.data).toMatchObject({
        ok: true,
        pid,
        aborted: false,
      });
    });

    it("synthesizes interrupted tool results and continues the next queued run", async () => {
      const pid = "mech-abort-active";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      await runInDurableObject(stub, (instance: Process) => {
        const process = instance as any;
        process.store.appendMessage("assistant", "", {
          toolCalls: JSON.stringify([
            { type: "toolCall", id: "call-1", name: "Read", arguments: { path: "/root/test.txt" } },
          ]),
        });
        process.store.register("call-1", "run-1", "fs.read", { path: "/root/test.txt" });
        process.store.enqueue("run-2", "follow-up after abort");
        process.currentRun = { runId: "run-1", queued: false };
      });

      const res = (await stub.recvFrame(
        makeReq("proc.abort", {}),
      )) as ResponseOkFrame;

      expect(res.ok).toBe(true);
      expect(res.data).toMatchObject({
        ok: true,
        pid,
        aborted: true,
        runId: "run-1",
        interruptedToolCalls: 1,
        continuedQueuedRunId: "run-2",
      });

      await runInDurableObject(stub, (instance: Process) => {
        const process = instance as any;
        const store = process.store;
        const messages = store.getMessages();
        const lastTwo = messages.slice(-2);
        expect(lastTwo[0].role).toBe("toolResult");
        expect(lastTwo[0].content).toContain("User interrupted tool execution");
        expect(lastTwo[1].role).toBe("user");
        expect(lastTwo[1].content).toBe("follow-up after abort");
        expect(store.queueSize()).toBe(0);
        expect(process.currentRun).toMatchObject({ runId: "run-2" });
      });
    });

    it("returns without waiting for signal fanout delivery", async () => {
      const pid = "mech-abort-nonblocking-signal";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      await runInDurableObject(stub, (instance: Process) => {
        const process = instance as any;
        process.currentRun = { runId: "run-1", queued: false };
      });

      let releaseSignalDispatch!: () => void;
      const signalDispatchBlocked = new Promise<void>((resolve) => {
        releaseSignalDispatch = resolve;
      });
      const signalSpy = vi
        .spyOn(Kernel.prototype as never, "handleProcessSignal" as never)
        .mockImplementation(async () => {
          await signalDispatchBlocked;
        });

      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      try {
        const res = await Promise.race([
          stub.recvFrame(makeReq("proc.abort", {})),
          new Promise<never>((_resolve, reject) => {
            timeoutId = setTimeout(() => reject(new Error("proc.abort timed out waiting for signal delivery")), 150);
          }),
        ]) as ResponseOkFrame;

        expect(res.ok).toBe(true);
        expect(res.data).toMatchObject({
          ok: true,
          pid,
          aborted: true,
          runId: "run-1",
        });
      } finally {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        releaseSignalDispatch();
        await signalDispatchBlocked;
        signalSpy.mockRestore();
      }
    });
  });

  describe("proc.hil", () => {
    it("pauses a run on ask policy and exposes the pending confirmation in history", async () => {
      const pid = "mech-hil-pause";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        process.currentRun = {
          runId: "run-hil-1",
          queued: false,
          approvalPolicy: {
            default: "auto",
            rules: [{ match: "fs.read", action: "ask" }],
          },
        };
        await process.processToolCalls("run-hil-1", [
          { type: "toolCall", id: "call-hil-1", name: "Read", arguments: { path: "/root/secret.txt" } },
        ]);
      });

      const history = (await stub.recvFrame(
        makeReq("proc.history", {}),
      )) as ResponseOkFrame;

      expect(history.ok).toBe(true);
      const data = history.data as any;
      expect(data.pendingHil).toMatchObject({
        runId: "run-hil-1",
        callId: "call-hil-1",
        toolName: "Read",
        syscall: "fs.read",
      });

      await runInDurableObject(stub, (instance: Process) => {
        const process = instance as any;
        expect(process.store.getPendingHilForRun("run-hil-1")).not.toBeNull();
        expect(process.store.getPending("call-hil-1")).toBeNull();
      });
    });

    it("denies a pending confirmation with a synthetic tool result", async () => {
      const pid = "mech-hil-deny";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      const requestId = await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        process.currentRun = {
          runId: "run-hil-2",
          queued: false,
          approvalPolicy: {
            default: "auto",
            rules: [{ match: "fs.read", action: "ask" }],
          },
        };
        await process.processToolCalls("run-hil-2", [
          { type: "toolCall", id: "call-hil-2", name: "Read", arguments: { path: "/root/secret.txt" } },
        ]);
        return process.store.getPendingHilForRun("run-hil-2").requestId;
      });

      const res = (await stub.recvFrame(
        makeReq("proc.hil", { requestId, decision: "deny" }),
      )) as ResponseOkFrame;

      expect(res.ok).toBe(true);
      expect(res.data).toMatchObject({
        ok: true,
        pid,
        requestId,
        decision: "deny",
        resumed: true,
        pendingHil: null,
      });

      await runInDurableObject(stub, (instance: Process) => {
        const process = instance as any;
        const messages = process.store.getMessages();
        const last = messages[messages.length - 1];
        expect(process.store.getPendingHil()).toBeNull();
        expect(last.role).toBe("toolResult");
        expect(last.content).toContain("Tool execution denied by user");
      });
    });

    it("remembers approved tool confirmations for the process", async () => {
      const pid = "mech-hil-remember";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      const requestId = await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        process.currentRun = {
          runId: "run-hil-remember",
          queued: false,
          approvalPolicy: {
            default: "auto",
            rules: [{ match: "fs.read", action: "ask" }],
          },
        };
        await process.processToolCalls("run-hil-remember", [
          { type: "toolCall", id: "call-hil-remember-1", name: "Read", arguments: { path: "/root/one.txt" } },
          { type: "toolCall", id: "call-hil-remember-2", name: "Read", arguments: { path: "/root/two.txt" } },
        ]);
        return process.store.getPendingHilForRun("run-hil-remember").requestId;
      });

      const res = (await stub.recvFrame(
        makeReq("proc.hil", { requestId, decision: "approve", remember: true }),
      )) as ResponseOkFrame;

      expect(res.ok).toBe(true);
      expect(res.data).toMatchObject({
        ok: true,
        pid,
        requestId,
        decision: "approve",
        remembered: true,
        pendingHil: null,
      });

      await runInDurableObject(stub, (instance: Process) => {
        const process = instance as any;
        expect(process.store.getPendingHil()).toBeNull();
        expect(JSON.parse(process.store.getValue("toolApprovalOverrides"))).toEqual([
          {
            match: "fs.read",
            when: { target: "gsv" },
            action: "auto",
          },
        ]);
      });
    });
  });

  describe("proc.history", () => {
    it("returns stored messages", async () => {
      const pid = "mech-history-1";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      await runInDurableObject(stub, (instance: Process) => {
        const store = (instance as any).store;
        store.appendMessage("user", "What is 2+2?", { runId: "run-history-1" });
        store.appendMessage("assistant", "4", { runId: "run-history-1" });
        store.appendMessage("user", "Thanks!");
      });

      const res = (await stub.recvFrame(
        makeReq("proc.history", {}),
      )) as ResponseOkFrame;

      expect(res.ok).toBe(true);
      const data = res.data as any;
      expect(data.ok).toBe(true);
      expect(data.pid).toBe(pid);
      expect(data.messageCount).toBe(3);
      expect(data.messages).toHaveLength(3);
      expect(data.messages[0].role).toBe("user");
      expect(data.messages[0].content).toBe("What is 2+2?");
      expect(data.messages[0].runId).toBe("run-history-1");
      expect(data.messages[1].role).toBe("assistant");
      expect(data.messages[1].content).toBe("4");
      expect(data.messages[1].runId).toBe("run-history-1");
      expect(data.messages[2].runId).toBeUndefined();
    });

    it("returns persisted interaction origin metadata", async () => {
      const pid = "mech-history-origin";
      const stub = await initProcess(pid, ROOT_IDENTITY);
      const origin = {
        kind: "client",
        connectionId: "conn-1",
        clientId: "browser-extension",
        platform: "browser",
      };

      await runInDurableObject(stub, (instance: Process) => {
        const store = (instance as any).store;
        store.appendMessage("user", "from the browser", {
          origin: JSON.stringify(origin),
        });
      });

      const res = (await stub.recvFrame(
        makeReq("proc.history", {}),
      )) as ResponseOkFrame;

      expect(res.ok).toBe(true);
      const data = res.data as any;
      expect(data.messages[0]).toMatchObject({
        role: "user",
        content: "from the browser",
        origin,
      });
    });

    it("returns assistant usage metadata", async () => {
      const pid = "mech-history-usage-metadata";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      await runInDurableObject(stub, (instance: Process) => {
        const store = (instance as any).store;
        store.appendMessage("assistant", "priced reply", {
          metadata: {
            provider: {
              api: "workers-ai-binding",
              provider: "workers-ai",
              model: "@cf/nvidia/nemotron-3-120b-a12b",
            },
            usage: {
              inputTokens: 100,
              outputTokens: 25,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              totalTokens: 125,
              cost: {
                input: 0.00005,
                output: 0.0000375,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0.0000875,
                currency: "USD",
                source: "model-pricing",
              },
            },
          },
        });
      });

      const res = (await stub.recvFrame(
        makeReq("proc.history", {}),
      )) as ResponseOkFrame;

      expect(res.ok).toBe(true);
      const data = res.data as any;
      expect(data.messages[0].metadata).toMatchObject({
        provider: { provider: "workers-ai" },
        usage: {
          inputTokens: 100,
          outputTokens: 25,
          cost: { total: 0.0000875, source: "model-pricing" },
        },
      });
    });

    it("respects limit and offset", async () => {
      const pid = "mech-history-2";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      await runInDurableObject(stub, (instance: Process) => {
        const store = (instance as any).store;
        for (let i = 0; i < 10; i++) {
          store.appendMessage("user", `msg-${i}`);
        }
      });

      const res = (await stub.recvFrame(
        makeReq("proc.history", { limit: 3, offset: 2 }),
      )) as ResponseOkFrame;

      const data = res.data as any;
      expect(data.messages).toHaveLength(3);
      expect(data.messageCount).toBe(10);
      expect(data.truncated).toBe(true);
    });

    it("keeps proc.history paged by default", async () => {
      const pid = "mech-history-default-page";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      await runInDurableObject(stub, (instance: Process) => {
        const store = (instance as any).store;
        for (let i = 0; i < 205; i++) {
          store.appendMessage("user", `msg-${i}`);
        }
      });

      const res = (await stub.recvFrame(
        makeReq("proc.history", {}),
      )) as ResponseOkFrame;

      const data = res.data as any;
      expect(data.messages).toHaveLength(200);
      expect(data.messageCount).toBe(205);
      expect(data.truncated).toBe(true);
    });

    it("supports tail-first and cursor history pagination", async () => {
      const pid = "mech-history-tail-page";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      await runInDurableObject(stub, (instance: Process) => {
        const store = (instance as any).store;
        for (let i = 0; i < 10; i++) {
          store.appendMessage("user", `msg-${i}`);
        }
      });

      const tailRes = (await stub.recvFrame(
        makeReq("proc.history", { tail: true, limit: 3 }),
      )) as ResponseOkFrame;
      const tailData = tailRes.data as any;
      expect(tailData.messages.map((message: any) => message.content)).toEqual(["msg-7", "msg-8", "msg-9"]);
      expect(tailData.hasMoreBefore).toBe(true);
      expect(tailData.hasMoreAfter).toBe(false);
      expect(tailData.truncated).toBe(true);

      const beforeRes = (await stub.recvFrame(
        makeReq("proc.history", { beforeMessageId: tailData.messages[0].id, limit: 3 }),
      )) as ResponseOkFrame;
      const beforeData = beforeRes.data as any;
      expect(beforeData.messages.map((message: any) => message.content)).toEqual(["msg-4", "msg-5", "msg-6"]);
      expect(beforeData.hasMoreBefore).toBe(true);
      expect(beforeData.hasMoreAfter).toBe(true);

      const afterRes = (await stub.recvFrame(
        makeReq("proc.history", { afterMessageId: beforeData.messages[2].id, limit: 2 }),
      )) as ResponseOkFrame;
      const afterData = afterRes.data as any;
      expect(afterData.messages.map((message: any) => message.content)).toEqual(["msg-7", "msg-8"]);
      expect(afterData.hasMoreBefore).toBe(true);
      expect(afterData.hasMoreAfter).toBe(true);
    });

    it("reads history for the requested conversation", async () => {
      const pid = "mech-history-conversation";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      await runInDurableObject(stub, (instance: Process) => {
        const store = (instance as any).store;
        store.appendMessage("user", "default message");
        store.appendMessage("user", "side message", { conversationId: "side" });
      });

      const defaultRes = (await stub.recvFrame(
        makeReq("proc.history", {}),
      )) as ResponseOkFrame;
      const sideRes = (await stub.recvFrame(
        makeReq("proc.history", { conversationId: "side" }),
      )) as ResponseOkFrame;

      const defaultData = defaultRes.data as any;
      const sideData = sideRes.data as any;
      expect(defaultData.conversationId).toBe("default");
      expect(defaultData.messageCount).toBe(1);
      expect(defaultData.messages[0].content).toBe("default message");
      expect(sideData.conversationId).toBe("side");
      expect(sideData.messageCount).toBe(1);
      expect(sideData.messages[0].content).toBe("side message");
    });

    it("exposes active run metadata for restore-time controls", async () => {
      const pid = "mech-history-active-run";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      await runInDurableObject(stub, (instance: Process) => {
        const process = instance as any;
        process.currentRun = {
          runId: "run-history-active",
          queued: false,
          conversationId: "side",
        };
      });

      const res = (await stub.recvFrame(
        makeReq("proc.history", { conversationId: "side" }),
      )) as ResponseOkFrame;

      expect(res.ok).toBe(true);
      const data = res.data as any;
      expect(data.activeRunId).toBe("run-history-active");
      expect(data.activeConversationId).toBe("side");
    });

    it("includes full toolResult payload (metadata + output)", async () => {
      const pid = "mech-history-toolresult";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      await runInDurableObject(stub, (instance: Process) => {
        const store = (instance as any).store;
        store.appendToolResult("call-1", "fs.read", "file contents here", false, "default", "run-history-tool");
      });

      const res = (await stub.recvFrame(
        makeReq("proc.history", {}),
      )) as ResponseOkFrame;

      expect(res.ok).toBe(true);
      const data = res.data as any;
      expect(data.ok).toBe(true);
      expect(data.messages).toHaveLength(1);
      expect(data.messages[0].role).toBe("toolResult");
      expect(data.messages[0].runId).toBe("run-history-tool");
      expect(data.messages[0].content).toEqual({
        toolName: "Read",
        isError: false,
        toolCallId: "call-1",
        output: "file contents here",
      });
    });

    it("includes assistant thinking blocks when present", async () => {
      const pid = "mech-history-thinking";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      await runInDurableObject(stub, (instance: Process) => {
        const store = (instance as any).store;
        store.appendMessage("assistant", "Let me inspect that.", {
          runId: "run-history-thinking",
          toolCalls: JSON.stringify({
            thinking: [
              { type: "thinking", thinking: "Need to inspect config before answering." },
            ],
            toolCalls: [
              { type: "toolCall", id: "call-1", name: "Read", arguments: { path: "package.json" } },
            ],
          }),
        });
      });

      const res = (await stub.recvFrame(
        makeReq("proc.history", {}),
      )) as ResponseOkFrame;

      expect(res.ok).toBe(true);
      const data = res.data as any;
      expect(data.messages).toHaveLength(1);
      expect(data.messages[0].role).toBe("assistant");
      expect(data.messages[0].runId).toBe("run-history-thinking");
      expect(data.messages[0].content).toEqual({
        text: "Let me inspect that.",
        thinking: [
          { type: "thinking", thinking: "Need to inspect config before answering." },
        ],
        toolCalls: [
          { type: "toolCall", id: "call-1", name: "Read", arguments: { path: "package.json" } },
        ],
      });
    });
  });

  describe("CodeMode tool calls", () => {
    it("runs codemode from the native shell command", async () => {
      const pid = "mech-codemode-shell";
      await initProcess(pid, ROOT_IDENTITY);
      const kernel = await getKernelPtr();

      const response = await runInDurableObject(kernel, (instance: Kernel) =>
        instance.recvFrame(pid, makeReq("shell.exec", {
          input: "codemode -e 'return { argv, args };' --json --arg mode=check -- alpha",
        })),
      ) as ResponseOkFrame;

      expect(response.ok).toBe(true);
      const data = response.data as any;
      expect(data.status, JSON.stringify(data, null, 2)).toBe("completed");
      expect(data.exitCode).toBe(0);
      expect(JSON.parse(data.stdout)).toEqual({
        status: "completed",
        result: {
          argv: ["alpha"],
          args: { mode: "check" },
        },
      });
    });

    it("runs codemode script files from the native shell command", async () => {
      const pid = "mech-codemode-shell-file";
      await initProcess(pid, ROOT_IDENTITY);
      const kernel = await getKernelPtr();

      const response = await runInDurableObject(kernel, (instance: Kernel) =>
        instance.recvFrame(pid, makeReq("shell.exec", {
          input: [
            "echo '{\"ok\":true}' > test.json",
            "cat > test.js <<'EOF'",
            "const res = await shell(\"pwd\");",
            "const file = await fs.read({ path: \"test.json\" });",
            "return { res, file, argv, args};",
            "EOF",
            "codemode run test.js --json --arg mode=file -- beta",
          ].join("\n"),
        })),
      ) as ResponseOkFrame;

      expect(response.ok).toBe(true);
      const data = response.data as any;
      expect(data.status, JSON.stringify(data, null, 2)).toBe("completed");
      expect(data.exitCode).toBe(0);
      const result = JSON.parse(data.stdout);
      expect(result.status).toBe("completed");
      expect(result.result.argv).toEqual(["beta"]);
      expect(result.result.args).toEqual({ mode: "file" });
      expect(result.result.res.output).toContain("/root");
      expect(result.result.file.content).toContain("\"ok\":true");
    });

    it("lets process-local codemode read its own /proc conversation view", async () => {
      const pid = "mech-codemode-self-proc-view";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      await runInDurableObject(stub, (instance: Process) => {
        const store = (instance as any).store;
        store.appendMessage("user", "hello from history");
        store.appendMessage("assistant", "hello back");
      });

      const res = (await stub.recvFrame(
        makeReq("codemode.run", {
          code: [
            "const file = await fs.read({ target: \"gsv\", path: \"/proc/self/conversations/default/history\" });",
            "if (!file.ok) throw new Error(file.error);",
            "return file.content;",
          ].join("\n"),
        }),
      )) as ResponseOkFrame;

      expect(res.ok).toBe(true);
      const data = res.data as any;
      expect(data.status, JSON.stringify(data, null, 2)).toBe("completed");
      expect(data.result).toContain("\"role\":\"user\"");
      expect(data.result).toContain("hello from history");
      expect(data.result).toContain("\"role\":\"assistant\"");
      expect(data.result).toContain("hello back");
    });

    it("returns failed json for malformed codemode eval source", async () => {
      const pid = "mech-codemode-shell-syntax-error";
      await initProcess(pid, ROOT_IDENTITY);
      const kernel = await getKernelPtr();

      const response = await runInDurableObject(kernel, (instance: Kernel) =>
        instance.recvFrame(pid, makeReq("shell.exec", {
          input: "codemode -e 'const res = await shell(\"pwd);' --json",
        })),
      ) as ResponseOkFrame;

      expect(response.ok).toBe(true);
      const data = response.data as any;
      expect(data.status, JSON.stringify(data, null, 2)).toBe("failed");
      expect(data.exitCode).toBe(1);
      const result = JSON.parse(data.stdout);
      expect(result.status).toBe("failed");
      expect(result.error).toContain("SyntaxError");
      expect(result.error).toContain("Invalid or unexpected token");
    });

    it("runs codemode.run as a process command", async () => {
      const pid = "mech-codemode-run";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      const res = (await stub.recvFrame(
        makeReq("codemode.run", {
          code: "return { argv, args };",
          argv: ["alpha"],
          args: { mode: "manual" },
        }),
      )) as ResponseOkFrame;

      expect(res.ok).toBe(true);
      expect(res.data).toEqual({
        status: "completed",
        result: {
          argv: ["alpha"],
          args: { mode: "manual" },
        },
      });
    });

    it("gates CodeMode fetches through tool approval", async () => {
      const pid = "mech-codemode-fetch-approval";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        const approvals: Array<{ call: string; args: Record<string, unknown> }> = [];
        let performedFetch = false;

        process.currentRun = {
          runId: "run-codemode-fetch-approval",
          queued: false,
          conversationId: "default",
          approvalPolicy: {
            default: "auto",
            rules: [{ match: "net.fetch", action: "ask" }],
          },
        };
        process.waitForCodeModeApproval = async (
          _runId: string,
          _toolCallId: string,
          _toolName: string,
          call: string,
          args: Record<string, unknown>,
        ) => {
          approvals.push({ call, args });
          return false;
        };
        process.performCodeModeFetch = async () => {
          performedFetch = true;
          return { status: 200 };
        };

        await expect(process.executeCodeModeFetch(
          "run-codemode-fetch-approval",
          {
            url: "https://example.com/upload",
            method: "POST",
            headers: [],
            bodyBase64: btoa("secret"),
          },
          process.currentRun.approvalPolicy,
          "default",
        )).rejects.toThrow("Tool execution was not approved: net.fetch");

        expect(approvals).toEqual([
          {
            call: "net.fetch",
            args: {
              url: "https://example.com/upload",
              method: "POST",
              headers: [],
              bodyBase64: btoa("secret"),
            },
          },
        ]);
        expect(performedFetch).toBe(false);
      });
    });

    it("rejects CodeMode fetches without net.fetch capability", async () => {
      const pid = "mech-codemode-fetch-capability";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        let requestedApproval = false;
        let performedFetch = false;

        process.currentRun = {
          runId: "run-codemode-fetch-capability",
          queued: false,
          conversationId: "default",
          config: { capabilities: ["codemode.*"] },
          approvalPolicy: {
            default: "auto",
            rules: [],
          },
        };
        process.waitForCodeModeApproval = async () => {
          requestedApproval = true;
          return true;
        };
        process.performCodeModeFetch = async () => {
          performedFetch = true;
          return { status: 200 };
        };

        await expect(process.executeCodeModeFetch(
          "run-codemode-fetch-capability",
          {
            url: "https://example.com/",
            method: "GET",
            headers: [],
          },
          process.currentRun.approvalPolicy,
          "default",
        )).rejects.toThrow("Permission denied: net.fetch");

        expect(requestedApproval).toBe(false);
        expect(performedFetch).toBe(false);
      });
    });

    it("does not emit CodeMode fetch results after the run stops", async () => {
      const pid = "mech-codemode-fetch-stopped-after-fetch";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        const signals: Array<{ type: string; payload: Record<string, unknown> }> = [];
        let stopChecks = 0;

        process.currentRun = {
          runId: "run-codemode-fetch-stopped-after-fetch",
          queued: false,
          conversationId: "default",
          config: { capabilities: ["codemode.*", "net.fetch"] },
          approvalPolicy: {
            default: "auto",
            rules: [],
          },
        };
        process.sendSignal = async (type: string, payload: Record<string, unknown>) => {
          signals.push({ type, payload });
        };
        process.handleRunStopped = async () => {
          stopChecks += 1;
          return stopChecks >= 3;
        };
        process.performCodeModeFetch = async () => ({ status: 200 });

        await expect(process.executeCodeModeFetch(
          "run-codemode-fetch-stopped-after-fetch",
          {
            url: "https://example.com/",
            method: "GET",
            headers: [],
          },
          process.currentRun.approvalPolicy,
          "default",
        )).rejects.toThrow("Run stopped before CodeMode fetch completed");

        expect(signals.map((signal) => signal.type)).toEqual(["proc.run.tool.started"]);
      });
    });

    it("rejects codemode.run fetches without net.fetch capability", async () => {
      const pid = "mech-codemode-run-fetch-capability";
      const identity: ProcessIdentity = {
        uid: 3000,
        gid: 3000,
        gids: [3000],
        username: "limited",
        home: "/home/limited",
        cwd: "/home/limited",
      };
      const stub = await initProcess(pid, identity);
      const kernel = await getKernelPtr();
      await runInDurableObject(kernel, (instance: Kernel) => {
        const k = instance as any;
        k.caps.grant(3000, "codemode.run");
      });

      await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        let performedFetch = false;
        process.performCodeModeFetch = async () => {
          performedFetch = true;
          return { status: 200 };
        };

        const result = await process.handleCodeModeRun({
          code: "const response = await fetch('https://example.com/'); return response.status;",
        });

        expect(result).toMatchObject({
          status: "failed",
          error: expect.stringContaining("Permission denied: net.fetch"),
        });
        expect(performedFetch).toBe(false);
      });
    });

    it("dispatches CodeMode through the process-local executor path", async () => {
      const pid = "mech-codemode-basic";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;

        process.currentRun = {
          runId: "run-codemode-basic",
          queued: false,
          approvalPolicy: { default: "auto", rules: [] },
        };
        process.sendSignal = async () => {};
        process.executeCodeModeTool = async (
          runId: string,
          toolCallId: string,
          args: { code: string },
        ) => {
          expect(runId).toBe("run-codemode-basic");
          expect(toolCallId).toBe("call-codemode-1");
          expect(args.code).toContain("fs.read");
          process.store.register(toolCallId, runId, "codemode.exec", args);
          process.store.resolve(toolCallId, {
            status: "completed",
            result: "from codemode",
          });
        };

        await process.processToolCalls("run-codemode-basic", [
          {
            type: "toolCall",
            id: "call-codemode-1",
            name: "CodeMode",
            arguments: {
              code: `
                const file = await fs.read({ target: "gsv", path: "/tmp/example.txt" });
                return file.content;
              `,
            },
          },
        ]);

        expect(process.store.getResults("run-codemode-basic")).toEqual([
          expect.objectContaining({
            id: "call-codemode-1",
            call: "codemode.exec",
            status: "completed",
            result: {
              status: "completed",
              result: "from codemode",
            },
          }),
        ]);
      });
    });
  });

  describe("proc.reset", () => {
    it("archives all conversations and clears process history", async () => {
      const pid = "mech-reset-1";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      await runInDurableObject(stub, (instance: Process) => {
        const store = (instance as any).store;
        store.appendMessage("user", "hello");
        store.appendMessage("assistant", "hi");
        store.openConversation({ conversationId: "side", title: "Side" });
        store.appendMessage("user", "side hello", { conversationId: "side" });
      });

      const res = (await stub.recvFrame(
        makeReq("proc.reset", {}),
      )) as ResponseOkFrame;

      const data = res.data as any;
      expect(data.ok).toBe(true);
      expect(data.archivedMessages).toBe(3);
      expect(data.archivedTo).toContain("/root/conversations/");
      expect(data.archivedTo).toMatch(/\/$/);
      expect(data.archives).toEqual([
        expect.objectContaining({
          conversationId: "default",
          generation: 1,
          messages: 2,
          path: expect.stringMatching(/\/default\/.+\.default\.gen-1\.jsonl\.gz$/),
        }),
        expect.objectContaining({
          conversationId: "side",
          generation: 1,
          messages: 1,
          path: expect.stringMatching(/\/side\/.+\.side\.gen-1\.jsonl\.gz$/),
        }),
      ]);

      await runInDurableObject(stub, (instance: Process) => {
        const store = (instance as any).store;
        expect(store.messageCount()).toBe(0);
        expect(store.messageCount("side")).toBe(0);
        expect(store.getConversation("default").generation).toBe(2);
        expect(store.getConversation("side")).toMatchObject({
          generation: 2,
          status: "open",
          title: "Side",
        });
      });

      for (const archive of data.archives) {
        const archiveKey = archive.path.replace(/^\//, "");
        const obj = await env.STORAGE.get(archiveKey);
        expect(obj).not.toBeNull();
      }

      const manifestRes = (await stub.recvFrame(
        makeReq("proc.conversation.generation.manifest", {
          conversationId: "default",
          generation: 1,
        }),
      )) as ResponseOkFrame;
      expect((manifestRes.data as any).manifest).toMatchObject({
        conversationId: "default",
        generation: 1,
        current: false,
        archives: [
          expect.objectContaining({
            kind: "process-reset",
            messages: 2,
            archivePath: expect.stringMatching(/\/default\/.+\.default\.gen-1\.jsonl\.gz$/),
          }),
        ],
        live: null,
      });
    });

    it("returns zero when no messages to archive", async () => {
      const pid = "mech-reset-empty";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      const res = (await stub.recvFrame(
        makeReq("proc.reset", {}),
      )) as ResponseOkFrame;

      const data = res.data as any;
      expect(data.ok).toBe(true);
      expect(data.archivedMessages).toBe(0);
      expect(data.archivedTo).toBeUndefined();
      expect(data.archives).toEqual([]);
    });

    it("clears active run state and queued messages", async () => {
      const pid = "mech-reset-runtime";
      const stub = await initProcess(pid, ROOT_IDENTITY);
      const runId = "run-reset-runtime";

      await runInDurableObject(stub, (instance: Process) => {
        const store = (instance as any).store;
        store.setValue("currentRun", JSON.stringify({ runId, queued: false }));
        store.register("call-reset-1", runId, "fs.read", { path: "/tmp/test.txt" });
        store.enqueue(runId, "queued after reset");
        store.appendMessage("user", "hello before reset");
      });

      const resetRes = (await stub.recvFrame(
        makeReq("proc.reset", {}),
      )) as ResponseOkFrame;
      expect(resetRes.ok).toBe(true);

      await runInDurableObject(stub, (instance: Process) => {
        const store = (instance as any).store;
        expect(store.getValue("currentRun")).toBeNull();
        expect(store.queueSize()).toBe(0);
        expect(store.getResults(runId)).toHaveLength(0);
      });

      const sendRes = (await stub.recvFrame(
        makeReq("proc.send", { message: "first after reset" }),
      )) as ResponseOkFrame;
      const sendData = sendRes.data as { queued?: boolean };
      expect(sendData.queued).toBeUndefined();
    });
  });

  describe("proc.kill", () => {
    it("clears conversation and runtime state so next send is not queued", async () => {
      const pid = "mech-kill-runtime";
      const stub = await initProcess(pid, ROOT_IDENTITY);
      const runId = "run-kill-runtime";

      await runInDurableObject(stub, (instance: Process) => {
        const store = (instance as any).store;
        store.setValue("currentRun", JSON.stringify({ runId, queued: false }));
        store.register("call-kill-1", runId, "fs.read", { path: "/tmp/test.txt" });
        store.enqueue(runId, "queued before kill");
        store.appendMessage("user", "hello before kill");
      });

      const killRes = (await stub.recvFrame(
        makeReq("proc.kill", { archive: false }),
      )) as ResponseOkFrame;
      expect(killRes.ok).toBe(true);
      expect(killRes.data).toMatchObject({
        ok: true,
        pid,
        archivedMessages: 0,
        archives: [],
      });

      // Kill wipes the executor entirely (the DO is fungible): no leftover run,
      // queue, results, identity, or messages remain.
      await runInDurableObject(stub, (instance: Process) => {
        const store = (instance as any).store;
        expect(store.getValue("currentRun")).toBeNull();
        expect(store.queueSize()).toBe(0);
        expect(store.getResults(runId)).toHaveLength(0);
        expect(store.messageCount()).toBe(0);
        expect(store.getValue("identity")).toBeNull();
      });

      // A fresh executor is established (as the kernel would on resume), then a
      // send starts cleanly rather than being queued behind stale runtime state.
      await stub.recvFrame(
        makeReq("proc.setidentity", { pid, identity: ROOT_IDENTITY, profile: DEFAULT_PROFILE }),
      );
      const sendRes = (await stub.recvFrame(
        makeReq("proc.send", { message: "first after kill" }),
      )) as ResponseOkFrame;
      const sendData = sendRes.data as { queued?: boolean };
      expect(sendData.queued).toBeUndefined();
    });

    it("archives all conversations before clearing killed process history", async () => {
      const pid = "mech-kill-archive-all";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      await runInDurableObject(stub, (instance: Process) => {
        const store = (instance as any).store;
        store.appendMessage("user", "default before kill");
        store.openConversation({ conversationId: "build" });
        store.appendMessage("user", "build before kill", { conversationId: "build" });
      });

      const killRes = (await stub.recvFrame(
        makeReq("proc.kill", {}),
      )) as ResponseOkFrame;
      const data = killRes.data as any;

      expect(data).toMatchObject({
        ok: true,
        pid,
        archivedMessages: 2,
      });
      expect(data.archivedTo).toMatch(/\/root\/conversations\/$/);
      expect(data.archives.map((archive: any) => archive.conversationId)).toEqual([
        "build",
        "default",
      ]);

      for (const archive of data.archives) {
        const archiveKey = archive.path.replace(/^\//, "");
        const obj = await env.STORAGE.get(archiveKey);
        expect(obj).not.toBeNull();
      }

      // Kill wipes the executor: the DO storage is pristine afterwards (the
      // durable transcript bytes live in the agent home, checked above). The
      // default conversation is freshly re-initialised and the ad-hoc "build"
      // conversation no longer exists in the wiped executor.
      await runInDurableObject(stub, (instance: Process) => {
        const store = (instance as any).store;
        expect(store.totalMessageCount()).toBe(0);
        expect(store.getConversation("default").generation).toBe(1);
        expect(store.getConversation("build")).toBeNull();
      });
    });
  });

  describe("unknown command", () => {
    it("returns error for unknown call", async () => {
      const pid = "mech-unknown";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      const res = (await stub.recvFrame(
        makeReq("proc.bogus", {}),
      )) as ResponseFrame;

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.message).toContain("Unknown process command");
      }
    });
  });

  describe("identity.changed signal", () => {
    it("updates stored identity on signal", async () => {
      const pid = "mech-sig-identity";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      const newIdentity: ProcessIdentity = {
        uid: 0,
        gid: 0,
        gids: [0, 42],
        username: "root",
        home: "/root",
        cwd: "/root",
      };

      await stub.recvFrame({
        type: "sig",
        signal: "identity.changed",
        payload: { identity: newIdentity },
      } as any);

      await runInDurableObject(stub, (instance: Process) => {
        expect(instance.identity.gids).toEqual([0, 42]);
      });
    });
  });

  describe("response handling", () => {
    it("ignores response for unknown tool call", async () => {
      const pid = "mech-res-unknown";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      await stub.recvFrame({
        type: "res",
        id: "nonexistent-call-id",
        ok: true,
        data: { content: "hello" },
      } as any);
    });

    it("does not continue the run until all tool calls in a batch are dispatched", async () => {
      const pid = "mech-res-multi-tool-batch";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        const continuedRunIds: string[] = [];

        process.currentRun = {
          runId: "run-multi-tool-batch",
          queued: false,
          approvalPolicy: { default: "auto", rules: [] },
        };

        process.sendSignal = async () => {};
        process.continueAgentLoop = async (runId: string) => {
          continuedRunIds.push(runId);
        };
        process.dispatchSyscall = async (
          dispatchRunId: string,
          id: string,
          call: string,
          args: unknown,
        ) => {
          process.store.register(id, dispatchRunId, call, args);

          if (id === "call-1") {
            await process.handleRes({
              type: "res",
              id,
              ok: true,
              data: { path: "/tmp/one.txt", content: "first" },
            });
          }
        };

        await process.processToolCalls("run-multi-tool-batch", [
          { type: "toolCall", id: "call-1", name: "Read", arguments: { path: "/tmp/one.txt" } },
          { type: "toolCall", id: "call-2", name: "Read", arguments: { path: "/tmp/two.txt" } },
        ]);

        expect(continuedRunIds).toEqual([]);
        expect(process.store.getResults("run-multi-tool-batch")).toEqual([
          expect.objectContaining({
            id: "call-1",
            status: "completed",
          }),
          expect.objectContaining({
            id: "call-2",
            status: "pending",
          }),
        ]);

        await process.handleRes({
          type: "res",
          id: "call-2",
          ok: true,
          data: { path: "/tmp/two.txt", content: "second" },
        });

        expect(continuedRunIds).toEqual(["run-multi-tool-batch"]);
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Tier 2: Real LLM tests (gated on API key)
// ---------------------------------------------------------------------------

declare const __GSV_TEST_OPENAI_KEY__: string;
const OPENAI_KEY = __GSV_TEST_OPENAI_KEY__ || undefined;

const describeIf = (condition: unknown) =>
  condition ? describe : describe.skip;

describeIf(OPENAI_KEY)("Process DO — agent loop (real LLM)", () => {
  beforeAll(async () => {
    const kernel = await getKernelPtr();
    await runInDurableObject(kernel, (instance: Kernel) => {
      const k = instance as any;
      k.caps.seed();
      k.config.set("config/ai/api_key", OPENAI_KEY);
      k.config.set("config/ai/provider", "openai");
      k.config.set("config/ai/model", "gpt-4o-mini");
      k.config.set("config/ai/max_tokens", "1024");
    });
  });

  afterEach(async () => {
    const kernel = await getKernelPtr();
    await runInDurableObject(kernel, (instance: Kernel) => {
      const k = instance as any;
      k.config.delete("config/ai/tools/approval");
      k.config.delete("users/0/ai/api_key");
    });
  });

  it("simple text response: send → alarm → text + complete", async () => {
    const pid = "llm-simple-1";
    await registerInKernel(pid, ROOT_IDENTITY);
    const stub = await initProcess(pid, ROOT_IDENTITY, { register: false });

    const sendRes = (await stub.recvFrame(
      makeReq("proc.send", { message: "Respond with exactly the word 'pong'. Nothing else." }),
    )) as ResponseOkFrame;
    expect(sendRes.ok).toBe(true);

    await runDurableObjectAlarm(stub);
    await waitForRunComplete(stub, 25_000);

    await runInDurableObject(stub, (instance: Process) => {
      const store = (instance as any).store;
      expect(store.getValue("currentRun")).toBeNull();
      expect(store.messageCount()).toBeGreaterThanOrEqual(2);
      const msgs = store.getMessages();
      if (skipTransientProviderFailure(msgs)) return;
      expect(msgs[0].role).toBe("user");
      expect(visibleAssistantText(msgs).toLowerCase()).toContain("pong");
    });
  }, 30_000);

  it("tool call loop: read file → text response", async () => {
    const pid = "llm-tool-1";
    await registerInKernel(pid, ROOT_IDENTITY);
    const stub = await initProcess(pid, ROOT_IDENTITY, { register: false });

    await env.STORAGE.put("root/test-file.txt", "The secret word is: banana", {
      customMetadata: { uid: "0", gid: "0", mode: "644" },
    });

    const sendRes = (await stub.recvFrame(
      makeReq("proc.send", {
        message: "Read the file ~/test-file.txt and tell me the secret word. Only respond with the secret word, nothing else.",
      }),
    )) as ResponseOkFrame;
    expect(sendRes.ok).toBe(true);

    // Tick through the agent loop — LLM calls Read, gets result, responds
    let maxTicks = 5;
    while (maxTicks-- > 0) {
      await runDurableObjectAlarm(stub);
      const done = await runInDurableObject(stub, (instance: Process) => {
        return (instance as any).store.getValue("currentRun") === null;
      });
      if (done) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    await waitForRunComplete(stub, 50_000);

    await runInDurableObject(stub, (instance: Process) => {
      const store = (instance as any).store;
      expect(store.getValue("currentRun")).toBeNull();

      const msgs = store.getMessages();
      if (skipTransientProviderFailure(msgs)) return;
      expect(msgs.length).toBeGreaterThanOrEqual(4);

      const toolResultMsg = msgs.find((m: any) => m.role === "toolResult");
      expect(toolResultMsg).toBeDefined();

      expect(visibleAssistantText(msgs).toLowerCase()).toContain("banana");
    });
  }, 60_000);

  it("message queue injection at tool-result boundary", async () => {
    const pid = "llm-queue-1";
    await registerInKernel(pid, ROOT_IDENTITY);
    const stub = await initProcess(pid, ROOT_IDENTITY, { register: false });

    await env.STORAGE.put("root/queue-test.txt", "file-content-alpha", {
      customMetadata: { uid: "0", gid: "0", mode: "644" },
    });

    const res1 = (await stub.recvFrame(
      makeReq("proc.send", {
        message: "Read ~/queue-test.txt and tell me what it says.",
      }),
    )) as ResponseOkFrame;
    expect(res1.ok).toBe(true);

    const res2 = (await stub.recvFrame(
      makeReq("proc.send", { message: "Also, what is 1 + 1?" }),
    )) as ResponseOkFrame;
    expect((res2.data as any).queued).toBe(true);

    let maxTicks = 10;
    while (maxTicks-- > 0) {
      await runDurableObjectAlarm(stub);
      const done = await runInDurableObject(stub, (instance: Process) => {
        return (instance as any).store.getValue("currentRun") === null
          && (instance as any).store.queueSize() === 0;
      });
      if (done) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    await waitForRunComplete(stub, 50_000);

    await runInDurableObject(stub, (instance: Process) => {
      const store = (instance as any).store;
      const msgs = store.getMessages();
      if (skipTransientProviderFailure(msgs)) return;
      expect(store.queueSize()).toBe(0);
      const userMsgs = msgs.filter((m: any) => m.role === "user");
      expect(userMsgs.length).toBeGreaterThanOrEqual(2);
      const queuedMsg = userMsgs.find((m: any) =>
        m.content.includes("1 + 1"),
      );
      expect(queuedMsg).toBeDefined();
      expect(queuedMsg.runId).toBe((res1.data as any).runId);
      expect(queuedMsg.runId).not.toBe((res2.data as any).runId);
    });
  }, 60_000);

  it("tool confirmation approve path: pauses for approval, then reads and completes", async () => {
    const pid = "llm-hil-approve-1";
    await registerInKernel(pid, ROOT_IDENTITY);
    const stub = await initProcess(pid, ROOT_IDENTITY, { register: false });

    await env.STORAGE.put("root/hil-approve.txt", "banana", {
      customMetadata: { uid: "0", gid: "0", mode: "644" },
    });

    const kernel = await getKernelPtr();
    await runInDurableObject(kernel, (instance: Kernel) => {
      const k = instance as any;
      k.config.set("config/ai/tools/approval", JSON.stringify({
        default: "auto",
        rules: [{ match: "fs.read", action: "ask" }],
      }));
    });

    const sendRes = (await stub.recvFrame(
      makeReq("proc.send", {
        message: "Read ~/hil-approve.txt and reply with exactly the word banana.",
      }),
    )) as ResponseOkFrame;
    expect(sendRes.ok).toBe(true);

    await runDurableObjectAlarm(stub);

    let pendingHil: any = null;
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      const history = (await stub.recvFrame(
        makeReq("proc.history", {}),
      )) as ResponseOkFrame;
      pendingHil = (history.data as any).pendingHil;
      if (pendingHil) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    if (!pendingHil) {
      const history = (await stub.recvFrame(
        makeReq("proc.history", {}),
      )) as ResponseOkFrame;
      if (skipTransientProviderFailure((history.data as any).messages ?? [])) return;
    }

    expect(pendingHil).toMatchObject({
      syscall: "fs.read",
      args: { target: "gsv" },
    });
    expect(["~/hil-approve.txt", "/root/hil-approve.txt"]).toContain(pendingHil.args.path);

    const hilRes = (await stub.recvFrame(
      makeReq("proc.hil", { requestId: pendingHil.requestId, decision: "approve" }),
    )) as ResponseOkFrame;
    expect(hilRes.ok).toBe(true);
    expect(hilRes.data).toMatchObject({
      ok: true,
      pid,
      requestId: pendingHil.requestId,
      decision: "approve",
      resumed: true,
      pendingHil: null,
    });

    let maxTicks = 5;
    while (maxTicks-- > 0) {
      await runDurableObjectAlarm(stub);
      const done = await runInDurableObject(stub, (instance: Process) => {
        return (instance as any).store.getValue("currentRun") === null;
      });
      if (done) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    await waitForRunComplete(stub, 50_000);

    await runInDurableObject(stub, (instance: Process) => {
      const store = (instance as any).store;
      const messages = store.getMessages();
      if (skipTransientProviderFailure(messages)) return;
      const toolResultMsg = messages.find((m: any) => m.role === "toolResult");
      expect(store.getPendingHil()).toBeNull();
      expect(toolResultMsg).toBeDefined();
      expect(visibleAssistantText(messages).toLowerCase()).toContain("banana");
    });
  }, 60_000);

  it("tool confirmation deny path: pauses for approval, then continues with denial", async () => {
    const pid = "llm-hil-deny-1";
    await registerInKernel(pid, ROOT_IDENTITY);
    const stub = await initProcess(pid, ROOT_IDENTITY, { register: false });

    await env.STORAGE.put("root/hil-deny.txt", "secret-value", {
      customMetadata: { uid: "0", gid: "0", mode: "644" },
    });

    const kernel = await getKernelPtr();
    await runInDurableObject(kernel, (instance: Kernel) => {
      const k = instance as any;
      k.config.set("config/ai/tools/approval", JSON.stringify({
        default: "auto",
        rules: [{ match: "fs.read", action: "ask" }],
      }));
    });

    const sendRes = (await stub.recvFrame(
      makeReq("proc.send", {
        message: "Read ~/hil-deny.txt. If the read tool is denied, reply with exactly the single word denied.",
      }),
    )) as ResponseOkFrame;
    expect(sendRes.ok).toBe(true);

    await runDurableObjectAlarm(stub);

    let pendingHil: any = null;
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      const history = (await stub.recvFrame(
        makeReq("proc.history", {}),
      )) as ResponseOkFrame;
      pendingHil = (history.data as any).pendingHil;
      if (pendingHil) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    if (!pendingHil) {
      const history = (await stub.recvFrame(
        makeReq("proc.history", {}),
      )) as ResponseOkFrame;
      if (skipTransientProviderFailure((history.data as any).messages ?? [])) return;
    }

    expect(pendingHil).toMatchObject({
      syscall: "fs.read",
    });

    const hilRes = (await stub.recvFrame(
      makeReq("proc.hil", { requestId: pendingHil.requestId, decision: "deny" }),
    )) as ResponseOkFrame;
    expect(hilRes.ok).toBe(true);
    expect(hilRes.data).toMatchObject({
      ok: true,
      pid,
      requestId: pendingHil.requestId,
      decision: "deny",
      resumed: true,
      pendingHil: null,
    });

    let maxTicks = 5;
    while (maxTicks-- > 0) {
      await runDurableObjectAlarm(stub);
      const done = await runInDurableObject(stub, (instance: Process) => {
        return (instance as any).store.getValue("currentRun") === null;
      });
      if (done) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    await waitForRunComplete(stub, 50_000);

    await runInDurableObject(stub, (instance: Process) => {
      const store = (instance as any).store;
      const messages = store.getMessages();
      if (skipTransientProviderFailure(messages)) return;
      const toolResults = messages.filter((m: any) => m.role === "toolResult");
      expect(store.getPendingHil()).toBeNull();
      expect(toolResults.length).toBeGreaterThanOrEqual(1);
      expect(toolResults[toolResults.length - 1].content).toContain("Tool execution denied by user");
      expect(visibleAssistantText(messages).toLowerCase()).toContain("denied");
    });
  }, 60_000);

  it("handles invalid API key gracefully", async () => {
    const pid = "llm-error-1";

    const kernel = await getKernelPtr();
    await runInDurableObject(kernel, (instance: Kernel) => {
      const k = instance as any;
      k.procs.spawn(pid, ROOT_IDENTITY, { profile: DEFAULT_PROFILE });
      k.config.set("users/0/ai/api_key", "sk-invalid-key-for-testing");
    });

    const stub = await initProcess(pid, ROOT_IDENTITY, { register: false });

    const sendRes = (await stub.recvFrame(
      makeReq("proc.send", { message: "Hello" }),
    )) as ResponseOkFrame;
    expect(sendRes.ok).toBe(true);

    await runDurableObjectAlarm(stub);
    await waitForRunComplete(stub, 25_000);

    await runInDurableObject(stub, (instance: Process) => {
      const store = (instance as any).store;
      expect(store.getValue("currentRun")).toBeNull();
    });

    await runInDurableObject(kernel, (instance: Kernel) => {
      const k = instance as any;
      k.config.delete("users/0/ai/api_key");
    });
  }, 30_000);
});
