import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { Process } from "./do";
import { Kernel } from "../kernel/do";
import {
  bodyFromBytes,
  bodyFromText,
  bodyToBytes,
  bodyToText,
  REQUEST_CANCEL_SIGNAL,
  type ProcessIdentity,
} from "@humansandmachines/gsv/protocol";
import type { RequestFrame, ResponseFrame, ResponseOkFrame } from "../protocol/frames";
import type {
  ProcessAdapterDeliverArgs,
  ProcessAdapterDeliverRequestFrame,
  ProcessRunAttachRequestFrame,
  ProcessScheduleDeliverArgs,
  ProcessScheduleDeliverRequestFrame,
} from "../protocol/process-frames";
import { getProcessByPid, getKernelPtr } from "../shared/utils";
import { TOOL_TO_SYSCALL } from "../syscalls/constants";
import { PROCESS_V001_INITIAL_SCHEMA } from "./schema/v001_initial";
import { PROCESS_V004_PENDING_TOOL_DISPATCH_ID } from "./schema/v004_pending_tool_dispatch_id";
import { PROCESS_V005_TOOL_RESULT_OUTCOME } from "./schema/v005_tool_result_outcome";
import { PROCESS_V006_PENDING_HIL_OWNER } from "./schema/v006_pending_hil_owner";

const ROOT_IDENTITY: ProcessIdentity = {
  uid: 0,
  gid: 0,
  gids: [0],
  username: "root",
  home: "/root",
  cwd: "/root",
};
const DEFAULT_PROFILE = "task" as const;

function makeReq(call: string, args: unknown): RequestFrame {
  return { type: "req", id: crypto.randomUUID(), call, args } as RequestFrame;
}

function makeScheduleDeliverReq(
  args: Omit<ProcessScheduleDeliverArgs, "runId" | "firedAtMs"> & {
    runId?: string;
    firedAtMs?: number;
  },
): ProcessScheduleDeliverRequestFrame {
  return {
    type: "req",
    id: crypto.randomUUID(),
    call: "proc.schedule.deliver",
    args: {
      ...args,
      runId: args.runId ?? crypto.randomUUID(),
      firedAtMs: args.firedAtMs ?? Date.now(),
    },
  };
}

function makeAdapterDeliverReq(
  args: ProcessAdapterDeliverArgs,
): ProcessAdapterDeliverRequestFrame {
  return {
    type: "req",
    id: crypto.randomUUID(),
    call: "proc.adapter.deliver",
    args,
  };
}

function registerToolBlock(
  process: any,
  runId: string,
  toolCalls: Array<{ id: string; name: string; arguments: unknown }>,
): void {
  for (const toolCall of toolCalls) {
    const syscall = TOOL_TO_SYSCALL[toolCall.name];
    const args = syscall
      ? process.prepareToolArgs(syscall, toolCall.arguments).args
      : toolCall.arguments;
    process.store.register(
      `dispatch-${toolCall.id}`,
      toolCall.id,
      runId,
      syscall ?? toolCall.name,
      args,
      "default",
    );
  }
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

function openAiChatSseChunk(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
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

async function waitForStoredMessage(
  stub: DurableObjectStub<Process>,
  predicate: (message: any) => boolean,
  timeoutMs = 2_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const message = await runInDurableObject(stub, (instance: Process) => (
      (instance as any).store.getMessages().find(predicate)
    ));
    if (message) {
      return message;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for process message");
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
  it("records terminal adapter delivery outcomes in conversation history", async () => {
    const pid = "mech-delivery-notice";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    const notice = {
      type: "sig",
      signal: "proc.delivery.notice",
      payload: {
        noticeId: "notice:mech-delivery-notice",
        runId: "run-delivery-notice",
        conversationId: "default",
        deliveryKind: "final",
        state: "ambiguous",
        message: "The automatic reply reached the adapter, but provider delivery is ambiguous.",
      },
    } as const;
    await stub.recvFrame(notice);
    await stub.recvFrame(notice);

    await runInDurableObject(stub, (instance: Process) => {
      expect((instance as any).store.getMessages()).toEqual([
        expect.objectContaining({
          role: "system",
          runId: "run-delivery-notice",
          content: expect.stringContaining("delivery is ambiguous"),
        }),
      ]);
    });
  });

  it("bounds terminal adapter delivery notice tombstones", async () => {
    const stub = await initProcess("mech-delivery-notice-bounds", ROOT_IDENTITY);

    await runInDurableObject(stub, async (instance: Process) => {
      const process = instance as any;
      for (let index = 0; index <= 256; index += 1) {
        await process.handleSig({
          type: "sig",
          signal: "proc.delivery.notice",
          payload: {
            noticeId: `notice:bounded:${index}`,
            runId: `run-${index}`,
            conversationId: "default",
            message: `Delivery notice ${index}`,
          },
        });
      }
      expect(process.store.getValue("deliveryNotice:notice:bounded:0")).toBeNull();
      expect(process.store.getValue("deliveryNotice:notice:bounded:256")).not.toBeNull();
      expect(JSON.parse(process.store.getValue("deliveryNoticeIds"))).toHaveLength(256);
    });
  });

  it("projects proc.run signals into kernel process activity", async () => {
    const pid = "mech-kernel-process-activity";
    await registerInKernel(pid, ROOT_IDENTITY);
    const kernel = await getKernelPtr();

    const state = await runInDurableObject(kernel, async (instance: Kernel) => {
      const k = instance as any;
      const project = (frame: any) => k.updateProcessRuntimeFromSignal(
        pid,
        frame,
        frame.payload?.runId ?? null,
      );
      await project({
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

      await project({
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

      await project({
        type: "sig",
        signal: "proc.run.tool.started",
        payload: {
          pid,
          runId: "run-activity",
          conversationId: "thread",
          queuedCount: 1,
          timestamp: 1075,
        },
      });
      const waitingTool = k.procs.get(pid);

      await project({
        type: "sig",
        signal: "proc.changed",
        payload: {
          pid,
          runId: "run-activity",
          conversationId: "thread",
          changes: ["messages"],
          queuedCount: 1,
          timestamp: 1080,
        },
      });
      const resumed = k.procs.get(pid);

      await project({
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

      await project({
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

      return { running, retrying, waitingTool, resumed, waiting, idle };
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
    expect(state.waitingTool).toMatchObject({
      state: "waiting_tool",
      activeRunId: "run-activity",
      lastActiveAt: 1075,
    });
    expect(state.resumed).toMatchObject({
      state: "running",
      activeRunId: "run-activity",
      lastActiveAt: 1080,
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
      expect((patchResponse.data as any).config.profile).toMatchObject({ id: "fast", name: "Fast" });
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

      const patchResponse = await stub.recvFrame(makeReq("proc.ai.config.set", {
        key: "config/ai/reasoning",
        value: "high",
      })) as ResponseOkFrame;
      expect((patchResponse.data as any).config).toMatchObject({
        profile: { id: "fast", name: "Fast" },
        values: {
          "config/ai/reasoning": "high",
        },
      });

      const clearFieldResponse = await stub.recvFrame(makeReq("proc.ai.config.set", {
        key: "config/ai/reasoning",
        value: "",
      })) as ResponseOkFrame;
      expect((clearFieldResponse.data as any).config).toMatchObject({
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

        const request = makeScheduleDeliverReq({
          scheduleId: "sched-1",
          scheduleName: "nightly",
          message: "run the nightly check",
          scheduledAtMs: 1_000,
          firedAtMs: 2_000,
        });
        const response = await instance.recvFrame(request);
        expect(response).toMatchObject({ type: "res", id: request.id, ok: true });

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

    it("reconciles duplicate scheduled runs while active and after they are recorded", async () => {
      const stub = await initProcess("mech-schedule-idempotent-recorded", ROOT_IDENTITY);
      const args = {
        runId: "run-schedule-idempotent-recorded",
        scheduleId: "sched-idempotent-recorded",
        message: "run this scheduled check once",
      };

      const firstRequest = makeScheduleDeliverReq(args);
      const first = await stub.recvFrame(firstRequest);
      const activeRepeatRequest = makeScheduleDeliverReq(args);
      const activeRepeat = await stub.recvFrame(activeRepeatRequest);
      const activeState = await runInDurableObject(stub, (instance: Process) => {
        const process = instance as any;
        return {
          messages: process.store.getMessages(),
          queueSize: process.store.queueSize(),
          currentRunId: process.currentRun?.runId ?? null,
        };
      });

      await runInDurableObject(stub, (instance: Process) => {
        (instance as any).currentRun = null;
      });
      const recordedRepeatRequest = makeScheduleDeliverReq(args);
      const recordedRepeat = await stub.recvFrame(recordedRepeatRequest);
      const recordedState = await runInDurableObject(stub, (instance: Process) => {
        const process = instance as any;
        return {
          messages: process.store.getMessages(),
          queueSize: process.store.queueSize(),
          currentRunId: process.currentRun?.runId ?? null,
        };
      });

      expect(first).toMatchObject({
        type: "res",
        id: firstRequest.id,
        ok: true,
        data: { runId: args.runId, queued: false },
      });
      expect((activeRepeat as any).data).toEqual((first as any).data);
      expect((recordedRepeat as any).data).toEqual((first as any).data);
      expect(activeState).toMatchObject({
        messages: [expect.objectContaining({ runId: args.runId })],
        queueSize: 0,
        currentRunId: args.runId,
      });
      expect(recordedState).toMatchObject({
        messages: [expect.objectContaining({ runId: args.runId })],
        queueSize: 0,
        currentRunId: null,
      });
    });

    it("reconciles duplicate queued scheduled replies", async () => {
      const stub = await initProcess("mech-schedule-idempotent-queued", ROOT_IDENTITY);
      const args = {
        runId: "run-schedule-idempotent-queued",
        scheduleId: "sched-idempotent-queued",
        message: "send this reminder once",
        replyTo: {
          kind: "adapter" as const,
          adapter: "telegram",
          accountId: "primary",
          actorId: "telegram-user-1",
          surface: { kind: "dm" as const, id: "telegram-chat-1" },
        },
      };

      await runInDurableObject(stub, (instance: Process) => {
        (instance as any).currentRun = {
          runId: "run-busy",
          conversationId: "default",
        };
      });
      const firstRequest = makeScheduleDeliverReq(args);
      const first = await stub.recvFrame(firstRequest);
      const repeatedRequest = makeScheduleDeliverReq(args);
      const repeated = await stub.recvFrame(repeatedRequest);

      expect(first).toMatchObject({
        type: "res",
        id: firstRequest.id,
        ok: true,
        data: { runId: args.runId, queued: true },
      });
      expect((repeated as any).data).toEqual((first as any).data);
      await runInDurableObject(stub, (instance: Process) => {
        const process = instance as any;
        expect(process.currentRun).toMatchObject({ runId: "run-busy" });
        expect(process.store.getMessages()).toEqual([]);
        expect(process.store.queueSize()).toBe(1);
        expect(process.store.drainQueue("default")).toEqual([
          expect.objectContaining({
            runId: args.runId,
            message: expect.stringContaining(args.message),
          }),
        ]);
      });
    });

    it("rejects scheduled runtime events for closed conversations", async () => {
      const stub = await initProcess("mech-schedule-closed", ROOT_IDENTITY);

      const result = await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        process.store.openConversation({ conversationId: "closed" });
        const releaseLifecycle = await process.acquireLifecycleTransition();
        const request = makeScheduleDeliverReq({
          scheduleId: "sched-closed",
          conversationId: "closed",
          message: "do not run",
        });
        const delivery = instance.recvFrame(request);
        await Promise.resolve();
        process.store.closeConversation("closed");
        releaseLifecycle();
        const response = await delivery;
        return {
          requestId: request.id,
          response,
          messages: process.store.getMessages({ conversationId: "closed" }),
        };
      });

      expect(result.response).toMatchObject({
        type: "res",
        id: result.requestId,
        ok: false,
        error: { message: "Conversation is closed: closed" },
      });
      expect(result.messages).toEqual([]);
    });

    it("rejects a scheduled runtime event when process teardown wins admission", async () => {
      const stub = await initProcess("mech-schedule-teardown-race", ROOT_IDENTITY);

      const result = await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        const releaseLifecycle = await process.acquireLifecycleTransition();
        const request = makeScheduleDeliverReq({
          scheduleId: "sched-teardown-race",
          message: "do not run",
        });
        const delivery = instance.recvFrame(request);
        await Promise.resolve();
        process.store.deleteValue("pid");
        process.store.deleteValue("identity");
        releaseLifecycle();
        const response = await delivery;
        return {
          requestId: request.id,
          response,
          messages: process.store.getMessages(),
        };
      });

      expect(result.response).toMatchObject({
        type: "res",
        id: result.requestId,
        ok: false,
        error: { message: "Process no longer exists" },
      });
      expect(result.messages).toEqual([]);
    });

    it("wakes a busy conversation for a scheduled runtime event", async () => {
      const stub = await initProcess("mech-schedule-busy-wake", ROOT_IDENTITY);

      await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        process.sendSignal = vi.fn(async () => {});
        process.scheduleTick = vi.fn(async () => {});
        process.currentRun = { runId: "run-busy", conversationId: "default" };

        await instance.recvFrame(makeScheduleDeliverReq({
          scheduleId: "sched-busy",
          message: "check now",
        }));
        expect(process.currentRun).toMatchObject({
          runId: "run-busy",
          pendingRuntimeEvents: 1,
        });

        await process.finishRun("run-busy", { status: "ok", text: "done" });
        expect(process.currentRun).toMatchObject({ conversationId: "default" });
        expect(process.currentRun.runId).not.toBe("run-busy");
      });
    });

    it("keeps a scheduled adapter reply as a distinct queued run and explains automatic delivery", async () => {
      const stub = await initProcess("mech-schedule-adapter-reply", ROOT_IDENTITY);

      await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        process.sendSignal = vi.fn(async () => {});
        process.scheduleTick = vi.fn(async () => {});
        process.currentRun = { runId: "run-busy", conversationId: "default" };
        process.generation = {
          async generate(request: any) {
            const prompt = request.context.systemPrompt as string;
            expect(prompt).toContain("[run.reply]");
            expect(prompt).toContain("scheduled run's final response is delivered automatically");
            expect(prompt).toContain("Telegram direct message");
            expect(prompt).toContain("`message send` creates an additional outbound message");
            expect(prompt).toContain("requires `--also`");
            expect(prompt).not.toContain("telegram-user-1");
            expect(prompt).not.toContain("telegram-chat-1");
            return {
              role: "assistant",
              content: [{ type: "text", text: "scheduled reply" }],
              api: "test",
              provider: "test",
              model: "test",
              stopReason: "stop",
              timestamp: Date.now(),
            };
          },
          async generateText() {
            return "scheduled reply";
          },
        };

        const request = makeScheduleDeliverReq({
          runId: "run-scheduled-reply",
          scheduleId: "sched-adapter-reply",
          message: "send the reminder",
          replyTo: {
            kind: "adapter",
            adapter: "telegram",
            accountId: "primary",
            actorId: "telegram-user-1",
            surface: { kind: "dm", id: "telegram-chat-1" },
          },
        });
        const response = await instance.recvFrame(request);
        expect(response).toMatchObject({
          type: "res",
          id: request.id,
          ok: true,
          data: { runId: "run-scheduled-reply", queued: true },
        });
        expect(process.currentRun).toMatchObject({ runId: "run-busy" });
        expect(process.store.queueSize("default")).toBe(1);

        process.currentRun = null;
        expect(process.claimNextQueuedRun()).toMatchObject({ runId: "run-scheduled-reply" });
        expect(process.currentRun).toMatchObject({
          runId: "run-scheduled-reply",
          origin: {
            kind: "scheduler",
            scheduleId: "sched-adapter-reply",
            replyTo: {
              kind: "adapter",
              adapter: "telegram",
              accountId: "primary",
              actorId: "telegram-user-1",
              surface: { kind: "dm", id: "telegram-chat-1" },
            },
          },
        });
        process.currentRun = {
          ...process.currentRun,
          config: {
            executor: { kind: "process", pid: process.pid },
            profile: "task",
            provider: "workers-ai",
            model: "@cf/test/model",
            apiKey: "",
            reasoning: "off",
            maxTokens: 8192,
            contextWindowTokens: 256000,
            contextWindowSource: "config",
            maxContextBytes: 32768,
          },
          tools: [],
          devices: [],
          mcpServers: [],
          systemPrompt: "Test system prompt.",
          approvalPolicy: { default: "auto", rules: [] },
        };
        await process.runTick("run-scheduled-reply");
      });
    });

    it("terminalizes a scheduled runtime event when its first tick cannot be scheduled", async () => {
      const stub = await initProcess("mech-schedule-failure", ROOT_IDENTITY);

      await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        process.sendSignal = vi.fn(async () => {});
        process.scheduleTick = vi.fn(async () => {
          throw new Error("scheduler unavailable");
        });

        await instance.recvFrame(makeScheduleDeliverReq({
          scheduleId: "sched-failure",
          message: "check now",
        }));
        await vi.waitFor(() => {
          expect(process.currentRun).toBeNull();
          expect(process.sendSignal).toHaveBeenCalledWith(
            "proc.run.finished",
            expect.objectContaining({ reason: "schedule.error", status: "error" }),
          );
        });
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
        await process.runTick("run-context-pressure");
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
            const fourth = request.context.messages[3];
            expect(first.role).toBe("user");
            expect(first.content).toContain("[From: Telegram direct message]");
            expect(first.content).not.toContain("Steve James");
            expect(first.content).toContain("hello from telegram");
            expect(second.role).toBe("user");
            expect(second.content).toContain("[From: WhatsApp group GSV Dev from @sam]");
            expect(second.content).toContain("check this from the group");
            expect(third.role).toBe("user");
            expect(third.content).toBe("same source follow-up");
            expect(fourth.role).toBe("user");
            expect(fourth.content).toContain("[From: GSV Web Desktop]");
            expect(fourth.content).toContain("now from chat");
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

        process.store.appendMessage("user", "hello from telegram", {
          origin: JSON.stringify({
            kind: "adapter",
            adapter: "telegram",
            accountId: "primary",
            surface: { kind: "dm", id: "telegram-chat-1", name: "Steve James" },
            actorId: "telegram:user:1",
            actorLabel: "Steve James",
            messageId: "tg-msg-1",
          }),
        });
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
        await process.runTick("run-origin-context");

        const messages = process.store.getMessages();
        expect(messages.map((message: any) => message.content)).toEqual([
          "hello from telegram",
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
          conversationId: "side",
          config: {
            executor: { kind: "process", pid },
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
        await process.runTick("run-chat-text-thinking");
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

    it("persists active-run reply media on the final assistant message and signals", async () => {
      const pid = "mech-final-reply-media";
      const stub = await initProcess(pid, ROOT_IDENTITY);
      const key = `var/media/0/${pid}/final-report`;
      await env.STORAGE.put(key, new Uint8Array([1, 2, 3]), {
        httpMetadata: { contentType: "application/pdf" },
      });

      const result = await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        const emitted: Array<{ signal: string; payload: any }> = [];
        process.sendSignal = async (signal: string, payload: unknown) => {
          emitted.push({ signal, payload });
        };
        process.generation = {
          async generate() {
            return {
              role: "assistant",
              content: [{ type: "text", text: "Here is the report." }],
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
        process.store.appendMessage("user", "Send the report.");
        process.currentRun = {
          runId: "run-final-reply-media",
          conversationId: "default",
          config: {
            executor: { kind: "process", pid },
            profile: "task",
            provider: "workers-ai",
            model: "@cf/test/model",
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

        const media = {
          type: "document" as const,
          mimeType: "application/pdf",
          filename: "report.pdf",
          key,
          path: `/${key}`,
          size: 3,
        };
        const attach = await process.recvFrame({
          type: "req",
          id: crypto.randomUUID(),
          call: "proc.run.attach",
          args: {
            runId: "run-final-reply-media",
            media: [media],
            stagedKeys: [key],
          },
        } satisfies ProcessRunAttachRequestFrame);
        const pendingDelete = await process.recvFrame(makeReq("proc.media.delete", { key }));
        await process.runTick("run-final-reply-media");
        const history = await process.handleProcHistory({ conversationId: "default" });
        return {
          attach,
          pendingDelete,
          emitted,
          history,
          messages: process.store.getMessages(),
        };
      });

      expect(result.attach).toMatchObject({
        ok: true,
        data: { ok: true, runId: "run-final-reply-media", media: [{ key }] },
      });
      expect(result.pendingDelete).toMatchObject({
        ok: true,
        data: { ok: false, error: "media is referenced by process history" },
      });
      expect(result.messages.at(-1)).toMatchObject({
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
              media: [expect.objectContaining({
                key: expect.stringMatching(/^root\/\.gsv\/media\/archived-media:[0-9a-f]{64}$/),
                path: expect.stringMatching(/^\/root\/\.gsv\/media\/archived-media:[0-9a-f]{64}$/),
              })],
            }),
          }),
        ]),
      });
      for (const signal of ["proc.run.output", "proc.run.finished"]) {
        expect(result.emitted.find((entry) => entry.signal === signal)?.payload).toMatchObject({
          runId: "run-final-reply-media",
          media: [expect.objectContaining({
            key: expect.stringMatching(/^root\/\.gsv\/media\/archived-media:[0-9a-f]{64}$/),
            path: expect.stringMatching(/^\/root\/\.gsv\/media\/archived-media:[0-9a-f]{64}$/),
          })],
        });
      }
      const archivedKey = (result.history as any).messages
        .find((message: any) => message.role === "assistant").content.media[0].key;
      await expect(env.STORAGE.get(key)).resolves.toBeNull();
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
      const firstKey = await runInDurableObject(stub, async (instance: Process) => {
        const rewrites = await (instance as any).persistArchivedMediaKeys([liveKey]);
        return rewrites.get(liveKey).key as string;
      });

      await env.STORAGE.put(liveKey, new Uint8Array([9, 8, 7]), {
        httpMetadata: { contentType: "image/png" },
      });
      const secondKey = await runInDurableObject(stub, async (instance: Process) => {
        const rewrites = await (instance as any).persistArchivedMediaKeys([liveKey]);
        return rewrites.get(liveKey).key as string;
      });

      expect(secondKey).not.toBe(firstKey);
      const first = await env.STORAGE.get(firstKey);
      const second = await env.STORAGE.get(secondKey);
      expect(first && [...new Uint8Array(await first.arrayBuffer())]).toEqual([1, 2, 3]);
      expect(second && [...new Uint8Array(await second.arrayBuffer())]).toEqual([9, 8, 7]);
    });

    it("cleans command-staged reply media when the run aborts before a final answer", async () => {
      const pid = "mech-aborted-reply-media";
      const stub = await initProcess(pid, ROOT_IDENTITY);
      const key = `var/media/0/${pid}/unfinished-report`;
      await env.STORAGE.put(key, new Uint8Array([1]), {
        httpMetadata: { contentType: "application/pdf" },
      });

      await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        process.sendSignal = vi.fn(async () => {});
        process.currentRun = {
          runId: "run-aborted-reply-media",
          conversationId: "default",
        };
        const attach = await process.recvFrame({
          type: "req",
          id: crypto.randomUUID(),
          call: "proc.run.attach",
          args: {
            runId: "run-aborted-reply-media",
            media: [{
              type: "document",
              mimeType: "application/pdf",
              filename: "report.pdf",
              key,
              path: `/${key}`,
              size: 1,
            }],
            stagedKeys: [key],
          },
        } satisfies ProcessRunAttachRequestFrame);
        expect(attach).toMatchObject({ ok: true, data: { ok: true } });
        const abort = await process.handleProcAbort({ runId: "run-aborted-reply-media" });
        expect(abort).toMatchObject({ ok: true, aborted: true });
      });

      await vi.waitFor(async () => {
        expect(await env.STORAGE.head(key)).toBeNull();
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
          conversationId: "default",
          config: {
            executor: { kind: "process", pid },
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
        await process.runTick("run-chat-thinking-only");
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
          conversationId: "default",
          config: {
            executor: { kind: "process", pid },
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
        await process.runTick("run-chat-thinking-only-exhausted");
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
          conversationId: "default",
          config: {
            executor: { kind: "process", pid },
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
        await process.runTick("run-chat-empty-final-throw");
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
          conversationId: "default",
          config: {
            executor: { kind: "process", pid },
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
        await process.runTick("run-chat-tool-markup-text");
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
          conversationId: "default",
          config: {
            executor: { kind: "process", pid },
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
        await process.runTick("run-chat-provider-error-response");
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

    it("switches to a fallback model after an explicit provider error response", async () => {
      const pid = "mech-chat-provider-error-fallback";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      const result = await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        const emitted: Array<{ signal: string; payload: unknown }> = [];
        const calls: Array<{ provider: string; model: string; accountId?: string }> = [];
        process.sendSignal = async (signal: string, payload: unknown) => {
          emitted.push({ signal, payload });
        };
        process.generation = {
          async generate(request: any) {
            calls.push({
              provider: request.config.provider,
              model: request.config.model,
              accountId: request.config.openAiCodex?.accountId,
            });
            if (calls.length === 1) {
              return {
                role: "assistant",
                content: [],
                api: "test",
                provider: request.config.provider,
                model: request.config.model,
                stopReason: "error",
                errorMessage: "Custom provider HTTP 403: not authenticated",
                usage: testUsage(1, 0),
                timestamp: Date.now(),
              };
            }
            return {
              role: "assistant",
              content: [{ type: "text", text: "fallback pong" }],
              api: "test",
              provider: request.config.provider,
              model: request.config.model,
              stopReason: "stop",
              usage: testUsage(2, 3),
              timestamp: Date.now(),
            };
          },
          async generateText() {
            return "unused";
          },
        };

        process.store.appendMessage("user", "fail over please");
        process.currentRun = {
          runId: "run-chat-provider-error-fallback",
          conversationId: "default",
          config: {
            executor: { kind: "process", pid },
            profile: "task",
            provider: "custom",
            model: "zai-glm-4.7",
            apiKey: "bad-key",
            openAiCodex: { accountId: "primary-account" },
            reasoning: "high",
            maxTokens: 8192,
            contextWindowTokens: 256000,
            contextWindowSource: "config",
            maxContextBytes: 32768,
            fallbacks: [{
              profileId: "safe-stack",
              profileName: "Safe Stack",
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
            }],
          },
          tools: [],
          devices: [],
          systemPrompt: "Test system prompt.",
          approvalPolicy: { default: "auto", rules: [] },
        };
        await process.runTick("run-chat-provider-error-fallback");
        return {
          calls,
          emitted,
          messages: process.store.getMessages(),
        };
      });

      expect(result.calls).toEqual([
        { provider: "custom", model: "zai-glm-4.7", accountId: "primary-account" },
        { provider: "openrouter", model: "openai/gpt-5-mini", accountId: undefined },
      ]);
      expect(result.messages.map((message: any) => [message.role, message.content])).toEqual([
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
      const retry = result.emitted.find((entry) => entry.signal === "proc.run.retrying")?.payload as any;
      expect(retry).toMatchObject({
        pid,
        runId: "run-chat-provider-error-fallback",
        conversationId: "default",
        reason: "Custom provider HTTP 403: not authenticated",
        fallback: {
          from: { provider: "custom", model: "zai-glm-4.7" },
          to: { provider: "openrouter", model: "openai/gpt-5-mini" },
        },
      });
      const finished = result.emitted.find((entry) => entry.signal === "proc.run.finished")?.payload as any;
      expect(finished).toMatchObject({
        status: "ok",
        reason: "turn.complete",
      });
    });

    it("reapplies context policy after switching to a smaller fallback model", async () => {
      const pid = "mech-chat-fallback-auto-compact";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      const result = await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        const emitted: Array<{ signal: string; payload: unknown }> = [];
        const calls: Array<{ provider: string; model: string; context: string }> = [];
        const compactionConfigs: Array<{ provider: string; model: string }> = [];
        process.sendSignal = async (signal: string, payload: unknown) => {
          emitted.push({ signal, payload });
        };
        process.generation = {
          async generate(request: any) {
            calls.push({
              provider: request.config.provider,
              model: request.config.model,
              context: JSON.stringify(request.context),
            });
            if (calls.length === 1) {
              return {
                role: "assistant",
                content: [],
                api: "test",
                provider: request.config.provider,
                model: request.config.model,
                stopReason: "error",
                errorMessage: "Custom provider HTTP 403: not authenticated",
                usage: testUsage(1, 0),
                timestamp: Date.now(),
              };
            }
            return {
              role: "assistant",
              content: [{ type: "text", text: "fallback after compaction" }],
              api: "test",
              provider: request.config.provider,
              model: request.config.model,
              stopReason: "stop",
              usage: testUsage(20, 3),
              timestamp: Date.now(),
            };
          },
          async generateText(request: any) {
            compactionConfigs.push({
              provider: request.config.provider,
              model: request.config.model,
            });
            expect(JSON.stringify(request.context)).toContain("old context A");
            return "Fallback compact summary.";
          },
        };

        process.store.appendMessage("user", `old context A ${"x".repeat(4000)}`);
        process.store.appendMessage("assistant", `old context B ${"y".repeat(4000)}`);
        process.store.appendMessage("user", "Context that must stay live.");
        process.store.setValue("conversationPolicy:default", JSON.stringify({
          conversationId: "default",
          overflow: "auto-compact",
          compactAtPressure: 0.5,
          keepLast: 1,
          updatedAt: Date.now(),
        }));
        process.currentRun = {
          runId: "run-chat-fallback-auto-compact",
          conversationId: "default",
          config: {
            executor: { kind: "process", pid },
            profile: "task",
            provider: "custom",
            model: "large-primary",
            apiKey: "bad-key",
            reasoning: "off",
            maxTokens: 100,
            contextWindowTokens: 100000,
            contextWindowSource: "config",
            maxContextBytes: 32768,
            fallbacks: [{
              profileId: "small-fallback",
              profileName: "Small Fallback",
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
            }],
          },
          tools: [],
          devices: [],
          systemPrompt: "Test system prompt.",
          approvalPolicy: { default: "auto", rules: [] },
        };
        await process.runTick("run-chat-fallback-auto-compact");
        return {
          calls,
          compactionConfigs,
          emitted,
          messages: process.store.getMessages(),
          segments: process.store.listConversationSegments(),
        };
      });

      expect(result.calls).toHaveLength(2);
      expect(result.calls[0]).toMatchObject({ provider: "custom", model: "large-primary" });
      expect(result.calls[0].context).toContain("old context A");
      expect(result.calls[0].context).not.toContain("Fallback compact summary.");
      expect(result.calls[1]).toMatchObject({ provider: "openrouter", model: "small-fallback" });
      expect(result.calls[1].context).toContain("Fallback compact summary.");
      expect(result.calls[1].context).toContain("Context that must stay live.");
      expect(result.calls[1].context).not.toContain("old context A");
      expect(result.compactionConfigs).toEqual([
        { provider: "openrouter", model: "small-fallback" },
      ]);
      expect(result.messages.map((message: any) => [message.role, message.content])).toEqual([
        ["system", expect.stringContaining("Fallback compact summary.")],
        ["user", "Context that must stay live."],
        ["assistant", "fallback after compaction"],
      ]);
      expect(result.segments).toHaveLength(1);
      const lifecycleEvents = result.emitted
        .filter((entry) => entry.signal === "proc.changed")
        .map((entry) => (entry.payload as any).event)
        .filter(Boolean);
      expect(lifecycleEvents).toEqual([
        "conversation.compacted",
        "conversation.auto_compacted",
      ]);
    });

    it("switches to a fallback Codex account for the same model stack", async () => {
      const pid = "mech-chat-provider-error-account-fallback";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      const result = await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        const calls: Array<{ provider: string; model: string; apiKey: string; accountId?: string }> = [];
        process.sendSignal = async () => {};
        process.generation = {
          async generate(request: any) {
            calls.push({
              provider: request.config.provider,
              model: request.config.model,
              apiKey: request.config.apiKey,
              accountId: request.config.openAiCodex?.accountId,
            });
            if (calls.length === 1) {
              return {
                role: "assistant",
                content: [],
                api: "test",
                provider: request.config.provider,
                model: request.config.model,
                stopReason: "error",
                errorMessage: "Custom provider HTTP 403: quota exceeded",
                usage: testUsage(1, 0),
                timestamp: Date.now(),
              };
            }
            return {
              role: "assistant",
              content: [{ type: "text", text: "secondary account pong" }],
              api: "test",
              provider: request.config.provider,
              model: request.config.model,
              stopReason: "stop",
              usage: testUsage(2, 3),
              timestamp: Date.now(),
            };
          },
          async generateText() {
            return "unused";
          },
        };

        process.store.appendMessage("user", "try another account");
        process.currentRun = {
          runId: "run-chat-provider-error-account-fallback",
          conversationId: "default",
          config: {
            executor: { kind: "process", pid },
            profile: "task",
            provider: "openai-codex",
            model: "gpt-5.2-codex",
            apiKey: "shared-token",
            openAiCodex: { accountId: "primary-account" },
            transportTarget: "gsv",
            reasoning: "off",
            maxTokens: 4096,
            contextWindowTokens: 128000,
            contextWindowSource: "config",
            maxContextBytes: 32768,
            fallbacks: [{
              profileId: "secondary-account",
              profileName: "Secondary Account",
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
            }],
          },
          tools: [],
          devices: [],
          systemPrompt: "Test system prompt.",
          approvalPolicy: { default: "auto", rules: [] },
        };
        await process.runTick("run-chat-provider-error-account-fallback");
        return {
          calls,
          messages: process.store.getMessages(),
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
      expect(result.messages.map((message: any) => [message.role, message.content])).toEqual([
        ["user", "try another account"],
        ["assistant", "secondary account pong"],
      ]);
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
          conversationId: "default",
          config: {
            executor: { kind: "process", pid },
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
        await process.runTick("run-chat-provider-context-overflow-throw");
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
          conversationId: "default",
          config: {
            executor: { kind: "process", pid },
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
        await process.runTick("run-chat-provider-context-overflow-nested");
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
          conversationId: "default",
          config: {
            executor: { kind: "process", pid },
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
        await process.runTick("run-chat-provider-context-overflow-response");
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

    it("mirrors provider stream events as proc.run.stream signals with fallbacks configured", async () => {
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
            fallbacks: [{
              profileId: "backup-stack",
              profileName: "Backup Stack",
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
            }],
          },
          tools: [],
          devices: [],
          systemPrompt: "Test system prompt.",
          approvalPolicy: { default: "auto", rules: [] },
        };
        await process.runTick("run-chat-stream");
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
          conversationId: "default",
          config: {
            executor: { kind: "process", pid },
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
        await process.runTick("run-chat-stream-retry");
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
          conversationId: "default",
          config: {
            executor: { kind: "process", pid },
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
        await process.runTick("run-chat-stream-retry-tool-only");
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
            generationStreaming: "off",
          },
          tools: [],
          devices: [],
          systemPrompt: "Test system prompt.",
          approvalPolicy: { default: "auto", rules: [] },
        };
        await process.runTick("run-chat-stream-off");
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
        await process.runTick("run-chat-kernel-executor");
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

    it("routes device text executors through ai.text.generate target", async () => {
      const pid = "mech-chat-device-executor";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      const result = await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        const kernelCalls: Array<{ call: string; args: any; runSignal: boolean }> = [];
        process.kernelRpc = async (call: string, args: any, signal?: AbortSignal) => {
          kernelCalls.push({
            call,
            args,
            runSignal: signal === process.runAbortSignal("run-chat-device-executor"),
          });
          return {
            message: {
              role: "assistant",
              content: [{ type: "text", text: "device routed" }],
              api: "test",
              provider: "device",
              model: "local-model",
              usage: {
                input: 1,
                output: 1,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 2,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              stopReason: "stop",
              timestamp: Date.now(),
            },
            provider: "device",
            model: "local-model",
            text: "device routed",
          };
        };
        process.generation = {
          async generate() {
            throw new Error("process-local generate should not be used");
          },
          async generateText() {
            throw new Error("process-local generateText should not be used");
          },
        };

        const message = await process.generateAssistantResponse({
          runId: "run-chat-device-executor",
          conversationId: "default",
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
          messages: [{
            role: "user",
            content: "use device",
          }],
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

      const result = await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        const deviceRequests: Array<{ target: string; call: string; args: any; ttlMs?: number }> = [];
        process.sendSignal = async () => {};
        process.kernelRpc = async (call: string, args: any) => {
          throw new Error(`unexpected synchronous kernel syscall: ${call}`);
        };
        process.requestKernelNetFetch = async (
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

        process.store.appendMessage("user", "use local gateway");
        process.currentRun = {
          runId: "run-chat-custom-provider-transport-target",
          conversationId: "default",
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
        await process.runTick("run-chat-custom-provider-transport-target");
        return {
          deviceRequests,
          messages: process.store.getMessages(),
        };
      });

      expect(result.deviceRequests).toHaveLength(1);
      expect(result.messages[result.messages.length - 1]).toMatchObject({
        role: "assistant",
        content: "device hello",
      });
    });
  });

  describe("proc.send", () => {
    it("reconciles repeated adapter deliveries without duplicating admission", async () => {
      const pid = "mech-adapter-delivery-idempotent";
      const stub = await initProcess(pid, ROOT_IDENTITY);
      const args: ProcessAdapterDeliverArgs = {
        runId: "run-adapter-idempotent",
        pid,
        message: "retry-safe inbound message",
        origin: {
          kind: "adapter",
          adapter: "telegram",
          accountId: "primary",
          surface: { kind: "dm", id: "telegram-chat-1" },
          actorId: "telegram-user-1",
          messageId: "telegram-message-1",
        },
      };

      const firstRequest = makeAdapterDeliverReq(args);
      const first = await stub.recvFrame(firstRequest);
      expect(first).toMatchObject({
        type: "res",
        id: firstRequest.id,
        ok: true,
        data: {
          ok: true,
          status: "started",
          runId: args.runId,
        },
      });

      const repeatedRequest = makeAdapterDeliverReq(args);
      const repeated = await stub.recvFrame(repeatedRequest);
      expect(repeated).toMatchObject({
        type: "res",
        id: repeatedRequest.id,
        ok: true,
        data: {
          replayed: "active",
        },
      });
      expect((first as any).data).not.toHaveProperty("replayed");

      await runInDurableObject(stub, (instance: Process) => {
        const process = instance as any;
        expect(process.store.getMessages()).toEqual([
          expect.objectContaining({
            role: "user",
            content: args.message,
            runId: args.runId,
          }),
        ]);
        expect(process.store.queueSize()).toBe(0);
        expect(process.currentRun).toMatchObject({ runId: args.runId });
      });

      await runInDurableObject(stub, (instance: Process) => {
        (instance as any).currentRun = null;
      });
      const recordedRequest = makeAdapterDeliverReq(args);
      const recorded = await stub.recvFrame(recordedRequest);
      expect(recorded).toMatchObject({
        type: "res",
        id: recordedRequest.id,
        ok: true,
        data: {
          ok: true,
          runId: args.runId,
          replayed: "recorded",
        },
      });
    });

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
      // finishRun) should still run.
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

    it("queues process messages and preserves their run ids", async () => {
      const pid = "mech-send-queued";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      // Start first run
      const res1 = (await stub.recvFrame(
        makeReq("proc.send", { message: "First message" }),
      )) as ResponseOkFrame;
      expect(res1.ok).toBe(true);

      // Send second message while run is active — should be queued
      const res2 = (await stub.recvFrame(
        makeReq("proc.send", {
          message: "Second message",
          origin: { kind: "process", sourcePid: "child" },
        }),
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
        expect(userMsgs[0].runId).toBe((res1.data as any).runId);
        expect(userMsgs[1].runId).toBe((res2.data as any).runId);
        expect(store.queueSize()).toBe(0);
        expect(store.getValue("currentRun")).toBeNull();
      });
    });

    it("coalesces overlapping ticks onto the next durable generation", async () => {
      const stub = await initProcess("mech-single-active-tick", ROOT_IDENTITY);

      await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        let releaseTick!: () => void;
        let markTickStarted!: () => void;
        let markTickCompleted!: () => void;
        const blocked = new Promise<void>((resolve) => {
          releaseTick = resolve;
        });
        const started = new Promise<void>((resolve) => {
          markTickStarted = resolve;
        });
        const completed = new Promise<void>((resolve) => {
          markTickCompleted = resolve;
        });
        process.runTick = vi.fn(async () => {
          markTickStarted();
          await blocked;
          markTickCompleted();
        });
        process.schedule = vi.fn(async () => ({ id: "next-tick" }));
        process.currentRun = { runId: "run-once", conversationId: "default" };

        const first = process.tick({ runId: "run-once", generation: 0 });
        await started;
        await first;
        await process.tick({ runId: "run-once", generation: 0 });
        await process.tick({ runId: "run-once", generation: 1 });
        expect(process.runTick).toHaveBeenCalledTimes(1);

        releaseTick();
        await completed;
        await vi.waitFor(() => expect(process.schedule).toHaveBeenCalledWith(
          expect.any(Date),
          "tick",
          { runId: "run-once", generation: 2 },
          { idempotent: true },
        ));
        process.currentRun = null;
      });
    });

    it("terminalizes an uncaught background tick failure", async () => {
      const stub = await initProcess("mech-tick-failure", ROOT_IDENTITY);

      await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        process.sendSignal = vi.fn(async () => {});
        process.currentRun = { runId: "run-failure", conversationId: "default" };
        process.runTick = vi.fn(async () => {
          throw new Error("kernel unavailable");
        });

        await process.tick({ runId: "run-failure", generation: 0 });
        await vi.waitFor(() => {
          expect(process.currentRun).toBeNull();
          expect(process.sendSignal).toHaveBeenCalledWith(
            "proc.run.finished",
            expect.objectContaining({
              runId: "run-failure",
              status: "error",
              reason: "tick.error",
            }),
          );
        });
      });
    });

    it("keeps user takeover authoritative when successor scheduling fails", async () => {
      const pid = "mech-send-takeover-schedule-failure";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        process.sendSignal = vi.fn();
        process.scheduleTick = vi.fn(async () => {
          throw new Error("scheduler unavailable");
        });
        process.store.appendMessage("assistant", "", {
          runId: "run-old",
          toolCalls: JSON.stringify([
            { type: "toolCall", id: "call-old", name: "Read", arguments: { path: "/slow" } },
          ]),
        });
        process.store.register("dispatch-old", "call-old", "run-old", "fs.read", { path: "/slow" });
        process.currentRun = { runId: "run-old", conversationId: "default" };

        const result = await process.handleProcSend({
          message: "new direction",
          origin: { kind: "client", connectionId: "client-1" },
        });
        expect(result).toMatchObject({ ok: true, status: "started" });
        await vi.waitFor(() => expect(process.currentRun).toBeNull());

        expect(process.store.getMessages()).toEqual(expect.arrayContaining([
          expect.objectContaining({ role: "toolResult", toolCallId: "call-old" }),
          expect.objectContaining({ role: "user", content: "new direction", runId: result.runId }),
          expect.objectContaining({
            role: "system",
            runId: result.runId,
            content: expect.stringContaining("scheduler unavailable"),
          }),
        ]));
      });
    });

    it("does not resurrect a process when kill wins send admission", async () => {
      const stub = await initProcess("mech-send-after-kill", ROOT_IDENTITY);

      await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        const releaseLifecycle = await process.acquireLifecycleTransition();
        const sending = process.handleProcSend({
          message: "too late",
          origin: { kind: "client", connectionId: "client-1" },
        });
        await Promise.resolve();

        process.store.deleteValue("pid");
        process.store.deleteValue("identity");
        releaseLifecycle();

        await expect(sending).resolves.toEqual({
          ok: false,
          error: "Process no longer exists",
        });
        expect(process.currentRun).toBeNull();
      });
    });

    it("terminalizes a generated tool block and ignores its late result", async () => {
      const pid = "mech-send-live-tool-takeover";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        let releaseDispatch!: () => void;
        let markDispatchStarted!: () => void;
        const dispatchBlocked = new Promise<void>((resolve) => {
          releaseDispatch = resolve;
        });
        const dispatchStarted = new Promise<void>((resolve) => {
          markDispatchStarted = resolve;
        });
        let oldDispatchId = "";

        process.sendSignal = vi.fn();
        process.schedule = vi.fn();
        process.scheduleTick = vi.fn(async () => {});
        process.dispatchSyscall = vi.fn(async (
          _runId: string,
          dispatchId: string,
        ) => {
          oldDispatchId = dispatchId;
          markDispatchStarted();
          await dispatchBlocked;
        });
        process.generation = {
          async generate() {
            return {
              role: "assistant",
              content: [
                { type: "toolCall", id: "call-live-1", name: "Read", arguments: { path: "/one" } },
                { type: "toolCall", id: "call-live-2", name: "Read", arguments: { path: "/two" } },
              ],
              api: "test",
              provider: "test",
              model: "test",
              usage: testUsage(),
              stopReason: "toolUse",
              timestamp: Date.now(),
            };
          },
          async generateText() {
            return "";
          },
        };
        process.store.appendMessage("user", "read both files", { runId: "run-live-tools" });
        process.currentRun = {
          runId: "run-live-tools",
          conversationId: "default",
          config: {
            executor: { kind: "process", pid },
            profile: "task",
            provider: "test",
            model: "test",
            apiKey: "",
            reasoning: "off",
            maxTokens: 8192,
            contextWindowTokens: 128000,
            contextWindowSource: "config",
            maxContextBytes: 32768,
            generationStreaming: "off",
          },
          tools: [],
          devices: [],
          systemPrompt: "Test system prompt.",
          approvalPolicy: { default: "auto", rules: [] },
        };

        const ticking = process.runTick("run-live-tools");
        await dispatchStarted;
        const liveToolResults = process.store.getResults("run-live-tools");
        expect(oldDispatchId).not.toBe("call-live-1");
        expect(liveToolResults.map((result: any) => ({
          id: result.id,
          status: result.status,
        }))).toEqual([
          { id: "call-live-1", status: "pending" },
          { id: "call-live-2", status: "registered" },
        ]);

        const takeover = await process.handleProcSend({
          message: "stop and do this instead",
          origin: { kind: "client", connectionId: "client-1" },
        });
        const nextRunId = takeover.runId;
        expect(process.store.getMessages()
          .filter((message: any) => message.role === "toolResult")
          .map((message: any) => message.toolCallId)).toEqual([
            "call-live-1",
            "call-live-2",
          ]);

        releaseDispatch();
        await ticking;
        let lateBodyCancelled = false;
        await process.handleRes({
          type: "res",
          id: oldDispatchId,
          ok: true,
          data: { content: "late" },
          body: {
            stream: new ReadableStream({
              cancel() {
                lateBodyCancelled = true;
              },
            }),
            length: 4,
          },
        });

        expect(lateBodyCancelled).toBe(true);
        expect(process.store.getResults("run-live-tools")).toEqual([]);
        expect(process.dispatchSyscall.mock.calls.length).toBeGreaterThanOrEqual(1);
        expect(process.dispatchSyscall.mock.calls.length).toBeLessThanOrEqual(2);
        expect(process.currentRun).toMatchObject({ runId: nextRunId });
        expect(process.scheduleTick).toHaveBeenCalledTimes(1);
        expect(process.scheduleTick).toHaveBeenCalledWith(nextRunId);
        process.currentRun = null;
      });
    });

    it("serializes back-to-back user takeovers", async () => {
      const pid = "mech-send-serialized-takeovers";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        const finishedRuns: string[] = [];
        process.sendSignal = vi.fn();
        process.scheduleTick = vi.fn(async () => {});
        process.emitRunFinished = vi.fn((run: { runId: string }) => {
          finishedRuns.push(run.runId);
        });
        process.currentRun = { runId: "run-original", conversationId: "default" };

        const first = process.handleProcSend({
          message: "first takeover",
          origin: { kind: "client", connectionId: "client-1" },
        });
        const second = process.handleProcSend({
          message: "second takeover",
          origin: { kind: "client", connectionId: "client-1" },
        });
        const [firstResult, secondResult] = await Promise.all([first, second]);
        expect(finishedRuns).toEqual(["run-original", firstResult.runId]);
        expect(process.currentRun.runId).toBe(secondResult.runId);
        process.currentRun = null;
      });
    });

    it("rejects out-of-scope media before changing the active run", async () => {
      const pid = "mech-send-foreign-media";
      const stub = await initProcess(pid, ROOT_IDENTITY);
      const foreignKey = `var/media/0/another-process/${crypto.randomUUID()}`;
      await env.STORAGE.put(foreignKey, new Uint8Array([1, 2, 3]));

      try {
        const result = await runInDurableObject(stub, async (instance: Process) => {
          const process = instance as any;
          process.currentRun = { runId: "run-existing", conversationId: "default" };
          const response = await process.handleProcSend({
            message: "read this",
            media: [{ type: "image", mimeType: "image/png", key: foreignKey }],
            origin: { kind: "client", connectionId: "client-1" },
          });
          return {
            response,
            currentRun: process.currentRun,
            messages: process.store.getMessages(),
          };
        });

        expect(result).toEqual({
          response: { ok: false, error: "media key is outside this process" },
          currentRun: { runId: "run-existing", conversationId: "default" },
          messages: [],
        });
        expect(await env.STORAGE.head(foreignKey)).not.toBeNull();
      } finally {
        await env.STORAGE.delete(foreignKey);
      }
    });

    it.each([false, true])(
      "keeps a newer user run authoritative when earlier media fails=%s",
      async (fails) => {
        const pid = `mech-send-media-race-${fails}`;
        const stub = await initProcess(pid, ROOT_IDENTITY);

        await runInDurableObject(stub, async (instance: Process) => {
          const process = instance as any;
          let releaseMedia!: () => void;
          let markMediaStarted!: () => void;
          const mediaBlocked = new Promise<void>((resolve) => {
            releaseMedia = resolve;
          });
          const mediaStarted = new Promise<void>((resolve) => {
            markMediaStarted = resolve;
          });
          process.sendSignal = vi.fn();
          process.scheduleTick = vi.fn(async () => {});
          const prepareMedia = vi.spyOn(process, "prepareRunMedia");
          process.resolveMediaProcessingOptions = vi.fn(async () => {
            markMediaStarted();
            await mediaBlocked;
            if (fails) {
              throw new Error("media config failed");
            }
            return { ai: process.env.AI };
          });
          const mediaKey = `var/media/0/${pid}/race.png`;
          await process.env.STORAGE.put(mediaKey, new Uint8Array([1, 2, 3]), {
            httpMetadata: { contentType: "image/png" },
          });

          const first = await process.handleProcSend({
            message: "first with media",
            media: [{ type: "image", mimeType: "image/png", key: mediaKey }],
            origin: { kind: "client", connectionId: "client-1" },
          });
          await mediaStarted;
          expect(process.currentRun).toMatchObject({
            runId: first.runId,
            pendingMediaMessageId: expect.any(Number),
          });

          const second = await process.handleProcSend({
            message: "new user direction",
            origin: { kind: "client", connectionId: "client-1" },
          });
          releaseMedia();
          await (prepareMedia.mock.results[0]?.value as Promise<void>);

          const userMessages = process.store.getMessages()
            .filter((message: any) => message.role === "user");
          expect(userMessages[0]).toMatchObject({
            runId: first.runId,
            media: expect.any(String),
          });
          expect(process.currentRun).toMatchObject({ runId: second.runId });
          expect(process.store.getMessages().some((message: any) => (
            message.role === "system" && message.content.includes("media config failed")
          ))).toBe(false);
          expect(process.scheduleTick).toHaveBeenCalledTimes(1);
          expect(process.scheduleTick).toHaveBeenCalledWith(second.runId);
          process.currentRun = null;
        });
      },
    );

    it("finishes a media run when its generation tick cannot be scheduled", async () => {
      const pid = "mech-send-media-schedule-failure";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        process.sendSignal = vi.fn();
        process.scheduleTick = vi.fn(async () => {
          throw new Error("scheduler unavailable");
        });
        process.resolveMediaProcessingOptions = vi.fn(async () => ({ ai: process.env.AI }));
        const prepareMedia = vi.spyOn(process, "prepareRunMedia");
        const mediaKey = `var/media/0/${pid}/schedule.png`;
        await process.env.STORAGE.put(mediaKey, new Uint8Array([1, 2, 3]), {
          httpMetadata: { contentType: "image/png" },
        });

        const result = await process.handleProcSend({
          message: "attachment",
          media: [{ type: "image", mimeType: "image/png", key: mediaKey }],
          origin: { kind: "client", connectionId: "client-1" },
        });
        await (prepareMedia.mock.results[0]?.value as Promise<void>);

        expect(process.currentRun).toBeNull();
        expect(process.store.getMessages()).toEqual(expect.arrayContaining([
          expect.objectContaining({
            role: "system",
            runId: result.runId,
            content: expect.stringContaining("scheduler unavailable"),
          }),
        ]));
        expect(process.sendSignal).toHaveBeenCalledWith(
          "proc.run.finished",
          expect.objectContaining({
            runId: result.runId,
            status: "error",
            reason: "schedule.error",
          }),
        );
      });
    });

    it("keeps process-origin media sends in admission order", async () => {
      const pid = "mech-send-process-media-fifo";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        let releaseMedia!: () => void;
        let markMediaStarted!: () => void;
        const mediaBlocked = new Promise<void>((resolve) => {
          releaseMedia = resolve;
        });
        const mediaStarted = new Promise<void>((resolve) => {
          markMediaStarted = resolve;
        });
        process.sendSignal = vi.fn();
        process.resolveMediaProcessingOptions = vi.fn(async (media: unknown[] | undefined) => {
          if (media?.length) {
            markMediaStarted();
            await mediaBlocked;
          }
          return { ai: process.env.AI };
        });
        process.currentRun = { runId: "run-busy", conversationId: "default" };
        const mediaKey = `var/media/0/${pid}/fifo.png`;
        await process.env.STORAGE.put(mediaKey, new Uint8Array([1, 2, 3]), {
          httpMetadata: { contentType: "image/png" },
        });

        const first = process.handleProcSend({
          message: "first process message",
          media: [{ type: "image", mimeType: "image/png", key: mediaKey }],
          origin: { kind: "process", sourcePid: "child-1" },
        });
        await mediaStarted;
        const second = process.handleProcSend({
          message: "second process message",
          origin: { kind: "process", sourcePid: "child-2" },
        });

        releaseMedia();
        await Promise.all([first, second]);

        expect(process.store.drainQueue("default").map((entry: any) => entry.message)).toEqual([
          "first process message",
          "second process message",
        ]);
        process.currentRun = null;
      });
    });

    it("stores process-scoped media, reads it back, and hydrates image context blocks", async () => {
      const pid = "mech-send-media";
      const stub = await initProcess(pid, ROOT_IDENTITY);
      let mediaKey = "";

      const upload = (await stub.recvFrame({
        ...makeReq("proc.media.write", {
          type: "image",
          mimeType: "image/png",
          filename: "proof.png",
        }),
        body: bodyFromBytes(new Uint8Array([1, 2, 3])),
      })) as ResponseFrame<"proc.media.write">;
      if (!upload.ok) {
        throw new Error(upload.error.message);
      }
      expect(upload.data).toMatchObject({
        ok: true,
        media: {
          size: 3,
          path: expect.stringMatching(`^/var/media/0/${pid}/`),
        },
      });
      const uploadedMedia = upload.data?.ok ? upload.data.media : null;
      expect(uploadedMedia).not.toBeNull();

      const res = (await stub.recvFrame(
        makeReq("proc.send", {
          message: "Describe this image.",
          media: [uploadedMedia],
        }),
      )) as ResponseOkFrame;

      expect(res.ok).toBe(true);

      await vi.waitFor(async () => {
        const media = await runInDurableObject(stub, (instance: Process) => {
          return (instance as any).store.getMessages()[0]?.media;
        });
        expect(media).toBeTruthy();
      });

      await runInDurableObject(stub, async (instance: Process) => {
        const store = (instance as any).store;
        const record = store.getMessages()[0];
        expect(record.role).toBe("user");
        expect(record.media).toBeTruthy();

        const media = JSON.parse(record.media!);
        expect(media).toHaveLength(1);
        expect(media[0].key).toContain(`/0/${pid}/`);
        expect(media[0].path).toBe(`/${media[0].key}`);
        mediaKey = media[0].key;

        const stored = await env.STORAGE.get(media[0].key);
        expect(stored).not.toBeNull();
        expect(stored?.customMetadata).toMatchObject({
          uid: "0",
          gid: "0",
          mode: "400",
          processId: pid,
        });

        const messages = await (instance as any).buildContextMessages();
        const user = messages[0] as any;
        expect(Array.isArray(user.content)).toBe(true);
        expect(user.content[0]).toEqual({ type: "text", text: "Describe this image." });
        expect(user.content[1]).toEqual({
          type: "text",
          text: `Attached image "proof.png" [image/png] 3 B\nPath: /${media[0].key}`,
        });
        expect(user.content[2].type).toBe("image");
        expect(user.content[2].mimeType).toBe("image/png");
        expect(user.content[2].data).toBe("AQID");
      });

      const read = (await stub.recvFrame(
        makeReq("proc.media.read", { key: mediaKey }),
      )) as ResponseOkFrame;
      expect(read.ok).toBe(true);
      expect(read.data).toMatchObject({
        ok: true,
        key: mediaKey,
        path: `/${mediaKey}`,
        mimeType: "image/png",
      });
      expect(read.body && [...await bodyToBytes(read.body)]).toEqual([1, 2, 3]);

      const referenced = (await stub.recvFrame(
        makeReq("proc.media.delete", { key: mediaKey }),
      )) as ResponseOkFrame;
      expect(referenced.data).toEqual({
        ok: false,
        error: "media is referenced by process history",
      });
      expect(await env.STORAGE.head(mediaKey)).not.toBeNull();

      const unusedUpload = (await stub.recvFrame({
        ...makeReq("proc.media.write", {
          type: "document",
          mimeType: "application/octet-stream",
        }),
        body: bodyFromBytes(new Uint8Array([4, 5, 6])),
      })) as ResponseOkFrame<"proc.media.write">;
      const unusedKey = unusedUpload.data?.ok ? unusedUpload.data.media.key : "";
      expect(unusedKey).toBeTruthy();
      const deleted = (await stub.recvFrame(
        makeReq("proc.media.delete", { key: unusedKey }),
      )) as ResponseOkFrame;
      expect(deleted.data).toEqual({ ok: true, key: unusedKey });
      const deletedAgain = (await stub.recvFrame(
        makeReq("proc.media.delete", { key: unusedKey }),
      )) as ResponseOkFrame;
      expect(deletedAgain.data).toEqual({ ok: true, key: unusedKey });
      expect(await env.STORAGE.head(unusedKey)).toBeNull();

      const outside = (await stub.recvFrame(
        makeReq("proc.media.delete", { key: "var/media/0/another-process/file" }),
      )) as ResponseOkFrame;
      expect(outside.data).toEqual({ ok: false, error: "media key is outside this process" });
      const withBody = (await stub.recvFrame({
        ...makeReq("proc.media.delete", { key: unusedKey }),
        body: bodyFromBytes(new Uint8Array()),
      })) as ResponseOkFrame;
      expect(withBody.data).toEqual({ ok: false, error: "proc.media.delete does not accept a body" });
    });

    it("reconciles repeated process media writes and drains the repeated body", async () => {
      const pid = "mech-media-write-idempotent";
      const stub = await initProcess(pid, ROOT_IDENTITY);
      const args = {
        type: "image" as const,
        mimeType: "image/png",
        filename: "provider-image.png",
        mediaId: "provider-message-1:image-1",
      };

      const first = (await stub.recvFrame({
        ...makeReq("proc.media.write", args),
        body: bodyFromBytes(new Uint8Array([1, 2, 3])),
      })) as ResponseOkFrame<"proc.media.write">;
      expect(first.data).toMatchObject({
        ok: true,
        media: {
          type: "image",
          mimeType: "image/png",
          filename: "provider-image.png",
          size: 3,
          key: `var/media/0/${pid}/${args.mediaId}`,
          path: `/var/media/0/${pid}/${args.mediaId}`,
        },
      });
      const originalMedia = (first.data as any).media;

      let repeatedBodyPulled = false;
      const repeatedBody = new ReadableStream<Uint8Array>({
        pull(controller) {
          repeatedBodyPulled = true;
          controller.enqueue(new Uint8Array([9, 9, 9]));
          controller.close();
        },
      }, { highWaterMark: 0 });
      const repeated = (await stub.recvFrame({
        ...makeReq("proc.media.write", args),
        body: { stream: repeatedBody, length: 3 },
      })) as ResponseOkFrame<"proc.media.write">;

      expect(repeatedBodyPulled).toBe(true);
      expect(repeated.data).toEqual({ ok: true, media: originalMedia });

      const mimeConflict = (await runInDurableObject(stub, (instance: Process) =>
        instance.recvFrame({
          ...makeReq("proc.media.write", {
            ...args,
            mimeType: "image/jpeg",
          }),
          body: bodyFromBytes(new Uint8Array([4, 5, 6])),
        })
      )) as ResponseOkFrame<"proc.media.write">;
      expect(mimeConflict.data).toEqual({
        ok: false,
        error: "proc.media.write mediaId conflicts with existing media",
      });
      for (const conflictingArgs of [
        { ...args, type: "document" as const },
        { ...args, filename: "different-provider-image.png" },
        { ...args, duration: 12 },
        { ...args, transcription: "different transcript" },
      ]) {
        const conflict = (await runInDurableObject(stub, (instance: Process) =>
          instance.recvFrame({
            ...makeReq("proc.media.write", conflictingArgs),
            body: bodyFromBytes(new Uint8Array([4, 5, 6])),
          })
        )) as ResponseOkFrame<"proc.media.write">;
        expect(conflict.data).toEqual({
          ok: false,
          error: "proc.media.write mediaId conflicts with existing media",
        });
      }

      const stored = await env.STORAGE.get(originalMedia.key);
      expect(stored).not.toBeNull();
      expect([...new Uint8Array(await new Response(stored!.body).arrayBuffer())]).toEqual([1, 2, 3]);
    });

    it("serializes concurrent repeated media writes into one storage put", async () => {
      const pid = "mech-media-write-concurrent-idempotent";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      const result = await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        const originalEnv = process.env;
        const objects = new Map<string, {
          bytes: Uint8Array;
          httpMetadata?: { contentType?: string };
          customMetadata?: Record<string, string>;
        }>();
        let releasePut!: () => void;
        let markPutStarted!: () => void;
        const putBlocked = new Promise<void>((resolve) => {
          releasePut = resolve;
        });
        const putStarted = new Promise<void>((resolve) => {
          markPutStarted = resolve;
        });
        const put = vi.fn(async (
          key: string,
          stream: ReadableStream<Uint8Array>,
          options?: {
            httpMetadata?: { contentType?: string };
            customMetadata?: Record<string, string>;
          },
        ) => {
          markPutStarted();
          await putBlocked;
          const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
          objects.set(key, {
            bytes,
            httpMetadata: options?.httpMetadata,
            customMetadata: options?.customMetadata,
          });
          return { key, size: bytes.byteLength };
        });
        process.env = {
          ...originalEnv,
          STORAGE: {
            head: vi.fn(async (key: string) => {
              const object = objects.get(key);
              return object
                ? {
                  key,
                  size: object.bytes.byteLength,
                  httpMetadata: object.httpMetadata,
                  customMetadata: object.customMetadata,
                }
                : null;
            }),
            put,
            delete: vi.fn(async (key: string) => {
              objects.delete(key);
            }),
          },
        };

        try {
          const args = {
            type: "image" as const,
            mimeType: "image/png",
            filename: "concurrent.png",
            mediaId: "provider-message-2:image-1",
          };
          const first = process.handleProcMediaWrite(
            args,
            bodyFromBytes(new Uint8Array([1, 2, 3])),
          );
          await putStarted;
          const repeated = process.handleProcMediaWrite(
            args,
            bodyFromBytes(new Uint8Array([9, 9, 9])),
          );
          releasePut();
          const [firstResult, repeatedResult] = await Promise.all([first, repeated]);
          const stored = [...objects.values()][0];
          return {
            firstResult,
            repeatedResult,
            putCalls: put.mock.calls.length,
            storedBytes: stored ? [...stored.bytes] : [],
          };
        } finally {
          process.env = originalEnv;
          releasePut();
        }
      });

      expect(result.putCalls).toBe(1);
      expect(result.repeatedResult).toEqual(result.firstResult);
      expect(result.storedBytes).toEqual([1, 2, 3]);
    });

    it("keeps SVG attachments out of raster model image blocks", async () => {
      const stub = await initProcess("mech-svg-context", ROOT_IDENTITY);

      await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        const originalEnv = process.env;
        const get = vi.fn();
        process.store.appendMessage("user", "Review this diagram.", {
          media: JSON.stringify([{
            type: "image",
            mimeType: "image/svg+xml",
            key: "var/media/0/mech-svg-context/diagram.svg",
            filename: "diagram.svg",
          }]),
        });
        process.env = { ...originalEnv, STORAGE: { get } };

        try {
          const messages = await process.buildContextMessages("default");
          expect(get).not.toHaveBeenCalled();
          expect(messages[0].content).toEqual([
            { type: "text", text: "Review this diagram." },
            {
              type: "text",
              text: "Attached image \"diagram.svg\" [image/svg+xml]\nPath: /var/media/0/mech-svg-context/diagram.svg",
            },
          ]);
        } finally {
          process.env = originalEnv;
        }
      });
    });

    it("only deletes process-scoped media after preparation fails", async () => {
      const pid = "mech-media-preparation-cleanup";
      const stub = await initProcess(pid, ROOT_IDENTITY);
      const ownKey = `var/media/0/${pid}/${crypto.randomUUID()}`;
      const foreignKey = `var/media/0/another-process/${crypto.randomUUID()}`;
      await env.STORAGE.put(ownKey, new Uint8Array([1]));
      await env.STORAGE.put(foreignKey, new Uint8Array([2]));

      try {
        await runInDurableObject(stub, async (instance: Process) => {
          const process = instance as any;
          const runId = "run-media-cleanup";
          const media = [
            { type: "document", mimeType: "application/octet-stream", key: ownKey },
            { type: "document", mimeType: "application/octet-stream", key: foreignKey },
          ];
          const messageId = process.store.appendMessage("user", "attachments", {
            runId,
            media: JSON.stringify(media),
          });
          process.currentRun = {
            runId,
            conversationId: "default",
            pendingMediaMessageId: messageId,
          };
          process.sendSignal = vi.fn(async () => {});
          process.resolveMediaProcessingOptions = vi.fn(async () => ({ ai: process.env.AI }));

          await process.prepareRunMedia(runId, "default", messageId, media);
        });

        expect(await env.STORAGE.head(ownKey)).toBeNull();
        expect(await env.STORAGE.head(foreignKey)).not.toBeNull();
      } finally {
        await env.STORAGE.delete([ownKey, foreignKey]);
      }
    });

    it("requires the media body descriptor length", async () => {
      const stub = await initProcess("mech-media-length", ROOT_IDENTITY);
      const response = (await stub.recvFrame({
        ...makeReq("proc.media.write", {
          type: "image",
          mimeType: "image/png",
        }),
        body: {
          stream: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array([1, 2, 3]));
              controller.close();
            },
          }),
        },
      })) as ResponseOkFrame;

      expect(response.data).toEqual({
        ok: false,
        error: "proc.media.write requires an exact body length",
      });
    });

    it("rejects the reserved R2 directory-marker media id", async () => {
      const stub = await initProcess("mech-media-reserved-marker", ROOT_IDENTITY);
      const response = (await stub.recvFrame({
        ...makeReq("proc.media.write", {
          type: "document",
          mimeType: "application/octet-stream",
          mediaId: ".dir",
        }),
        body: bodyFromBytes(new Uint8Array([1])),
      })) as ResponseOkFrame;

      expect(response.data).toEqual({
        ok: false,
        error: "proc.media.write mediaId is invalid",
      });
    });

    it("deletes an upload that finishes after a process reset", async () => {
      const pid = "mech-media-reset-race";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        const originalEnv = process.env;
        const objects = new Map<string, Uint8Array>();
        let releasePut!: () => void;
        let markPutStarted!: () => void;
        const putBlocked = new Promise<void>((resolve) => {
          releasePut = resolve;
        });
        const putStarted = new Promise<void>((resolve) => {
          markPutStarted = resolve;
        });
        const deleteObject = vi.fn(async (key: string | string[]) => {
          for (const item of Array.isArray(key) ? key : [key]) {
            objects.delete(item);
          }
        });
        process.env = {
          ...originalEnv,
          STORAGE: {
            put: vi.fn(async (key: string, stream: ReadableStream<Uint8Array>) => {
              markPutStarted();
              await putBlocked;
              const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
              objects.set(key, bytes);
              return { key, size: bytes.byteLength };
            }),
            list: vi.fn(async ({ prefix }: { prefix: string }) => ({
              objects: [...objects.entries()]
                .filter(([key]) => key.startsWith(prefix))
                .map(([key, bytes]) => ({ key, size: bytes.byteLength })),
              truncated: false,
            })),
            delete: deleteObject,
          },
        };

        try {
          const writing = process.handleProcMediaWrite(
            { type: "image", mimeType: "image/png" },
            bodyFromBytes(new Uint8Array([1, 2, 3])),
          );
          await putStarted;
          await process.handleProcReset();
          releasePut();

          await expect(writing).resolves.toEqual({
            ok: false,
            error: "Process reset during media upload",
          });
          expect(objects.size).toBe(0);
          expect(deleteObject).toHaveBeenCalledWith(expect.stringContaining(`/0/${pid}/`));
        } finally {
          process.env = originalEnv;
          releasePut();
        }
      });
    });

    it("bounds media materialized while building model context", async () => {
      const pid = "mech-bounded-context-media";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        const originalEnv = process.env;
        const arrayBuffer = vi.fn(async () => new Uint8Array([1]).buffer);
        const prefix = `var/media/0/${pid}/`;
        process.store.appendMessage("user", "Review these images.", {
          media: JSON.stringify([
            { type: "image", mimeType: "image/png", key: `${prefix}oversized` },
            { type: "image", mimeType: "image/png", key: `${prefix}first` },
            { type: "image", mimeType: "image/png", key: `${prefix}second` },
          ]),
        });
        process.env = {
          ...originalEnv,
          STORAGE: {
            get: vi.fn(async (key: string) => ({
              size: key.endsWith("oversized") ? 25 * 1024 * 1024 + 1 : 15 * 1024 * 1024,
              arrayBuffer,
              body: { cancel: vi.fn(async () => {}) },
            })),
          },
        };

        try {
          const messages = await process.buildContextMessages("default");
          expect(arrayBuffer).toHaveBeenCalledTimes(1);
          expect(messages[0].content).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: "image", data: "AQ==" }),
          ]));
        } finally {
          process.env = originalEnv;
        }
      });
    });

    it("does not hydrate out-of-scope media from persisted history", async () => {
      const stub = await initProcess("mech-foreign-context-media", ROOT_IDENTITY);

      await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        const originalEnv = process.env;
        const get = vi.fn(async () => ({
          size: 3,
          arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
        }));
        process.store.appendMessage("user", "Legacy attachment", {
          media: JSON.stringify([{
            type: "image",
            mimeType: "image/png",
            key: "var/media/0/another-process/secret.png",
          }]),
        });
        process.env = {
          ...originalEnv,
          STORAGE: { get },
        };

        try {
          const messages = await process.buildContextMessages("default");
          expect(get).not.toHaveBeenCalled();
          expect(messages[0].content).not.toEqual(expect.arrayContaining([
            expect.objectContaining({ type: "image" }),
          ]));
        } finally {
          process.env = originalEnv;
        }
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
        (instance as any).scheduleTick = async () => {};
      });
      await runInDurableObject(target, (instance: Process) => {
        (instance as any).currentRun = {
          runId: "existing-target-run",
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
        store.enqueue(data.runId, queued[0].message, undefined, "mail");
      });

      await runInDurableObject(kernel, async (instance: Kernel) => {
        await instance.recvFrame(targetPid, {
          type: "sig",
          signal: "proc.run.finished",
          payload: {
            pid: targetPid,
            runId: data.runId,
            text: "status is green",
          },
        });
      });

      await waitForStoredMessage(source, (message) => (
        message.content.includes(`Task id: \`${data.callId}\``)
      ));

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

    it("returns aborted target runs to IPC callers as errors", async () => {
      const sourcePid = "mech-ipc-abort-source";
      const targetPid = "mech-ipc-abort-target";
      const source = await initProcess(sourcePid, ROOT_IDENTITY);
      await initProcess(targetPid, ROOT_IDENTITY);
      await runInDurableObject(source, (instance: Process) => {
        (instance as any).scheduleTick = vi.fn(async () => {});
      });

      const kernel = await getKernelPtr();
      const response = await runInDurableObject(kernel, (instance: Kernel) =>
        instance.recvFrame(
          sourcePid,
          makeReq("proc.ipc.call", {
            pid: targetPid,
            message: "Start a delegated task.",
            timeoutMs: 30_000,
          }),
        ),
      ) as ResponseOkFrame;
      const data = response.data as any;

      await runInDurableObject(kernel, (instance: Kernel) =>
        instance.recvFrame(targetPid, {
          type: "sig",
          signal: "proc.run.finished",
          payload: {
            pid: targetPid,
            runId: data.runId,
            status: "aborted",
            reason: "user.superseded",
            text: null,
          },
        }),
      );

      await waitForStoredMessage(source, (message) => (
        message.content.includes(`Task id: \`${data.callId}\``)
      ));

      await runInDurableObject(source, (instance: Process) => {
        const process = instance as any;
        const reply = process.store.getMessages().find((message: any) =>
          message.role === "system"
          && message.content.includes(`Task id: \`${data.callId}\``)
        );
        expect(reply?.content).toContain("Error:");
        expect(reply?.content).toContain("Target run was aborted: user.superseded");
        process.currentRun = null;
      });
    });

    it("cancels delegated IPC when its source run is superseded", async () => {
      const sourcePid = "mech-ipc-cancelled-source-run";
      const targetPid = "mech-ipc-cancelled-target-run";
      const source = await initProcess(sourcePid, ROOT_IDENTITY);
      const target = await initProcess(targetPid, ROOT_IDENTITY);

      await runInDurableObject(source, (instance: Process) => {
        (instance as any).scheduleTick = vi.fn(async () => {});
      });
      await runInDurableObject(target, (instance: Process) => {
        const process = instance as any;
        process.currentRun = { runId: "target-busy-run", conversationId: "default" };
      });

      const firstSend = (await source.recvFrame(makeReq("proc.send", {
        message: "delegate a slow task",
        origin: { kind: "client", connectionId: "client-1" },
      }))) as ResponseOkFrame;
      const sourceRunId = (firstSend.data as any).runId as string;

      const kernel = await getKernelPtr();
      const ipcResponse = await runInDurableObject(kernel, (instance: Kernel) =>
        instance.recvFrame(sourcePid, {
          ...makeReq("proc.ipc.call", {
            pid: targetPid,
            message: "wait for the slow task",
            timeoutMs: 30_000,
          }),
          runId: sourceRunId,
        }),
      ) as ResponseOkFrame;
      const ipc = ipcResponse.data as any;
      expect(ipc).toMatchObject({ ok: true, queued: true });

      const secondSend = (await source.recvFrame(makeReq("proc.send", {
        message: "stop waiting and do this instead",
        origin: { kind: "client", connectionId: "client-1" },
      }))) as ResponseOkFrame;
      const successorRunId = (secondSend.data as any).runId as string;

      await vi.waitFor(async () => {
        expect(await runInDurableObject(kernel, (instance: Kernel) => (
          (instance as any).ipcCalls.get(ipc.callId)
        ))).toBeNull();
      });
      await runInDurableObject(kernel, async (instance: Kernel) => {
        await instance.recvFrame(targetPid, {
          type: "sig",
          signal: "proc.run.finished",
          payload: {
            pid: targetPid,
            runId: ipc.runId,
            status: "ok",
            text: "late delegated result",
          },
        });
        expect((instance as any).ipcCalls.get(ipc.callId)).toBeNull();
      });

      await runInDurableObject(source, (instance: Process) => {
        const process = instance as any;
        expect(process.currentRun).toMatchObject({ runId: successorRunId });
        expect(process.store.getMessages().some((message: any) => (
          message.role === "system"
          && (message.content.includes(`Task id: \`${ipc.callId}\``)
            || message.content.includes("late delegated result"))
        ))).toBe(false);
        process.currentRun = null;
      });
      await runInDurableObject(target, (instance: Process) => {
        const process = instance as any;
        process.currentRun = null;
        process.store.clearQueue();
      });
    });

    it("drops IPC replies for a source run that was already aborted", async () => {
      const pid = "mech-ipc-aborted-source-run";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        process.sendSignal = vi.fn();
        process.scheduleTick = vi.fn(async () => {});
        process.rememberAbortedRun("run-aborted");
        process.currentRun = { runId: "run-successor", conversationId: "default" };

        await instance.recvFrame({
          type: "sig",
          signal: "ipc.reply",
          payload: {
            callId: "call-aborted",
            sourcePid: pid,
            sourceRunId: "run-aborted",
            targetPid: "target-process",
            runId: "target-run",
            deadlineAt: Date.now() + 30_000,
            status: "completed",
            response: { text: "late delegated result", usage: null },
          },
        } as any);

        expect(process.store.getMessages()).toEqual([]);
        expect(process.store.queueSize("default")).toBe(0);
        expect(process.currentRun).toMatchObject({ runId: "run-successor" });
        expect(process.sendSignal).not.toHaveBeenCalled();
        expect(process.scheduleTick).not.toHaveBeenCalled();
        process.currentRun = null;
      });
    });

    it("drops IPC terminal events created before a process reset", async () => {
      const pid = "mech-ipc-reset-source";
      const stub = await initProcess(pid, ROOT_IDENTITY);
      const createdAt = Date.now() - 1_000;

      await stub.recvFrame(makeReq("proc.reset", {}));
      await stub.recvFrame({
        type: "sig",
        signal: "ipc.reply",
        payload: {
          callId: "call-before-reset",
          sourcePid: pid,
          targetPid: "target-process",
          runId: "target-run",
          createdAt,
          deadlineAt: Date.now() + 30_000,
          status: "completed",
          response: { text: "stale result", usage: null },
        },
      });

      await runInDurableObject(stub, (instance: Process) => {
        const process = instance as any;
        expect(process.store.getMessages()).toEqual([]);
        expect(process.currentRun).toBeNull();
      });
    });

    it("does not recreate a killed process for a late IPC event", async () => {
      const stub = await initProcess("mech-ipc-killed-source", ROOT_IDENTITY);

      await stub.recvFrame(makeReq("proc.kill", { archive: false }));
      const late = await stub.recvFrame({
        type: "sig",
        signal: "ipc.timeout",
        payload: {
          callId: "call-after-kill",
          sourcePid: "mech-ipc-killed-source",
          targetPid: "target-process",
          runId: "target-run",
          createdAt: Date.now() - 1_000,
          deadlineAt: Date.now(),
          status: "timed_out",
          error: "IPC call timed out",
        },
      });
      expect(late).toBeNull();

      await runInDurableObject(stub, (_instance: Process, state) => {
        const tables = state.storage.sql.exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table'",
        ).toArray().map((row) => row.name);
        expect(tables).not.toEqual(expect.arrayContaining([
          "conversations",
          "messages",
          "process_kv",
        ]));
      });
    });

    it("deduplicates retried IPC terminal delivery by call id", async () => {
      const pid = "mech-ipc-deduplicated-reply";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        process.sendSignal = vi.fn();
        process.scheduleTick = vi.fn(async () => {});
        const frame = {
          type: "sig",
          signal: "ipc.reply",
          payload: {
            callId: "call-retried",
            sourcePid: pid,
            targetPid: "target-process",
            runId: "target-run",
            deadlineAt: Date.now() + 30_000,
            status: "completed",
            response: { text: "delivered once", usage: null },
          },
        } as const;

        await instance.recvFrame(frame as any);
        await instance.recvFrame(frame as any);

        expect(process.store.getMessages().filter((message: any) => (
          message.content.includes("delivered once")
        ))).toHaveLength(1);
        expect(process.scheduleTick).toHaveBeenCalledTimes(1);
        process.currentRun = null;
      });
    });

    it("queues an IPC reply for its source run instead of mutating a different active run", async () => {
      const pid = "mech-ipc-other-source-run";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        process.sendSignal = vi.fn();
        process.scheduleTick = vi.fn(async () => {});
        process.currentRun = { runId: "run-active", conversationId: "default" };

        await instance.recvFrame({
          type: "sig",
          signal: "ipc.reply",
          payload: {
            callId: "call-other-run",
            sourcePid: pid,
            sourceRunId: "run-waiting",
            targetPid: "target-process",
            runId: "target-run",
            deadlineAt: Date.now() + 30_000,
            status: "completed",
            response: { text: "delegated result for an older run", usage: null },
          },
        } as any);

        expect(process.store.getMessages()).toEqual([
          expect.objectContaining({
            role: "system",
            content: expect.stringContaining("delegated result for an older run"),
          }),
        ]);
        expect(process.currentRun).toMatchObject({
          runId: "run-active",
          conversationId: "default",
        });
        expect(process.currentRun).not.toHaveProperty("pendingRuntimeEvents");
        const queued = process.store.drainQueue("default");
        expect(queued).toHaveLength(1);
        expect(queued[0].message).toContain("Review the process event above");
        expect(process.sendSignal).toHaveBeenCalledWith(
          "proc.changed",
          expect.objectContaining({ changes: ["queue"] }),
        );
        expect(process.scheduleTick).not.toHaveBeenCalled();
        process.currentRun = null;
      });
    });

    it("defers the fallback wake run until a busy source run finishes", async () => {
      const sourcePid = "mech-ipc-busy-source";
      const targetPid = "mech-ipc-busy-target";
      const source = await initProcess(sourcePid, ROOT_IDENTITY);

      await runInDurableObject(source, (instance: Process) => {
        const process = instance as any;
        process.scheduleTick = vi.fn(async () => {});
        process.currentRun = {
          runId: "active-source-run",
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
        await process.finishRun("active-source-run", {
          reason: "turn.complete",
          status: "ok",
          text: "parent finished before reading the event",
        });
      });

      await runInDurableObject(source, (instance: Process) => {
        const process = instance as any;
        const userMessages = process.store.getMessages()
          .filter((message: any) => message.role === "user");
        expect(userMessages.at(-1)?.content).toContain("A runtime event arrived while you were busy.");
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
        process.store.register("dispatch_shell", "call_shell", "active-source-turn", "shell.exec", {
          input: "sleep 10",
          target: "gsv",
        });
        process.store.resolve("dispatch_shell", { ok: true, stdout: "done" });
        process.currentRun = {
          runId: "active-source-turn",
          conversationId: "default",
          config: {
            executor: { kind: "process", pid: sourcePid },
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

        await process.runTick("active-source-turn");

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
        (instance as any).scheduleTick = async () => {};
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
        await k.deliverIpcCall(data.callId);
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

    it("does not announce IPC work superseded while its tick is scheduled", async () => {
      const pid = "mech-ipc-stale-start";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        let releaseSchedule!: () => void;
        let markScheduleStarted!: () => void;
        const scheduleBlocked = new Promise<void>((resolve) => {
          releaseSchedule = resolve;
        });
        const scheduleStarted = new Promise<void>((resolve) => {
          markScheduleStarted = resolve;
        });
        process.sendSignal = vi.fn();
        process.scheduleTick = vi.fn(async (runId: string) => {
          if (runId === "ipc-run") {
            markScheduleStarted();
            await scheduleBlocked;
          }
        });

        const delivering = process.handleProcIpcDeliver({
          runId: "ipc-run",
          sourcePid: "source-process",
          source: ROOT_IDENTITY,
          message: "slow IPC admission",
          sentAt: Date.now(),
        });
        await scheduleStarted;

        const successor = await process.handleProcSend({
          message: "new user direction",
          origin: { kind: "client", connectionId: "client-1" },
        });
        releaseSchedule();
        await delivering;

        const startedRunIds = process.sendSignal.mock.calls
          .filter(([signal]: [string]) => signal === "proc.run.started")
          .map(([, payload]: [string, { runId: string }]) => payload.runId);
        expect(startedRunIds).toEqual([successor.runId]);
        expect(process.currentRun).toMatchObject({ runId: successor.runId });
        process.currentRun = null;
      });
    });

    it("keeps IPC admission behind earlier background sends", async () => {
      const stub = await initProcess("mech-ipc-admission-order", ROOT_IDENTITY);

      await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        process.scheduleTick = vi.fn(async () => {});
        process.sendSignal = vi.fn(async () => {});
        const releaseAdmission = await process.acquireQueuedSendAdmission();
        const delivering = process.handleProcIpcDeliver({
          runId: "ipc-ordered-run",
          sourcePid: "source-process",
          source: ROOT_IDENTITY,
          message: "ordered IPC",
          sentAt: Date.now(),
        });
        await Promise.resolve();
        expect(process.currentRun).toBeNull();

        releaseAdmission();
        await expect(delivering).resolves.toMatchObject({
          ok: true,
          runId: "ipc-ordered-run",
        });
        expect(process.currentRun).toMatchObject({ runId: "ipc-ordered-run" });
        process.currentRun = null;
      });
    });

    it("terminalizes IPC work when its first tick cannot be scheduled", async () => {
      const stub = await initProcess("mech-ipc-schedule-failure", ROOT_IDENTITY);

      await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        process.scheduleTick = vi.fn(async () => {
          throw new Error("scheduler unavailable");
        });
        process.sendSignal = vi.fn(async () => {});

        await expect(process.handleProcIpcDeliver({
          runId: "ipc-unscheduled-run",
          sourcePid: "source-process",
          source: ROOT_IDENTITY,
          message: "must not strand",
          sentAt: Date.now(),
        })).resolves.toMatchObject({ ok: true, runId: "ipc-unscheduled-run" });

        await vi.waitFor(() => expect(process.currentRun).toBeNull());
        expect(process.sendSignal).toHaveBeenCalledWith(
          "proc.run.finished",
          expect.objectContaining({
            runId: "ipc-unscheduled-run",
            status: "error",
            reason: "schedule.error",
          }),
        );
      });
    });

    it("queues delivered IPC when the target process is already running", async () => {
      const pid = "mech-ipc-queued";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      await runInDurableObject(stub, (instance: Process) => {
        const process = instance as any;
        process.scheduleTick = async () => {};
        process.currentRun = {
          runId: "active-run",
          conversationId: "default",
        };
      });

      const response = await stub.recvFrame(makeReq("proc.ipc.deliver", {
        runId: "queued-ipc-run",
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
        runId: "queued-ipc-run",
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
        process.scheduleTick = async () => {};
        store.openConversation({ conversationId: "side" });
        store.appendMessage("user", "side before reset", { conversationId: "side" });
        store.register("dispatch-side", "call-side", "run-side", "fs.read", { path: "/tmp/side.txt" }, "side");
        store.enqueue("run-side-next", "side queued", undefined, "side");
        store.enqueue("run-default-next", "default queued");
        process.currentRun = {
          runId: "run-side",
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
        archivedMessages: 2,
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

    it("deletes media released by an unarchived conversation reset", async () => {
      const pid = "mech-conversation-reset-media-cleanup";
      const stub = await initProcess(pid, ROOT_IDENTITY);
      const key = `var/media/0/${pid}/discard.bin`;
      await env.STORAGE.put(key, new Uint8Array([7, 8, 9]), {
        httpMetadata: { contentType: "application/octet-stream" },
        customMetadata: { uid: "0", gid: "0", mode: "400", processId: pid },
      });
      await runInDurableObject(stub, (instance: Process) => {
        const store = (instance as any).store;
        store.openConversation({ conversationId: "discard" });
        store.appendMessage("user", "discard attachment", {
          conversationId: "discard",
          media: JSON.stringify([{
            type: "document",
            mimeType: "application/octet-stream",
            key,
            path: `/${key}`,
          }]),
        });
      });

      const reset = await stub.recvFrame(makeReq("proc.conversation.reset", {
        conversationId: "discard",
        archive: false,
      })) as ResponseOkFrame;
      expect(reset.data).toMatchObject({ ok: true, archivedMessages: 1 });
      expect(await env.STORAGE.head(key)).toBeNull();
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
      const models: string[] = [];

      await runInDurableObject(stub, (instance: Process) => {
        const process = instance as any;
        const store = process.store;
        store.openConversation({ conversationId: "thread", title: "Thread" });
        store.appendMessage("user", "old user goal", { conversationId: "thread" });
        store.appendMessage("assistant", "old assistant decision", { conversationId: "thread" });
        store.appendMessage("user", "keep this", { conversationId: "thread" });
        process.currentRun = {
          runId: "config-source",
          conversationId: "other",
          config: {
            executor: { kind: "process", pid },
            profile: "task",
            provider: "workers-ai",
            model: "@cf/test/model",
            apiKey: "",
            reasoning: "off",
            maxTokens: 4096,
            fallbacks: [{
              provider: "openrouter",
              model: "fallback-model",
              apiKey: "fallback-key",
              maxTokens: 4096,
              contextWindowTokens: 32768,
              contextWindowSource: "config",
              generationTimeoutMs: 180000,
            }],
          },
        };
        process.generation = {
          async generate() {
            throw new Error("unexpected chat generation");
          },
          async generateText(request: any) {
            models.push(request.config.model);
            expect(request.options).toMatchObject({
              maxTokens: 768,
              reasoning: "off",
              timeoutMs: 30000,
            });
            expect(request.context.messages[0].content).toContain("old user goal");
            if (request.config.model === "@cf/test/model") {
              throw new Error("primary unavailable");
            }
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
      expect(models).toEqual(["@cf/test/model", "fallback-model"]);

      await runInDurableObject(stub, (instance: Process) => {
        const process = instance as any;
        const messages = process.store.getMessages({ conversationId: "thread" });
        expect(messages[0].content).toContain("Generated compact summary.");
        process.currentRun = null;
      });
    });

    it("builds bounded compaction input from complete JSON records", async () => {
      const pid = "mech-conversation-compact-jsonl";
      const stub = await initProcess(pid, ROOT_IDENTITY);
      let transcript = "";

      await runInDurableObject(stub, (instance: Process) => {
        const process = instance as any;
        const store = process.store;
        for (let index = 0; index < 5; index += 1) {
          store.appendMessage("user", `${index}:${"x".repeat(index === 0 ? 50_000 : 10_000)}`, {
            conversationId: "thread",
          });
        }
        store.appendMessage("user", "keep", { conversationId: "thread" });
        process.currentRun = {
          runId: "config-source",
          conversationId: "other",
          config: {
            executor: { kind: "process", pid },
            provider: "workers-ai",
            model: "@cf/test/model",
            apiKey: "",
            maxTokens: 4096,
          },
        };
        process.generation = {
          async generateText(request: any) {
            const content = request.context.messages[0].content as string;
            transcript = content
              .slice("Conversation segment JSONL:\n".length)
              .split("\n\nWrite the replacement summary", 1)[0];
            return "Summary.";
          },
        };
      });

      const response = await stub.recvFrame(makeReq("proc.conversation.compact", {
        conversationId: "thread",
        keepLast: 1,
        generateSummary: true,
      })) as ResponseOkFrame;
      expect(response.data).toMatchObject({ ok: true, archivedMessages: 5 });
      expect(transcript.length).toBeLessThanOrEqual(24_000);
      const records = transcript.split("\n").map((line) => JSON.parse(line));
      expect(records).toEqual(expect.arrayContaining([
        expect.objectContaining({ record_truncated: true }),
        expect.objectContaining({ omitted_messages: expect.any(Number) }),
      ]));

      await runInDurableObject(stub, (instance: Process) => {
        (instance as any).currentRun = null;
      });
    });

    it("discards a generated compaction when its conversation changes", async () => {
      const pid = "mech-conversation-compact-stale";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      await runInDurableObject(stub, (instance: Process) => {
        const process = instance as any;
        process.store.appendMessage("user", "old", { conversationId: "thread" });
        process.store.appendMessage("user", "keep", { conversationId: "thread" });
        process.currentRun = {
          runId: "config-source",
          conversationId: "other",
          config: {
            executor: { kind: "process", pid },
            provider: "workers-ai",
            model: "@cf/test/model",
            apiKey: "",
            maxTokens: 4096,
          },
        };
        process.generation = {
          async generateText() {
            process.store.resetConversation("thread");
            return "Stale summary.";
          },
        };
      });

      const archivesBefore = (await env.STORAGE.list({ prefix: "root/conversations/thread/" }))
        .objects.map((object) => object.key);
      const response = await stub.recvFrame(makeReq("proc.conversation.compact", {
        conversationId: "thread",
        keepLast: 1,
        generateSummary: true,
      })) as ResponseOkFrame;
      expect(response.data).toEqual({ ok: false, error: "Conversation changed during compaction" });
      expect((await env.STORAGE.list({ prefix: "root/conversations/thread/" }))
        .objects.map((object) => object.key)).toEqual(archivesBefore);
      await runInDurableObject(stub, (instance: Process) => {
        const process = instance as any;
        expect(process.store.listConversationSegments("thread")).toHaveLength(0);
        process.currentRun = null;
      });
    });

    it("rejects a concurrent compaction after another summary replaces its prefix", async () => {
      const pid = "mech-conversation-compact-concurrent";
      const stub = await initProcess(pid, ROOT_IDENTITY);
      const archivesBefore = (await env.STORAGE.list({ prefix: "root/conversations/thread/" }))
        .objects.map((object) => object.key);
      const result = await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        let generationCalls = 0;
        let releaseFirst!: () => void;
        let markFirstStarted!: () => void;
        const firstBlocked = new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        const firstStarted = new Promise<void>((resolve) => {
          markFirstStarted = resolve;
        });
        process.store.appendMessage("user", "old", { conversationId: "thread" });
        process.store.appendMessage("user", "keep", { conversationId: "thread" });
        process.currentRun = {
          runId: "config-source",
          conversationId: "other",
          config: {
            executor: { kind: "process", pid },
            provider: "workers-ai",
            model: "@cf/test/model",
            apiKey: "",
            maxTokens: 4096,
          },
        };
        process.generation = {
          async generateText() {
            generationCalls += 1;
            if (generationCalls === 1) {
              markFirstStarted();
              await firstBlocked;
              return "First summary.";
            }
            return "Second summary.";
          },
        };

        const first = process.recvFrame(makeReq("proc.conversation.compact", {
          conversationId: "thread",
          keepLast: 1,
          generateSummary: true,
        }));
        await firstStarted;
        const second = await process.recvFrame(makeReq("proc.conversation.compact", {
          conversationId: "thread",
          keepLast: 1,
          generateSummary: true,
        })) as ResponseOkFrame;
        releaseFirst();
        const stale = await first as ResponseOkFrame;
        const messages = process.store.getMessages({ conversationId: "thread" });
        const segments = process.store.listConversationSegments("thread");
        process.currentRun = null;
        return { second, stale, messages, segments };
      });

      expect(result.second.data).toMatchObject({ ok: true, archivedMessages: 1 });
      expect(result.stale.data).toEqual({ ok: false, error: "Conversation changed during compaction" });
      expect(result.messages[0].content).toContain("Second summary.");
      expect(result.segments).toHaveLength(1);
      expect((await env.STORAGE.list({ prefix: "root/conversations/thread/" })).objects
        .filter((object) => !archivesBefore.includes(object.key)))
        .toHaveLength(1);
    });

    it("rolls back the summary when recording its segment fails", async () => {
      const pid = "mech-conversation-compact-transaction";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      await runInDurableObject(stub, (instance: Process) => {
        const store = (instance as any).store;
        store.appendMessage("user", "old", { conversationId: "thread" });
        store.appendMessage("user", "keep", { conversationId: "thread" });
        store.recordConversationSegment = () => {
          throw new Error("segment insert failed");
        };
      });

      const archivesBefore = (await env.STORAGE.list({ prefix: "root/conversations/thread/" }))
        .objects.map((object) => object.key);
      const response = await stub.recvFrame(makeReq("proc.conversation.compact", {
        conversationId: "thread",
        keepLast: 1,
        summary: "Summary.",
      })) as ResponseFrame;
      expect(response).toMatchObject({
        ok: false,
        error: { message: "segment insert failed" },
      });
      expect((await env.STORAGE.list({ prefix: "root/conversations/thread/" }))
        .objects.map((object) => object.key)).toEqual(archivesBefore);
      await runInDurableObject(stub, (instance: Process) => {
        expect((instance as any).store.getMessages({ conversationId: "thread" }))
          .toEqual(expect.arrayContaining([
            expect.objectContaining({ role: "user", content: "old" }),
            expect.objectContaining({ role: "user", content: "keep" }),
          ]));
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
        store.appendToolResult("tool-1", "fs.read", "permission denied", true, "thread");
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
        messageCount: 3,
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
      expect((secondPageRes.data as any).truncated).toBe(true);

      const toolResultPageRes = (await stub.recvFrame(
        makeReq("proc.conversation.segment.read", {
          conversationId: "thread",
          segmentId: compactData.segment.id,
          limit: 1,
          offset: 2,
        }),
      )) as ResponseOkFrame;
      expect((toolResultPageRes.data as any).messages).toEqual([
        {
          id: expect.any(Number),
          role: "toolResult",
          content: {
            toolName: "Read",
            isError: true,
            outcome: "failed",
            toolCallId: "tool-1",
            output: "permission denied",
          },
          timestamp: expect.any(Number),
        },
      ]);
      expect((toolResultPageRes.data as any).truncated).toBe(false);
    });

    it("retains assistant media references when reading a compacted segment", async () => {
      const pid = "mech-conversation-segment-assistant-media";
      const stub = await initProcess(pid, ROOT_IDENTITY);
      const activeKey = `var/media/0/${pid}/result.png`;
      await env.STORAGE.put(activeKey, new Uint8Array([7, 8, 9]), {
        httpMetadata: { contentType: "image/png" },
        customMetadata: {
          uid: "0",
          gid: "0",
          mode: "400",
          processId: pid,
        },
      });
      await runInDurableObject(stub, (instance: Process) => {
        const store = (instance as any).store;
        store.openConversation({ conversationId: "thread", title: "Thread" });
        store.appendMessage("assistant", "Here is the result.", {
          conversationId: "thread",
          createdAt: 20,
          media: JSON.stringify([{
            type: "image",
            mimeType: "image/png",
            filename: "result.png",
            size: 3,
            key: activeKey,
            path: `/${activeKey}`,
          }]),
        });
        store.appendMessage("user", "keep this", {
          conversationId: "thread",
          createdAt: 30,
        });
      });

      const compactRes = await stub.recvFrame(makeReq("proc.conversation.compact", {
        conversationId: "thread",
        keepLast: 1,
        summary: "Earlier context.",
      })) as ResponseOkFrame;
      const segment = (compactRes.data as any).segment;
      const segmentRes = await stub.recvFrame(makeReq("proc.conversation.segment.read", {
        conversationId: "thread",
        segmentId: segment.id,
      })) as ResponseOkFrame;
      const media = (segmentRes.data as any).messages[0].content.media[0];

      expect((segmentRes.data as any).messages[0]).toMatchObject({
        role: "assistant",
        content: {
          text: "Here is the result.",
          thinking: [],
          toolCalls: [],
        },
        timestamp: 20,
      });
      expect(media).toMatchObject({
        type: "image",
        mimeType: "image/png",
        filename: "result.png",
        size: 3,
        key: expect.stringMatching(/^root\/\.gsv\/media\/archived-media:[0-9a-f]{64}$/),
      });
      expect(media.path).toBe(`/${media.key}`);
      expect(await env.STORAGE.head(activeKey)).toBeNull();

      const read = await stub.recvFrame(makeReq("proc.media.read", { key: media.key })) as ResponseOkFrame;
      expect(read.data).toMatchObject({ ok: true, key: media.key, path: media.path, size: 3 });
      expect(read.body && [...await bodyToBytes(read.body)]).toEqual([7, 8, 9]);
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
        store.appendToolResult("tool-1", "fs.read", "permission denied", true, "thread");
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
        restoredMessages: 4,
        includedLiveSuffix: true,
        targetConversation: {
          id: "thread-restored",
          title: "Restored thread",
          messageCount: 4,
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
          ["toolResult", "permission denied"],
          ["user", "keep this"],
        ]);
        expect(JSON.parse(restored[0].origin)).toEqual(archivedOrigin);
        expect(JSON.parse(restored[3].origin)).toEqual(liveOrigin);
        expect(store.toMessages({ conversationId: "thread-restored" })[2]).toMatchObject({
          role: "toolResult",
          toolCallId: "tool-1",
          toolName: "Read",
          isError: true,
        });

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

    it("cancels manual archive upload by request id", async () => {
      const pid = "mech-conversation-compact-cancel";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        let markStarted!: () => void;
        const started = new Promise<void>((resolve) => {
          markStarted = resolve;
        });
        process.store.appendMessage("user", "old", { conversationId: "thread" });
        process.store.appendMessage("user", "keep", { conversationId: "thread" });
        process.archiveMessageRecords = async (
          _key: string,
          _messages: unknown[],
          signal: AbortSignal,
        ) => {
          markStarted();
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        };

        const requestId = "compact-cancel-1";
        const execution = process.recvFrame({
          type: "req",
          id: requestId,
          call: "proc.conversation.compact",
          args: { conversationId: "thread", keepLast: 1, summary: "Summary." },
        });
        await started;
        await process.recvFrame({
          type: "sig",
          signal: REQUEST_CANCEL_SIGNAL,
          payload: { id: requestId, reason: "new user message" },
        });

        await expect(execution).resolves.toMatchObject({
          type: "res",
          id: requestId,
          ok: true,
          data: { ok: false, error: "Compaction was cancelled" },
        });
        expect(process.store.listConversationSegments("thread")).toHaveLength(0);
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

    it("auto-compacts once before falling back while the rebuilt context still fits", async () => {
      const pid = "mech-conversation-auto-compact";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      const emitted = await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        const emitted: Array<{ signal: string; payload: unknown }> = [];
        process.sendSignal = async (signal: string, payload: unknown) => {
          emitted.push({ signal, payload });
        };
        process.updateContextState = async () => ({ pressure: 0.95 });
        let generationCalls = 0;
        let summaryCalls = 0;
        process.generation = {
          async generate(request: any) {
            generationCalls += 1;
            const serialized = JSON.stringify(request.context);
            expect(serialized).toContain("Context that must stay live.");
            expect(serialized).toContain("Auto compact summary.");
            expect(serialized).not.toContain("old context A");
            if (generationCalls === 1) {
              return {
                role: "assistant",
                content: [],
                api: "test",
                provider: request.config.provider,
                model: request.config.model,
                stopReason: "error",
                errorMessage: "Custom provider HTTP 403: not authenticated",
                usage: testUsage(1, 0),
                timestamp: Date.now(),
              };
            }
            return {
              role: "assistant",
              content: [{ type: "text", text: "after compaction" }],
              api: "test",
              provider: request.config.provider,
              model: request.config.model,
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
            summaryCalls += 1;
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
          compactAtPressure: 0.9,
          keepLast: 1,
          updatedAt: Date.now(),
        }));
        process.currentRun = {
          runId: "run-auto-compact",
          conversationId: "default",
          config: {
            executor: { kind: "process", pid },
            profile: "task",
            provider: "workers-ai",
            model: "@cf/test/model",
            apiKey: "",
            reasoning: "off",
            maxTokens: 100,
            contextWindowTokens: 1000,
            contextWindowSource: "config",
            maxContextBytes: 32768,
            fallbacks: [{
              provider: "openrouter",
              model: "fallback-model",
              apiKey: "fallback-key",
              maxTokens: 100,
              contextWindowTokens: 1000,
              contextWindowSource: "config",
              generationTimeoutMs: 180000,
            }],
          },
          tools: [],
          devices: [],
          systemPrompt: "Test system prompt.",
          approvalPolicy: { default: "auto", rules: [] },
        };
        await process.runTick("run-auto-compact");
        return {
          emitted,
          generationCalls,
          summaryCalls,
          messages: process.store.getMessages(),
          segments: process.store.listConversationSegments(),
        };
      });

      expect(emitted.generationCalls).toBe(2);
      expect(emitted.summaryCalls).toBe(1);
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

    it("stops when the retained tail is still too large after auto-compaction", async () => {
      const pid = "mech-conversation-auto-compact-insufficient";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      const result = await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        const emitted: Array<{ signal: string; payload: unknown }> = [];
        let generated = false;
        process.sendSignal = async (signal: string, payload: unknown) => {
          emitted.push({ signal, payload });
        };
        process.generation = {
          async generate() {
            generated = true;
            throw new Error("chat generation should not run");
          },
          async generateText() {
            return "Compact summary.";
          },
        };
        process.store.appendMessage("user", "old context");
        process.store.appendMessage("user", `retained ${"x".repeat(4000)}`);
        process.store.setValue("conversationPolicy:default", JSON.stringify({
          conversationId: "default",
          overflow: "auto-compact",
          compactAtPressure: 0.5,
          keepLast: 1,
          updatedAt: Date.now(),
        }));
        process.currentRun = {
          runId: "run-auto-compact-insufficient",
          conversationId: "default",
          config: {
            executor: { kind: "process", pid },
            provider: "workers-ai",
            model: "@cf/test/model",
            apiKey: "",
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
        await process.runTick("run-auto-compact-insufficient");
        return {
          emitted,
          generated,
          currentRun: process.currentRun,
          messages: process.store.getMessages(),
          segments: process.store.listConversationSegments(),
        };
      });

      expect(result.generated).toBe(false);
      expect(result.currentRun).toBeNull();
      expect(result.segments).toHaveLength(1);
      expect(result.messages.at(-1)?.content).toContain(
        "Auto-compaction could not reduce this conversation below its context limit.",
      );
      expect(result.emitted).toEqual(expect.arrayContaining([
        {
          signal: "proc.run.finished",
          payload: expect.objectContaining({
            status: "error",
            reason: "context.auto_compact.insufficient",
          }),
        },
      ]));
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
          conversationId: "default",
          config: {
            executor: { kind: "process", pid },
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
        await process.runTick("run-auto-compact-provider-billing");
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
          async generate() {
            throw new Error("chat generation should not run after abort");
          },
          async generateText(request: any) {
            expect(request.options).toMatchObject({ maxTokens: 768, reasoning: "off" });
            await process.handleProcAbort({});
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
          conversationId: "default",
          config: {
            executor: { kind: "process", pid },
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
        await process.runTick("run-auto-compact-abort");
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

    it("does not let a stale abort cancel a successor run", async () => {
      const pid = "mech-abort-stale-run";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      await runInDurableObject(stub, (instance: Process) => {
        (instance as any).currentRun = { runId: "run-new", conversationId: "default" };
      });

      const res = (await stub.recvFrame(
        makeReq("proc.abort", { runId: "run-old" }),
      )) as ResponseOkFrame;

      expect(res.data).toMatchObject({ ok: true, pid, aborted: false });
      await runInDurableObject(stub, (instance: Process) => {
        const process = instance as any;
        expect(process.currentRun).toMatchObject({ runId: "run-new" });
        process.currentRun = null;
      });
    });

    it("promotes a queued successor without waiting for finish delivery", async () => {
      const pid = "mech-finish-claims-successor";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        process.emitRunFinished = vi.fn(() => new Promise<void>(() => {}));
        process.sendSignal = vi.fn();
        process.scheduleTick = vi.fn(async () => {});
        process.currentRun = { runId: "run-old", conversationId: "default" };
        process.store.enqueue("run-next", "next message");

        await process.finishRun("run-old", {
          reason: "turn.complete",
          status: "ok",
        });
        expect(process.currentRun).toMatchObject({ runId: "run-next" });
        expect(process.store.queueSize()).toBe(0);
        expect(process.scheduleTick).toHaveBeenCalledWith("run-next");

        expect(process.sendSignal).toHaveBeenCalledWith(
          "proc.run.started",
          expect.objectContaining({
            pid,
            runId: "run-next",
            conversationId: "default",
            reason: "queue.promote",
            queuedCount: 0,
            timestamp: expect.any(Number),
          }),
        );
        process.currentRun = null;
      });
    });

    it("keeps failed run-finish delivery in the durable outbox", async () => {
      const stub = await initProcess("mech-finish-outbox", ROOT_IDENTITY);

      await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        process.sendSignal = vi.fn(async () => {
          throw new Error("kernel unavailable");
        });
        process.schedule = vi.fn(async () => ({ id: "finish-retry" }));

        process.emitRunFinished(
          { runId: "run-finish-outbox", conversationId: "default" },
          { reason: "turn.complete", status: "ok", text: "done" },
        );
        await vi.waitFor(() => expect(process.schedule).toHaveBeenCalledWith(
          5,
          "onRunFinishDelivery",
          "run-finish-outbox",
          {
            idempotent: false,
            retry: { maxAttempts: 10, baseDelayMs: 1_000, maxDelayMs: 30_000 },
          },
        ));
        expect(JSON.parse(process.store.getValue("pendingRunFinishes"))).toHaveLength(1);

        process.sendSignal = vi.fn(async () => {});
        await process.onRunFinishDelivery("run-finish-outbox");
        expect(process.store.getValue("pendingRunFinishes")).toBeNull();
      });
    });

    it("stops terminal delivery after ten attempts and records an inspectable history note", async () => {
      const stub = await initProcess("mech-finish-outbox-exhausted", ROOT_IDENTITY);

      await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        process.store.setValue("pendingRunFinishes", JSON.stringify([{
          pid: process.pid,
          runId: "run-finish-exhausted",
          conversationId: "default",
          status: "ok",
          reason: "turn.complete",
          text: "completed answer",
          queuedCount: 0,
          timestamp: 1,
          deliveryAttempts: 9,
        }]));
        process.sendSignal = vi.fn(async () => {
          throw new Error("adapter transport remains unavailable");
        });
        process.schedule = vi.fn(async () => ({ id: "must-not-retry" }));
        process.emitProcChanged = vi.fn(async () => {});
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        await process.onRunFinishDelivery("run-finish-exhausted");

        expect(process.sendSignal).toHaveBeenCalledOnce();
        expect(process.schedule).not.toHaveBeenCalled();
        expect(process.store.getValue("pendingRunFinishes")).toBeNull();
        expect(process.store.getMessages()).toContainEqual(expect.objectContaining({
          role: "system",
          runId: "run-finish-exhausted",
          content: expect.stringContaining(
            "Automatic reply delivery stopped after repeated transport failures",
          ),
        }));
        expect(process.emitProcChanged).toHaveBeenCalledWith(
          ["messages"],
          expect.objectContaining({
            conversationId: "default",
            runId: "run-finish-exhausted",
            messageId: expect.any(Number),
          }),
        );
        warn.mockRestore();
      });
    });

    it("synthesizes interrupted tool results and continues the next queued run", async () => {
      const pid = "mech-abort-active";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      await runInDurableObject(stub, (instance: Process) => {
        const process = instance as any;
        process.store.appendMessage("assistant", "", {
          runId: "run-1",
          toolCalls: JSON.stringify([
            { type: "toolCall", id: "call-1", name: "Read", arguments: { path: "/root/test.txt" } },
            { type: "toolCall", id: "call-2", name: "Read", arguments: { path: "/root/other.txt" } },
          ]),
        });
        process.store.register("dispatch-1", "call-1", "run-1", "fs.read", { path: "/root/test.txt" });
        process.store.markDispatched("dispatch-1");
        process.store.register("dispatch-2", "call-2", "run-1", "fs.read", { path: "/root/other.txt" });
        process.store.enqueue("run-2", "follow-up after abort");
        process.currentRun = { runId: "run-1" };
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
        interruptedToolCalls: 2,
        continuedQueuedRunId: "run-2",
      });

      await runInDurableObject(stub, (instance: Process) => {
        const process = instance as any;
        const store = process.store;
        const messages = store.getMessages();
        const lastThree = messages.slice(-3);
        expect(lastThree.slice(0, 2).map((message: any) => message.role)).toEqual([
          "toolResult",
          "toolResult",
        ]);
        expect(lastThree[0].content).toContain("User interrupted tool execution");
        expect(lastThree[1].content).toContain("User interrupted tool execution");
        expect(JSON.parse(lastThree[0].toolCalls).outcome).toBe("cancelled");
        expect(JSON.parse(lastThree[1].toolCalls).outcome).toBe("cancelled");
        expect(lastThree[2].role).toBe("user");
        expect(lastThree[2].content).toBe("follow-up after abort");
        expect(store.queueSize()).toBe(0);
        expect(process.currentRun).toMatchObject({ runId: "run-2" });
      });
    });

    it("cancels pending tool, CodeMode, and provider requests", async () => {
      const pid = "mech-abort-cancels-requests";
      const stub = await initProcess(pid, ROOT_IDENTITY);
      const cancelSpy = vi
        .spyOn(Kernel.prototype as any, "cancelProcessRequests")
        .mockReturnValue(3);

      try {
        await runInDurableObject(stub, (instance: Process) => {
          const process = instance as any;
          process.currentRun = { runId: "run-1", conversationId: "default" };
          process.store.register(
            "dispatch-1",
            "call-1",
            "run-1",
            "fs.search",
            { query: "needle" },
          );
          process.store.markDispatched("dispatch-1");
          process.codeModeResponses.set("nested-1", {
            runId: "run-1",
            call: "net.fetch",
            args: {},
            resolve: vi.fn(),
            reject: vi.fn(),
            timeoutId: setTimeout(() => {}, 60_000),
          });
          const provider = new AbortController();
          process.runAbortControllers.set("run-1", provider);
          process.providerAbortSignal = provider.signal;
        });

        await stub.recvFrame(makeReq("proc.abort", {}));

        await vi.waitFor(() => expect(cancelSpy).toHaveBeenCalledWith(
          pid,
          expect.arrayContaining(["dispatch-1", "nested-1"]),
          "User interrupted tool execution",
        ));
        await runInDurableObject(stub, (instance: Process) => {
          const process = instance as any;
          expect(process.providerAbortSignal.reason).toEqual(
            new Error("User interrupted tool execution"),
          );
          expect(process.runAbortControllers.size).toBe(0);
        });
      } finally {
        cancelSpy.mockRestore();
      }
    });

    it("returns early and cancels a remote generation request", async () => {
      const pid = "mech-abort-remote-generation";
      const stub = await initProcess(pid, ROOT_IDENTITY);
      let releaseRequest!: () => void;
      const requestBlocked = new Promise<void>((resolve) => {
        releaseRequest = resolve;
      });
      const recvSpy = vi
        .spyOn(Kernel.prototype as any, "recvFrame")
        .mockImplementation(async (_processId: string, frame: RequestFrame) => {
          await requestBlocked;
          return { type: "res", id: frame.id, ok: true, data: {} };
        });
      const cancelSpy = vi
        .spyOn(Kernel.prototype as any, "cancelProcessRequests")
        .mockReturnValue(1);

      try {
        const result = await runInDurableObject(stub, async (instance: Process) => {
          const process = instance as any;
          const controller = new AbortController();
          const request = process.kernelRpc(
            "ai.text.generate",
            {},
            controller.signal,
          );
          controller.abort(new Error("User interrupted generation"));
          try {
            await request;
            return "resolved";
          } catch (error) {
            return error instanceof Error ? error.message : String(error);
          }
        });

        expect(result).toBe("User interrupted generation");
        await vi.waitFor(() => expect(cancelSpy).toHaveBeenCalledWith(
          pid,
          [expect.any(String)],
          "User interrupted generation",
        ));
      } finally {
        releaseRequest();
        recvSpy.mockRestore();
        cancelSpy.mockRestore();
      }
    });

    it("returns without waiting for request cancellation cleanup", async () => {
      const pid = "mech-abort-nonblocking-request-cancel";
      const stub = await initProcess(pid, ROOT_IDENTITY);
      await runInDurableObject(stub, (instance: Process) => {
        const process = instance as any;
        process.currentRun = { runId: "run-1", conversationId: "default" };
        process.store.register("dispatch-1", "call-1", "run-1", "fs.search", {});
        process.store.markDispatched("dispatch-1");
      });

      const cancelSpy = vi
        .spyOn(Kernel.prototype as any, "cancelProcessRequests")
        .mockImplementation(async function (this: Kernel) {
          const kernel = this as any;
          await new Promise<void>((resolve) => {
            kernel.releaseTestCancellation = resolve;
          });
          kernel.testCancellationFinished = true;
          return 1;
        });
      const kernel = await getKernelPtr();

      try {
        const response = await runInDurableObject(stub, async (instance: Process) => {
          return await (instance as any).recvFrame(makeReq("proc.abort", {}));
        }) as ResponseOkFrame;
        await vi.waitFor(() => expect(cancelSpy).toHaveBeenCalledOnce());
        expect(response.data).toMatchObject({ ok: true, aborted: true, runId: "run-1" });
      } finally {
        cancelSpy.mockRestore();
        const released = await runInDurableObject(kernel, (instance: Kernel) => {
          const release = (instance as any).releaseTestCancellation;
          if (typeof release !== "function") {
            return false;
          }
          release();
          return true;
        });
        if (released) {
          await vi.waitFor(async () => {
            const finished = await runInDurableObject(kernel, (instance: Kernel) => {
              return (instance as any).testCancellationFinished === true;
            });
            expect(finished).toBe(true);
          });
        }
      }
    });

    it("returns without waiting for run-finish delivery", async () => {
      const pid = "mech-abort-nonblocking-finish";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      const res = await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        process.currentRun = { runId: "run-1" };
        let releaseSignalDispatch!: () => void;
        const signalDispatchBlocked = new Promise<void>((resolve) => {
          releaseSignalDispatch = resolve;
        });
        const delivery = vi.fn(async () => {
          await signalDispatchBlocked;
        });
        process.onRunFinishDelivery = delivery;

        try {
          const response = await process.recvFrame(makeReq("proc.abort", {}));
          expect(delivery).toHaveBeenCalledOnce();
          return response;
        } finally {
          releaseSignalDispatch();
          for (const result of delivery.mock.results) {
            await result.value;
          }
        }
      }) as ResponseOkFrame;

      expect(res.ok).toBe(true);
      expect(res.data).toMatchObject({
        ok: true,
        pid,
        aborted: true,
        runId: "run-1",
      });
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
          approvalPolicy: {
            default: "auto",
            rules: [{ match: "fs.read", action: "ask" }],
          },
        };
        registerToolBlock(process, "run-hil-1", [
          { type: "toolCall", id: "call-hil-1", name: "Read", arguments: { path: "/root/secret.txt" } },
        ]);
        await process.processToolCalls("run-hil-1");
      });

      const history = (await stub.recvFrame(
        makeReq("proc.history", {}),
      )) as ResponseOkFrame;

      expect(history.ok).toBe(true);
      const data = history.data as any;
      expect(data.pendingHil).toMatchObject({
        pid,
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
          approvalPolicy: {
            default: "auto",
            rules: [{ match: "fs.read", action: "ask" }],
          },
        };
        process.scheduleTick = vi.fn(async () => {});
        registerToolBlock(process, "run-hil-2", [
          { type: "toolCall", id: "call-hil-2", name: "Read", arguments: { path: "/root/secret.txt" } },
        ]);
        await process.processToolCalls("run-hil-2");
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
        expect(process.store.getPendingHil()).toBeNull();
        expect(process.store.getResults("run-hil-2")).toMatchObject([{
          id: "call-hil-2",
          status: "error",
          error: "Tool execution denied by user",
          outcome: "denied",
        }]);
        process.ingestToolResults("run-hil-2", process.store.getResults("run-hil-2"));
        const toolResult = process.store.getMessages().at(-1);
        expect(toolResult.role).toBe("toolResult");
        expect(JSON.parse(toolResult.toolCalls).outcome).toBe("denied");
      });
    });

    it("classifies a denied CodeMode confirmation as a user-controlled outcome", async () => {
      const stub = await initProcess("mech-hil-codemode-deny", ROOT_IDENTITY);

      await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        const runId = "run-hil-codemode-deny";
        const requestId = "approval-codemode-deny";
        const resolve = vi.fn();
        process.currentRun = {
          runId,
          conversationId: "default",
          approvalPolicy: { default: "auto", rules: [] },
        };
        registerToolBlock(process, runId, [
          {
            id: "call-codemode-other",
            name: "CodeMode",
            arguments: { code: "return 'still running';" },
          },
          {
            id: "call-codemode-outer",
            name: "CodeMode",
            arguments: { code: "return await fs.read({ path: '/secret' });" },
          },
        ]);
        process.store.markDispatched("dispatch-call-codemode-other");
        process.store.markDispatched("dispatch-call-codemode-outer");
        process.store.setPendingHil({
          requestId,
          runId,
          conversationId: "default",
          toolCallId: "codemode-nested-call",
          toolName: "Read",
          syscall: "fs.read",
          args: { path: "/secret" },
          createdAt: Date.now(),
        });
        process.codeModeApprovals.set(requestId, {
          runId,
          dispatchId: "dispatch-call-codemode-outer",
          resolve,
          timeoutId: setTimeout(() => {}, 60_000),
        });

        await expect(process.handleProcHil({ requestId, decision: "deny" })).resolves.toMatchObject({
          ok: true,
          decision: "deny",
          resumed: true,
        });

        expect(resolve).toHaveBeenCalledWith(false);
        expect(process.store.getResults(runId)).toMatchObject([
          {
            id: "call-codemode-other",
            status: "pending",
            outcome: null,
          },
          {
            id: "call-codemode-outer",
            status: "error",
            error: "Tool execution denied by user",
            outcome: "denied",
          },
        ]);
        process.store.resolve("dispatch-call-codemode-other", {
          status: "completed",
          result: "still running",
        });
        process.ingestToolResults(runId, process.store.getResults(runId));
        const outcomes = process.store.getMessages()
          .filter((message: any) => message.role === "toolResult")
          .map((message: any) => JSON.parse(message.toolCalls).outcome);
        expect(outcomes).toEqual(["completed", "denied"]);
      });
    });

    it("does not infer a user denial from a live tool error message", async () => {
      const stub = await initProcess("mech-tool-error-denial-text", ROOT_IDENTITY);

      await runInDurableObject(stub, (instance: Process) => {
        const process = instance as any;
        const runId = "run-tool-error-denial-text";
        process.store.register(
          "dispatch-tool-error-denial-text",
          "call-tool-error-denial-text",
          runId,
          "fs.read",
          { path: "/provider" },
        );
        process.store.fail(
          "dispatch-tool-error-denial-text",
          "Tool execution denied by user",
        );

        expect(process.store.getResults(runId)[0].outcome).toBe("failed");
        process.ingestToolResults(runId, process.store.getResults(runId));
        const toolResult = process.store.getMessages().at(-1);
        expect(JSON.parse(toolResult.toolCalls).outcome).toBe("failed");
      });
    });

    it("remembers approved tool confirmations for the process", async () => {
      const pid = "mech-hil-remember";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      const requestId = await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        process.currentRun = {
          runId: "run-hil-remember",
          approvalPolicy: {
            default: "auto",
            rules: [{ match: "fs.read", action: "ask" }],
          },
        };
        registerToolBlock(process, "run-hil-remember", [
          { type: "toolCall", id: "call-hil-remember-1", name: "Read", arguments: { path: "/root/one.txt" } },
          { type: "toolCall", id: "call-hil-remember-2", name: "Read", arguments: { path: "/root/two.txt" } },
        ]);
        await process.processToolCalls("run-hil-remember");
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
            target: "gsv",
            action: "auto",
          },
        ]);
      });
    });

    it("terminalizes CodeMode approval state whose continuation was lost", async () => {
      const stub = await initProcess("mech-hil-codemode-recovery", ROOT_IDENTITY);

      await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        const runId = "run-hil-codemode-recovery";
        process.currentRun = {
          runId,
          conversationId: "default",
          approvalPolicy: { default: "auto", rules: [] },
        };
        registerToolBlock(process, runId, [
          {
            id: "call-codemode-other",
            name: "CodeMode",
            arguments: { code: "return 'still running';" },
          },
          {
            id: "call-codemode-outer",
            name: "CodeMode",
            arguments: { code: "return await fs.read({ path: '/lost' });" },
          },
        ]);
        process.store.markDispatched("dispatch-call-codemode-other");
        process.store.markDispatched("dispatch-call-codemode-outer");
        process.store.setPendingHil({
          requestId: "approval-lost",
          runId,
          conversationId: "default",
          ownerDispatchId: "dispatch-call-codemode-outer",
          toolCallId: "codemode-nested-call",
          toolName: "Read",
          syscall: "fs.read",
          args: { path: "/lost" },
          createdAt: Date.now(),
        });
        process.schedule = vi.fn(async () => ({ id: "recovery-tick" }));

        await expect(process.handleProcHil({
          requestId: "approval-lost",
          decision: "approve",
        })).resolves.toEqual({
          ok: false,
          error: "CodeMode execution was interrupted while waiting for tool approval",
        });

        expect(process.store.getPendingHil()).toBeNull();
        expect(process.store.getResults(runId)).toMatchObject([
          {
            id: "call-codemode-other",
            status: "pending",
          },
          {
            id: "call-codemode-outer",
            status: "error",
            error: "CodeMode execution was interrupted while waiting for tool approval",
          },
        ]);
        expect(process.schedule).toHaveBeenCalledWith(
          expect.any(Date),
          "tick",
          { runId, generation: 0 },
          { idempotent: true },
        );
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
        store.appendToolResult(
          "call-1",
          "fs.read",
          "file contents here",
          false,
          "default",
          "run-history-tool",
          "completed",
        );
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
        outcome: "completed",
        toolCallId: "call-1",
        output: "file contents here",
      });
    });

    it("normalizes legacy user-controlled tool outcomes", async () => {
      const pid = "mech-history-toolresult-legacy-outcomes";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      await runInDurableObject(stub, (instance: Process) => {
        const store = (instance as any).store;
        store.appendToolResult(
          "call-cancelled",
          "fs.read",
          "Error: User interrupted tool execution",
          true,
        );
        store.appendToolResult(
          "call-denied",
          "fs.write",
          "Error: Tool execution denied by user",
          true,
        );
      });

      const res = (await stub.recvFrame(
        makeReq("proc.history", {}),
      )) as ResponseOkFrame;

      expect(res.ok).toBe(true);
      const data = res.data as any;
      expect(data.messages.map((message: any) => message.content.outcome)).toEqual([
        "cancelled",
        "denied",
      ]);
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

    it("cancels a direct codemode.run and blocks later tool side effects", async () => {
      const pid = "mech-codemode-run-cancel";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        const calls: string[] = [];
        let markStarted!: () => void;
        let release!: () => void;
        const started = new Promise<void>((resolve) => {
          markStarted = resolve;
        });
        const blocked = new Promise<void>((resolve) => {
          release = resolve;
        });
        process.getCodeModeMcpToolBindings = async () => [];
        process.executeCodeModeSyscall = async (
          _context: unknown,
          call: string,
        ) => {
          calls.push(call);
          if (call === "shell.exec") {
            markStarted();
            await blocked;
            return { status: "completed", output: "", exitCode: 0 };
          }
          return { ok: true };
        };
        const requestId = "codemode-cancel-1";
        const execution = process.recvFrame({
          type: "req",
          id: requestId,
          call: "codemode.run",
          args: {
            code: [
              "try { await shell('wait'); } catch {}",
              "try { await fs.write({ path: '/tmp/too-late', content: 'bad' }); } catch {}",
              "return 'done';",
            ].join("\n"),
          },
        });

        await started;
        await process.recvFrame({
          type: "sig",
          signal: REQUEST_CANCEL_SIGNAL,
          payload: { id: requestId, reason: "new user message" },
        });
        const response = await execution;
        release();
        await new Promise((resolve) => setTimeout(resolve, 25));

        expect(response).toMatchObject({
          type: "res",
          id: requestId,
          ok: true,
          data: { status: "failed", error: "new user message" },
        });
        expect(calls).toEqual(["shell.exec"]);
      });
    });

    it("cancels a direct codemode.run when the process resets", async () => {
      const pid = "mech-codemode-run-reset";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        const calls: string[] = [];
        let markStarted!: () => void;
        let release!: () => void;
        const started = new Promise<void>((resolve) => {
          markStarted = resolve;
        });
        const blocked = new Promise<void>((resolve) => {
          release = resolve;
        });
        process.getCodeModeMcpToolBindings = async () => [];
        process.executeCodeModeSyscall = async (
          _context: unknown,
          call: string,
        ) => {
          calls.push(call);
          if (call === "shell.exec") {
            markStarted();
            await blocked;
            return { status: "completed", output: "", exitCode: 0 };
          }
          return { ok: true };
        };
        const execution = process.recvFrame({
          type: "req",
          id: "codemode-reset-1",
          call: "codemode.run",
          args: {
            code: [
              "try { await shell('wait'); } catch {}",
              "try { await fs.write({ path: '/tmp/too-late', content: 'bad' }); } catch {}",
              "return 'done';",
            ].join("\n"),
          },
        });

        await started;
        const reset = await process.recvFrame(makeReq("proc.reset", {}));
        const response = await execution;
        release();
        await new Promise((resolve) => setTimeout(resolve, 25));

        expect(reset).toMatchObject({ ok: true, data: { ok: true, pid } });
        expect(response).toMatchObject({
          ok: true,
          data: {
            status: "failed",
            error: "Process execution was reset: process.reset",
          },
        });
        expect(calls).toEqual(["shell.exec"]);
      });
    });

    it("gates CodeMode fetches through tool approval", async () => {
      const pid = "mech-codemode-fetch-approval";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        const approvals: Array<{ call: string; args: Record<string, unknown> }> = [];
        let dispatched = false;

        process.currentRun = {
          runId: "run-codemode-fetch-approval",
          conversationId: "default",
          approvalPolicy: {
            default: "auto",
            rules: [{ match: "net.fetch", action: "ask" }],
          },
        };
        process.waitForCodeModeApproval = async (
          _runId: string,
          _dispatchId: string,
          _toolCallId: string,
          _toolName: string,
          call: string,
          args: Record<string, unknown>,
        ) => {
          approvals.push({ call, args });
          return false;
        };
        process.dispatchCodeModeSyscall = async () => {
          dispatched = true;
          throw new Error("unexpected dispatch");
        };

        await expect(process.executeCodeModeSyscall(
          {
            runId: "run-codemode-fetch-approval",
            dispatchId: "dispatch-codemode-fetch-approval",
            approvalPolicy: process.currentRun.approvalPolicy,
            capabilities: ["net.fetch"],
          },
          "net.fetch",
          {
            url: "https://example.com/upload",
            method: "POST",
            headers: {},
            bodyBase64: btoa("secret"),
          },
        )).rejects.toThrow("Tool execution was not approved: net.fetch");

        expect(approvals).toEqual([
          {
            call: "net.fetch",
            args: {
              url: "https://example.com/upload",
              method: "POST",
              headers: {},
              bodyBase64: btoa("secret"),
            },
          },
        ]);
        expect(dispatched).toBe(false);
      });
    });

    it("rejects unavailable CodeMode syscalls before approval", async () => {
      const stub = await initProcess("mech-codemode-fetch-capability", ROOT_IDENTITY);

      await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        let requestedApproval = false;
        let dispatched = false;
        process.currentRun = {
          runId: "run-codemode-fetch-capability",
          conversationId: "default",
        };
        process.waitForCodeModeApproval = async () => {
          requestedApproval = true;
          return true;
        };
        process.dispatchCodeModeSyscall = async () => {
          dispatched = true;
        };

        await expect(process.executeCodeModeSyscall(
          {
            runId: "run-codemode-fetch-capability",
            dispatchId: "dispatch-codemode-fetch-capability",
            approvalPolicy: {
              default: "ask",
              rules: [],
            },
            capabilities: ["codemode.*"],
          },
          "net.fetch",
          { url: "https://example.com/" },
        )).rejects.toThrow("Permission denied: net.fetch");

        expect(requestedApproval).toBe(false);
        expect(dispatched).toBe(false);
      });
    });

    it("ignores a nested CodeMode result after the run stops", async () => {
      const pid = "mech-codemode-fetch-stopped-after-fetch";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        let stopChecks = 0;

        process.currentRun = {
          runId: "run-codemode-fetch-stopped-after-fetch",
          conversationId: "default",
          config: { capabilities: ["codemode.*", "net.fetch"] },
          approvalPolicy: {
            default: "auto",
            rules: [],
          },
        };
        process.handleRunStopped = () => {
          stopChecks += 1;
          return stopChecks >= 3;
        };
        process.dispatchCodeModeSyscall = async () => ({
          type: "res",
          id: "codemode-result",
          ok: true,
          data: { status: 200 },
        });

        await expect(process.executeCodeModeSyscall(
          {
            runId: "run-codemode-fetch-stopped-after-fetch",
            dispatchId: "dispatch-codemode-fetch-stopped-after-fetch",
            approvalPolicy: process.currentRun.approvalPolicy,
            capabilities: ["net.fetch"],
          },
          "net.fetch",
          {
            url: "https://example.com/",
            method: "GET",
            headers: {},
          },
        )).rejects.toThrow("Run stopped before CodeMode tool execution completed");
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
        const result = await process.handleCodeModeRun({
          code: "const response = await fetch('https://example.com/'); return response.status;",
        });

        expect(result).toMatchObject({
          status: "failed",
          error: expect.stringContaining("Permission denied: net.fetch"),
        });
      });
    });

    it("dispatches CodeMode through the process-local executor path", async () => {
      const pid = "mech-codemode-basic";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;

        process.currentRun = {
          runId: "run-codemode-basic",
          approvalPolicy: { default: "auto", rules: [] },
        };
        process.sendSignal = async () => {};
        process.executeCodeModeTool = async (
          runId: string,
          dispatchId: string,
          args: { code: string },
        ) => {
          expect(runId).toBe("run-codemode-basic");
          expect(dispatchId).toBe("dispatch-call-codemode-1");
          expect(args.code).toContain("fs.read");
          process.store.resolve(dispatchId, {
            status: "completed",
            result: "from codemode",
          });
        };

        registerToolBlock(process, "run-codemode-basic", [
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
        await process.processToolCalls("run-codemode-basic");

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

    it("classifies a failed CodeMode result as a genuine tool failure", async () => {
      const stub = await initProcess("mech-codemode-failed-outcome", ROOT_IDENTITY);

      await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        const runId = "run-codemode-failed-outcome";
        const dispatchId = "dispatch-call-codemode-failed";
        process.currentRun = {
          runId,
          conversationId: "default",
          approvalPolicy: { default: "auto", rules: [] },
        };
        registerToolBlock(process, runId, [{
          type: "toolCall",
          id: "call-codemode-failed",
          name: "CodeMode",
          arguments: { code: "" },
        }]);
        process.store.markDispatched(dispatchId);

        await process.executeCodeModeTool(
          runId,
          dispatchId,
          { code: "" },
          process.currentRun.approvalPolicy,
        );

        expect(process.store.getResults(runId)).toMatchObject([{
          status: "completed",
          result: {
            status: "failed",
            error: "CodeMode requires a non-empty code string",
          },
          outcome: "failed",
        }]);
        process.ingestToolResults(runId, process.store.getResults(runId));
        const toolResult = process.store.getMessages().at(-1);
        expect(JSON.parse(toolResult.toolCalls)).toMatchObject({
          isError: true,
          outcome: "failed",
        });
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
        store.setValue("currentRun", JSON.stringify({ runId }));
        store.register("dispatch-reset-1", "call-reset-1", runId, "fs.read", { path: "/tmp/test.txt" });
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

    it("fences an in-flight generation before archiving reset history", async () => {
      const pid = "mech-reset-fences-generation";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        let releaseGeneration!: () => void;
        let markGenerationStarted!: () => void;
        let releaseArchive!: () => void;
        let markArchiveStarted!: () => void;
        const generationBlocked = new Promise<void>((resolve) => {
          releaseGeneration = resolve;
        });
        const generationStarted = new Promise<void>((resolve) => {
          markGenerationStarted = resolve;
        });
        const archiveBlocked = new Promise<void>((resolve) => {
          releaseArchive = resolve;
        });
        const archiveStarted = new Promise<void>((resolve) => {
          markArchiveStarted = resolve;
        });
        process.sendSignal = vi.fn();
        process.generation = {
          async generate() {
            markGenerationStarted();
            await generationBlocked;
            return {
              role: "assistant",
              content: [{ type: "text", text: "late reset response" }],
              api: "test",
              provider: "test",
              model: "test",
              usage: testUsage(),
              stopReason: "stop",
              timestamp: Date.now(),
            };
          },
          async generateText() {
            return "";
          },
        };
        process.archiveAllConversationMessages = vi.fn(async () => {
          markArchiveStarted();
          await archiveBlocked;
          return { archivedMessages: 1, archivedTo: "/archive/", archives: [] };
        });
        process.store.appendMessage("user", "reset while generating", {
          runId: "run-reset-fence",
        });
        process.currentRun = {
          runId: "run-reset-fence",
          conversationId: "default",
          config: {
            executor: { kind: "process", pid },
            profile: "task",
            provider: "test",
            model: "test",
            apiKey: "",
            reasoning: "off",
            maxTokens: 8192,
            contextWindowTokens: 128000,
            contextWindowSource: "config",
            maxContextBytes: 32768,
            generationStreaming: "off",
          },
          tools: [],
          devices: [],
          mcpServers: [],
          systemPrompt: "Test system prompt.",
          approvalPolicy: { default: "auto", rules: [] },
        };

        const ticking = process.runTick("run-reset-fence");
        await generationStarted;
        const resetting = process.handleProcReset();
        await archiveStarted;
        expect(process.currentRun).toBeNull();

        releaseGeneration();
        await ticking;
        expect(process.store.getMessages().some((message: any) => (
          message.content === "late reset response"
        ))).toBe(false);

        releaseArchive();
        await resetting;
        expect(process.store.getMessages()).toEqual([]);
      });
    });
  });

  describe("proc.kill", () => {
    it("rehomes archived media so a fresh executor can hydrate and read it", async () => {
      const pid = "mech-kill-archive-media";
      const stub = await initProcess(pid, ROOT_IDENTITY);
      const activeKey = `var/media/0/${pid}/proof.png`;
      await env.STORAGE.put(activeKey, new Uint8Array([1, 2, 3]), {
        httpMetadata: { contentType: "image/png" },
        customMetadata: {
          uid: "0",
          gid: "0",
          mode: "400",
          processId: pid,
        },
      });
      await runInDurableObject(stub, (instance: Process) => {
        (instance as any).store.appendMessage("user", "Keep this image.", {
          media: JSON.stringify([{
            type: "image",
            mimeType: "image/png",
            filename: "proof.png",
            size: 3,
            key: activeKey,
            path: `/${activeKey}`,
          }]),
        });
      });

      const killed = await stub.recvFrame(makeReq("proc.kill", {})) as ResponseOkFrame;
      const archive = (killed.data as any).archives.find((item: any) => (
        item.conversationId === "default"
      ));
      expect(archive).toBeTruthy();
      expect(await env.STORAGE.head(activeKey)).toBeNull();

      const resumedPid = "mech-resume-archive-media";
      const resumed = await getProcessByPid(resumedPid);
      const initialized = await resumed.recvFrame(makeReq("proc.setidentity", {
        pid: resumedPid,
        identity: ROOT_IDENTITY,
        profile: DEFAULT_PROFILE,
        hydrateFrom: archive.path,
      })) as ResponseOkFrame;
      expect(initialized.ok).toBe(true);

      const history = await resumed.recvFrame(makeReq("proc.history", {})) as ResponseOkFrame;
      const media = (history.data as any).messages[0].content.media[0];
      expect(media).toMatchObject({
        filename: "proof.png",
        key: expect.stringMatching(/^root\/\.gsv\/media\/archived-media:[0-9a-f]{64}$/),
      });
      expect(media.path).toBe(`/${media.key}`);

      const read = await resumed.recvFrame(makeReq("proc.media.read", { key: media.key })) as ResponseOkFrame;
      expect(read.data).toMatchObject({ ok: true, key: media.key, path: media.path, size: 3 });
      expect(read.body && [...await bodyToBytes(read.body)]).toEqual([1, 2, 3]);

      await env.STORAGE.delete([archive.path.replace(/^\//, ""), media.key]);
      await resumed.recvFrame(makeReq("proc.kill", { archive: false }));
    });

    it("can dispose an executor whose identity initialization never completed", async () => {
      const pid = "mech-kill-uninitialized";
      const stub = await getProcessByPid(pid);

      const killed = await stub.recvFrame(makeReq("proc.kill", { pid, archive: false }));
      expect(killed).toMatchObject({
        ok: true,
        data: { ok: true, pid, archivedMessages: 0, archives: [] },
      });
      await expect(stub.recvFrame(
        makeReq("proc.setidentity", { pid, identity: ROOT_IDENTITY }),
      )).resolves.toMatchObject({
        ok: false,
        error: { code: 410 },
      });
    });

    it("does not tear down an active executor when run-finish delivery fails", async () => {
      const pid = "mech-kill-finish-failure";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        process.currentRun = { runId: "run-kill-failure", conversationId: "default" };
        process.sendSignal = vi.fn(async () => {
          throw new Error("finish route unavailable");
        });

        const response = await process.recvFrame(makeReq("proc.kill", { archive: false }));
        expect(response).toMatchObject({
          ok: false,
          error: { message: "finish route unavailable" },
        });
        expect(process.isInitialized()).toBe(true);
        expect(process.currentRun).toMatchObject({ runId: "run-kill-failure" });
      });
    });

    it("finishes the active run and leaves the executor empty and dead", async () => {
      const pid = "mech-kill-runtime";
      const stub = await initProcess(pid, ROOT_IDENTITY);
      const runId = "run-kill-runtime";

      const killed = await runInDurableObject(stub, async (instance: Process, state) => {
        const process = instance as any;
        const emitted: Array<{ signal: string; payload: unknown }> = [];
        process.sendSignal = vi.fn(async (signal: string, payload: unknown) => {
          emitted.push({ signal, payload });
        });
        process.currentRun = { runId, conversationId: "default" };
        process.store.register(
          "dispatch-kill-1",
          "call-kill-1",
          runId,
          "fs.read",
          { path: "/tmp/test.txt" },
        );
        process.store.enqueue("queued-kill", "queued before kill");
        process.store.appendMessage("user", "hello before kill");
        await state.storage.setAlarm(Date.now() + 60_000);

        const response = await process.recvFrame(
          makeReq("proc.kill", { archive: false }),
        );
        const tables = state.storage.sql.exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table'",
        ).toArray().map((row) => row.name);
        return {
          response,
          emitted,
          alarm: await state.storage.getAlarm(),
          tables,
          keys: [...(await state.storage.list()).keys()],
        };
      });

      expect(killed.response).toMatchObject({
        ok: true,
        data: {
          ok: true,
          pid,
          archivedMessages: 0,
          archives: [],
        },
      });
      expect(killed.emitted).toContainEqual({
        signal: "proc.run.finished",
        payload: expect.objectContaining({
          pid,
          runId,
          status: "aborted",
          reason: "process.kill",
          aborted: true,
          queuedCount: 0,
        }),
      });
      expect(killed.alarm).toBeNull();
      expect(killed.keys).toEqual([]);
      expect(killed.tables).not.toEqual(expect.arrayContaining([
        "conversations",
        "messages",
        "process_kv",
      ]));

      const reuse = await stub.recvFrame(
        makeReq("proc.setidentity", { pid, identity: ROOT_IDENTITY }),
      );
      expect(reuse).toMatchObject({
        ok: false,
        error: { code: 410, message: "Process no longer exists" },
      });
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

    });
  });

  describe("schema upgrades", () => {
    it("terminalizes provider HIL calls without inventing nested CodeMode results", async () => {
      const stub = await initProcess("mech-upgrade-v3-hil", ROOT_IDENTITY);

      await runInDurableObject(stub, (instance: Process) => {
        const sql = (instance as any).ctx.storage.sql as SqlStorage;
        const legacyToolTable = PROCESS_V001_INITIAL_SCHEMA.statements.find((statement) => (
          statement.includes("CREATE TABLE IF NOT EXISTS pending_tool_calls")
        ));
        const legacyHilTable = PROCESS_V001_INITIAL_SCHEMA.statements.find((statement) => (
          statement.includes("CREATE TABLE IF NOT EXISTS pending_hil")
        ));
        expect(legacyToolTable).toBeTruthy();
        expect(legacyHilTable).toBeTruthy();

        sql.exec("DROP TABLE pending_tool_calls");
        sql.exec("DROP TABLE pending_hil");
        sql.exec(legacyToolTable!);
        sql.exec(legacyHilTable!);
        sql.exec(
          `INSERT INTO pending_hil (
            request_id, run_id, conversation_id, generation, tool_call_id, tool_name,
            syscall, args_json, remaining_tool_calls_json, created_at
          ) VALUES (?, ?, 'default', 1, ?, 'Read', 'fs.read', ?, ?, 100)`,
          "request-upgrade",
          "run-upgrade",
          "call-current",
          JSON.stringify({ path: "/current" }),
          JSON.stringify([
            { type: "toolCall", id: "call-next", name: "Read", arguments: { path: "/next" } },
          ]),
        );
        sql.exec(
          `INSERT INTO pending_tool_calls (
            id, run_id, conversation_id, generation, call, args_json, status, created_at
          ) VALUES (?, ?, 'default', 1, 'codemode.exec', '{}', 'pending', 200)`,
          "call-codemode-outer",
          "run-codemode-upgrade",
        );
        sql.exec(
          `INSERT INTO pending_hil (
            request_id, run_id, conversation_id, generation, tool_call_id, tool_name,
            syscall, args_json, remaining_tool_calls_json, created_at
          ) VALUES (?, ?, 'default', 1, ?, 'Read', 'fs.read', ?, '[]', 201)`,
          "request-codemode-upgrade",
          "run-codemode-upgrade",
          "codemode-nested-call",
          JSON.stringify({ path: "/nested" }),
        );

        for (const statement of PROCESS_V004_PENDING_TOOL_DISPATCH_ID.statements) {
          sql.exec(statement);
        }

        const tools = sql.exec<{
          id: string;
          call: string;
          args_json: string;
          status: string;
          error: string;
        }>(
          `SELECT id, call, args_json, status, error
             FROM pending_tool_calls
            ORDER BY created_at ASC`,
        ).toArray();
        expect(tools).toEqual([
          {
            id: "call-current",
            call: "fs.read",
            args_json: JSON.stringify({ path: "/current" }),
            status: "error",
            error: "Tool approval interrupted by the 0.4 upgrade",
          },
          {
            id: "call-next",
            call: "Read",
            args_json: JSON.stringify({ path: "/next" }),
            status: "error",
            error: "Tool approval interrupted by the 0.4 upgrade",
          },
          {
            id: "call-codemode-outer",
            call: "codemode.exec",
            args_json: "{}",
            status: "error",
            error: "Tool execution interrupted by the 0.4 upgrade",
          },
        ]);
        expect(sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM pending_hil")
          .toArray()[0]?.count).toBe(0);
        expect(sql.exec<{ name: string }>("PRAGMA table_info(pending_hil)").toArray()
          .map((column) => column.name)).not.toContain("remaining_tool_calls_json");
      });
    });

    it("backfills terminal tool outcomes when upgrading from v4", async () => {
      const stub = await initProcess("mech-upgrade-v4-outcomes", ROOT_IDENTITY);

      await runInDurableObject(stub, (instance: Process) => {
        const sql = (instance as any).ctx.storage.sql as SqlStorage;
        sql.exec("ALTER TABLE pending_tool_calls DROP COLUMN outcome");
        const rows = [
          ["completed", JSON.stringify({ status: "completed" }), null, "completed"],
          ["failed-envelope", JSON.stringify({ status: "failed" }), null, "completed"],
          ["denied", null, "Tool execution denied by user", "error"],
          ["failed-error", null, "provider failure", "error"],
        ] as const;
        rows.forEach(([id, result, error, status], index) => {
          sql.exec(
            `INSERT INTO pending_tool_calls (
              dispatch_id, id, run_id, conversation_id, call, args_json,
              result_json, error, status, created_at
            ) VALUES (?, ?, 'run-upgrade-outcomes', 'default', 'fs.read', '{}', ?, ?, ?, ?)`,
            `dispatch-${id}`,
            id,
            result,
            error,
            status,
            index,
          );
        });

        for (const statement of PROCESS_V005_TOOL_RESULT_OUTCOME.statements) {
          sql.exec(statement);
        }

        expect(sql.exec<{ id: string; outcome: string }>(
          "SELECT id, outcome FROM pending_tool_calls ORDER BY created_at ASC",
        ).toArray()).toEqual([
          { id: "completed", outcome: "completed" },
          { id: "failed-envelope", outcome: "failed" },
          { id: "denied", outcome: "denied" },
          { id: "failed-error", outcome: "failed" },
        ]);
      });
    });

    it("recovers only unambiguous CodeMode approval owners when upgrading from v5", async () => {
      const stub = await initProcess("mech-upgrade-v5-hil-owner", ROOT_IDENTITY);

      await runInDurableObject(stub, (instance: Process) => {
        const sql = (instance as any).ctx.storage.sql as SqlStorage;
        sql.exec("ALTER TABLE pending_hil DROP COLUMN owner_dispatch_id");
        const insertTool = (
          dispatchId: string,
          id: string,
          runId: string,
          call: string,
          status: string,
          createdAt: number,
        ) => sql.exec(
          `INSERT INTO pending_tool_calls (
            dispatch_id, id, run_id, conversation_id, call, args_json,
            status, created_at
          ) VALUES (?, ?, ?, 'default', ?, '{}', ?, ?)`,
          dispatchId,
          id,
          runId,
          call,
          status,
          createdAt,
        );
        const insertHil = (requestId: string, runId: string, toolCallId: string) => sql.exec(
          `INSERT INTO pending_hil (
            request_id, run_id, conversation_id, tool_call_id, tool_name,
            syscall, args_json, created_at
          ) VALUES (?, ?, 'default', ?, 'Read', 'fs.read', '{}', 1)`,
          requestId,
          runId,
          toolCallId,
        );

        insertTool("dispatch-direct", "call-direct", "run-direct", "fs.read", "registered", 1);
        insertHil("hil-direct", "run-direct", "call-direct");
        insertTool("dispatch-single", "call-single", "run-single", "codemode.exec", "pending", 2);
        insertHil("hil-single", "run-single", "nested-single");
        insertTool("dispatch-multi-a", "call-multi-a", "run-multi", "codemode.exec", "pending", 3);
        insertTool("dispatch-multi-b", "call-multi-b", "run-multi", "codemode.exec", "pending", 4);
        insertHil("hil-multi", "run-multi", "nested-multi");

        for (const statement of PROCESS_V006_PENDING_HIL_OWNER.statements) {
          sql.exec(statement);
        }

        expect(sql.exec<{ request_id: string; owner_dispatch_id: string | null }>(
          "SELECT request_id, owner_dispatch_id FROM pending_hil ORDER BY request_id ASC",
        ).toArray()).toEqual([
          { request_id: "hil-direct", owner_dispatch_id: null },
          { request_id: "hil-single", owner_dispatch_id: "dispatch-single" },
        ]);
        expect(sql.exec<{ id: string; status: string; outcome: string | null }>(
          `SELECT id, status, outcome
             FROM pending_tool_calls
            WHERE run_id = 'run-multi'
            ORDER BY created_at ASC`,
        ).toArray()).toEqual([
          { id: "call-multi-a", status: "error", outcome: "failed" },
          { id: "call-multi-b", status: "error", outcome: "failed" },
        ]);
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
    it("fails a dispatched tool when its durable deadline expires", async () => {
      const pid = "mech-res-tool-timeout";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        process.scheduleTick = vi.fn(async () => {});
        process.store.register(
          "dispatch-timeout",
          "call-timeout",
          "run-timeout",
          "fs.read",
          { path: "/slow" },
          "default",
        );
        process.store.markDispatched("dispatch-timeout");
        process.currentRun = { runId: "run-timeout", conversationId: "default" };

        await process.onToolDispatchTimeout({
          runId: "run-timeout",
          dispatchId: "dispatch-timeout",
        });

        expect(process.store.getResults("run-timeout")).toMatchObject([{
          id: "call-timeout",
          status: "error",
          error: expect.stringContaining("Tool execution timed out"),
        }]);
        expect(process.scheduleTick).toHaveBeenCalledWith("run-timeout");
        process.store.clearPendingToolCalls();
        process.currentRun = null;
      });
    });

    it("fails a run whose media preparation watchdog expires", async () => {
      const pid = "mech-res-media-timeout";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        process.sendSignal = vi.fn();
        const messageId = process.store.appendMessage("user", "slow attachment", {
          runId: "run-media-timeout",
        });
        process.currentRun = {
          runId: "run-media-timeout",
          conversationId: "default",
          pendingMediaMessageId: messageId,
        };
        const signal = process.runAbortSignal("run-media-timeout");

        await process.onMediaPreparationTimeout("run-media-timeout");

        expect(signal.aborted).toBe(true);
        expect(process.currentRun).toBeNull();
        expect(process.store.getMessages()).toEqual(expect.arrayContaining([
          expect.objectContaining({
            role: "system",
            runId: "run-media-timeout",
            content: expect.stringContaining("media preparation timed out"),
          }),
        ]));
        expect(process.sendSignal).toHaveBeenCalledWith(
          "proc.run.finished",
          expect.objectContaining({
            runId: "run-media-timeout",
            status: "error",
            reason: "media.timeout",
          }),
        );
      });
    });

    it("coalesces simultaneous tool timeouts into one continuation tick", async () => {
      const pid = "mech-res-coalesced-tool-timeouts";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        process.schedule = vi.fn();
        process.currentRun = { runId: "run-timeouts", conversationId: "default" };
        for (const dispatchId of ["dispatch-a", "dispatch-b"]) {
          process.store.register(dispatchId, dispatchId, "run-timeouts", "fs.read", {});
          process.store.markDispatched(dispatchId);
        }

        await Promise.all([
          process.onToolDispatchTimeout({ runId: "run-timeouts", dispatchId: "dispatch-a" }),
          process.onToolDispatchTimeout({ runId: "run-timeouts", dispatchId: "dispatch-b" }),
        ]);

        expect(process.store.getResults("run-timeouts").map((result: any) => result.status))
          .toEqual(["error", "error"]);
        expect(process.schedule).toHaveBeenCalledTimes(1);
        expect(process.schedule).toHaveBeenCalledWith(
          expect.any(Date),
          "tick",
          { runId: "run-timeouts", generation: 0 },
          { idempotent: true },
        );
        process.store.clearPendingToolCalls();
        process.currentRun = null;
      });
    });

    it("fails a tool without dispatching when its watchdog cannot be scheduled", async () => {
      const pid = "mech-res-tool-timeout-schedule-failure";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        process.sendSignal = vi.fn();
        process.schedule = vi.fn(async () => {
          throw new Error("scheduler unavailable");
        });
        process.dispatchSyscall = vi.fn();
        process.currentRun = {
          runId: "run-timeout-schedule-failure",
          conversationId: "default",
          approvalPolicy: { default: "auto", rules: [] },
        };
        registerToolBlock(process, "run-timeout-schedule-failure", [
          { id: "call-timeout-schedule-failure", name: "Read", arguments: { path: "/slow" } },
        ]);

        await process.processToolCalls("run-timeout-schedule-failure");

        expect(process.dispatchSyscall).not.toHaveBeenCalled();
        expect(process.store.getResults("run-timeout-schedule-failure")).toMatchObject([{
          id: "call-timeout-schedule-failure",
          status: "error",
          error: "Failed to schedule tool timeout: scheduler unavailable",
        }]);
        process.store.clearPendingToolCalls();
        process.currentRun = null;
      });
    });

    it("admits public user takeover while a shell syscall is still running", async () => {
      const pid = "mech-res-direct-after-takeover";
      const stub = await initProcess(pid, ROOT_IDENTITY);
      const originalRecvFrame = Kernel.prototype.recvFrame;
      let releaseResponse: (() => void) | undefined;
      let markRequestStarted!: () => void;
      let oldDispatchId = "";
      const responseBlocked = new Promise<void>((resolve) => {
        releaseResponse = resolve;
      });
      const requestStarted = new Promise<void>((resolve) => {
        markRequestStarted = resolve;
      });
      const recvSpy = vi.spyOn(Kernel.prototype as any, "recvFrame").mockImplementation(
        async function (this: Kernel, processId: string, frame: any) {
          if (
            frame?.type === "req"
            && frame.call === "shell.exec"
            && frame.args?.input === "sleep 300"
          ) {
            oldDispatchId = frame.id;
            markRequestStarted();
            await responseBlocked;
            return {
              type: "res",
              id: frame.id,
              ok: true,
              data: { status: "running", output: "", sessionId: "sh_late" },
            } as ResponseFrame;
          }
          return originalRecvFrame.call(this, processId, frame);
        },
      );

      try {
        await runInDurableObject(stub, async (instance: Process) => {
          const process = instance as any;
          process.sendSignal = vi.fn();
          process.generation = {
            async generate() {
              return {
                role: "assistant",
                content: [{
                  type: "toolCall",
                  id: "call-direct-old",
                  name: "Shell",
                  arguments: { input: "sleep 300", target: "gsv" },
                }],
                api: "test",
                provider: "test",
                model: "test",
                usage: testUsage(),
                stopReason: "toolUse",
                timestamp: Date.now(),
              };
            },
            async generateText() {
              return "";
            },
          };
          process.store.appendMessage("user", "run the long command", {
            runId: "run-direct-old",
          });
          process.currentRun = {
            runId: "run-direct-old",
            conversationId: "default",
            config: {
              executor: { kind: "process", pid },
              profile: "task",
              provider: "test",
              model: "test",
              apiKey: "",
              reasoning: "off",
              maxTokens: 8192,
              contextWindowTokens: 128000,
              contextWindowSource: "config",
              maxContextBytes: 32768,
              generationStreaming: "off",
            },
            tools: [],
            devices: [],
            mcpServers: [],
            systemPrompt: "Test system prompt.",
            approvalPolicy: { default: "auto", rules: [] },
          };

          const ticking = process.tick({ runId: "run-direct-old", generation: 0 });
          await requestStarted;
          const response = await Promise.race([
            instance.recvFrame(makeReq("proc.send", {
              message: "stop waiting",
              origin: { kind: "client", connectionId: "client-1" },
            })),
            new Promise<never>((_resolve, reject) => {
              setTimeout(() => reject(new Error("proc.send was blocked by the shell syscall")), 250);
            }),
          ]) as ResponseOkFrame;
          const takeoverRunId = (response.data as any).runId;
          expect(process.currentRun).toMatchObject({ runId: takeoverRunId });

          let markSuccessorStarted!: () => void;
          const successorStarted = new Promise<void>((resolve) => {
            markSuccessorStarted = resolve;
          });
          process.runTick = vi.fn(async (runId: string) => {
            if (runId === takeoverRunId) {
              markSuccessorStarted();
            }
          });
          await process.tick({ runId: takeoverRunId, generation: 0 });
          await Promise.race([
            successorStarted,
            new Promise<never>((_resolve, reject) => {
              setTimeout(() => reject(new Error("successor tick was blocked by the shell syscall")), 250);
            }),
          ]);

          releaseResponse?.();
          releaseResponse = undefined;
          await ticking;

          expect(oldDispatchId).not.toBe("");
          expect(process.store.getResults("run-direct-old")).toEqual([]);
          expect(process.store.getValue("shellSessionTarget:sh_late")).toBeNull();
          expect(process.currentRun).toMatchObject({ runId: takeoverRunId });
          process.currentRun = null;
        });
      } finally {
        releaseResponse?.();
        recvSpy.mockRestore();
      }
    });

    it("ignores a late direct CodeMode response after user takeover", async () => {
      const pid = "mech-res-codemode-direct-late";
      const stub = await initProcess(pid, ROOT_IDENTITY);
      const originalRecvFrame = Kernel.prototype.recvFrame;
      let releaseResponse!: () => void;
      let markRequestStarted!: () => void;
      const responseBlocked = new Promise<void>((resolve) => {
        releaseResponse = resolve;
      });
      const requestStarted = new Promise<void>((resolve) => {
        markRequestStarted = resolve;
      });
      const recvSpy = vi.spyOn(Kernel.prototype as any, "recvFrame").mockImplementation(
        async function (this: Kernel, processId: string, frame: any) {
          if (frame?.type === "req" && frame.id === "codemode-direct-old") {
            markRequestStarted();
            await responseBlocked;
            return {
              type: "res",
              id: frame.id,
              ok: true,
              data: { status: "running", output: "", sessionId: "sh_codemode_late" },
            } as ResponseFrame;
          }
          return originalRecvFrame.call(this, processId, frame);
        },
      );

      try {
        await runInDurableObject(stub, async (instance: Process) => {
          const process = instance as any;
          process.sendSignal = vi.fn();
          process.scheduleTick = vi.fn(async () => {});
          process.currentRun = { runId: "run-codemode-old", conversationId: "default" };

          const dispatching = process.dispatchCodeModeSyscall(
            "run-codemode-old",
            "codemode-direct-old",
            "shell.exec",
            { input: "sleep 300", target: "gsv" },
          );
          await requestStarted;

          const takeover = await process.handleProcSend({
            message: "stop waiting",
            origin: { kind: "client", connectionId: "client-1" },
          });
          releaseResponse();

          await expect(dispatching).rejects.toThrow("Run stopped before shell.exec completed");
          expect(process.store.getValue("shellSessionTarget:sh_codemode_late")).toBeNull();
          expect(process.currentRun).toMatchObject({ runId: takeover.runId });
          process.currentRun = null;
        });
      } finally {
        releaseResponse();
        recvSpy.mockRestore();
      }
    });

    it("claims a recovered tool once while the original dispatcher unwinds", async () => {
      const pid = "mech-res-tool-recovery-claim";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        let releaseFirst!: () => void;
        let markFirstStarted!: () => void;
        const firstBlocked = new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        const firstStarted = new Promise<void>((resolve) => {
          markFirstStarted = resolve;
        });
        const dispatches: string[] = [];
        process.sendSignal = vi.fn();
        process.schedule = vi.fn();
        process.dispatchSyscall = vi.fn(async (_runId: string, dispatchId: string) => {
          dispatches.push(dispatchId);
          if (dispatchId === "dispatch-call-1") {
            markFirstStarted();
            await firstBlocked;
          }
        });
        process.currentRun = {
          runId: "run-recovery-claim",
          conversationId: "default",
          approvalPolicy: { default: "auto", rules: [] },
        };
        registerToolBlock(process, "run-recovery-claim", [
          { id: "call-1", name: "Read", arguments: { path: "/one" } },
          { id: "call-2", name: "Read", arguments: { path: "/two" } },
        ]);

        const original = process.processToolCalls("run-recovery-claim");
        await firstStarted;
        await original;
        expect(dispatches).toEqual(["dispatch-call-1", "dispatch-call-2"]);
        process.store.fail("dispatch-call-1", "simulated lost dispatch");
        await process.runTick("run-recovery-claim");
        expect(dispatches).toEqual(["dispatch-call-1", "dispatch-call-2"]);

        releaseFirst();
        expect(dispatches).toEqual(["dispatch-call-1", "dispatch-call-2"]);
        process.store.clearPendingToolCalls();
        process.currentRun = null;
      });
    });

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

    it("adds line numbers to agent filesystem results", async () => {
      const pid = "mech-res-sync-body";
      const stub = await initProcess(pid, ROOT_IDENTITY);
      const originalRecvFrame = Kernel.prototype.recvFrame;
      const recvSpy = vi.spyOn(Kernel.prototype as any, "recvFrame").mockImplementation(
        async function (this: Kernel, processId: string, frame: any) {
          if (frame?.type === "req" && frame.id === "dispatch-sync-body") {
            return {
              type: "res",
              id: frame.id,
              ok: true,
              data: {
                ok: true,
                path: "/tmp/note.txt",
                kind: "text",
                contentType: "text/plain",
                size: 5,
                lines: 1,
              },
              body: bodyFromText("hello"),
            } as ResponseFrame;
          }
          return originalRecvFrame.call(this, processId, frame);
        },
      );

      try {
        await runInDurableObject(stub, async (instance: Process) => {
          const process = instance as any;
          process.currentRun = { runId: "run-sync-body", conversationId: "default" };
          process.store.register(
            "dispatch-sync-body",
            "call-sync-body",
            "run-sync-body",
            "fs.read",
            { path: "/tmp/note.txt", offset: 1 },
          );

          await process.dispatchSyscall(
            "run-sync-body",
            "dispatch-sync-body",
            "fs.read",
            { path: "/tmp/note.txt", offset: 1 },
          );

          expect(process.store.getResults("run-sync-body")).toMatchObject([{
            status: "completed",
            result: { content: "     2\thello" },
          }]);
          process.currentRun = null;
        });
      } finally {
        recvSpy.mockRestore();
      }
    });

    it("stops response body materialization when its run is aborted", async () => {
      const pid = "mech-res-body-abort";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        process.currentRun = { runId: "run-body-abort", conversationId: "default" };
        process.store.register(
          "dispatch-body-abort",
          "call-body-abort",
          "run-body-abort",
          "fs.read",
          { path: "/tmp/note.txt" },
        );
        process.store.markDispatched("dispatch-body-abort");
        let cancelled: unknown;
        const response = process.handleRes({
          type: "res",
          id: "dispatch-body-abort",
          ok: true,
          data: {
            ok: true,
            path: "/tmp/note.txt",
            kind: "text",
            contentType: "text/plain",
            size: 1,
            lines: 1,
          },
          body: {
            stream: new ReadableStream({
              pull: () => new Promise(() => {}),
              cancel: (reason) => {
                cancelled = reason;
              },
            }),
          },
        });
        expect(process.runAbortControllers.has("run-body-abort")).toBe(true);

        await process.handleProcAbort({});
        await response;

        expect(cancelled).toEqual(new Error("User interrupted tool execution"));
        expect(process.runAbortControllers.size).toBe(0);
      });
    });

    it("does not continue the run until all tool calls in a batch are dispatched", async () => {
      const pid = "mech-res-multi-tool-batch";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        const continuedRunIds: string[] = [];
        const scheduledRunIds: string[] = [];
        let dispatched = 0;
        let markAllDispatched!: () => void;
        const allDispatched = new Promise<void>((resolve) => {
          markAllDispatched = resolve;
        });

        process.currentRun = {
          runId: "run-multi-tool-batch",
          approvalPolicy: { default: "auto", rules: [] },
        };

        process.sendSignal = async () => {};
        process.tick = async (runId: string) => {
          continuedRunIds.push(runId);
        };
        process.scheduleTick = async (runId: string) => {
          scheduledRunIds.push(runId);
        };
        process.dispatchSyscall = async (
          _dispatchRunId: string,
          dispatchId: string,
        ) => {
          if (dispatchId === "dispatch-call-1") {
            await process.handleRes({
              type: "res",
              id: dispatchId,
              ok: true,
              data: { path: "/tmp/one.txt", content: "first" },
            });
          }
          dispatched += 1;
          if (dispatched === 2) {
            markAllDispatched();
          }
        };

        registerToolBlock(process, "run-multi-tool-batch", [
          { type: "toolCall", id: "call-1", name: "Read", arguments: { path: "/tmp/one.txt" } },
          { type: "toolCall", id: "call-2", name: "Read", arguments: { path: "/tmp/two.txt" } },
        ]);
        await process.processToolCalls("run-multi-tool-batch");
        await allDispatched;
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(continuedRunIds).toEqual([]);
        expect(scheduledRunIds).toEqual([]);
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
          id: "dispatch-call-2",
          ok: true,
          data: { path: "/tmp/two.txt", content: "second" },
        });

        expect(continuedRunIds).toEqual([]);
        expect(scheduledRunIds).toEqual(["run-multi-tool-batch"]);
      });
    });

    it("uses the recorded shell session device for continuation approvals", async () => {
      const pid = "mech-res-shell-session-target";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        const dispatched: unknown[] = [];
        process.sendSignal = async () => {};
        process.scheduleTick = async () => {};
        process.dispatchSyscall = async (
          _runId: string,
          _id: string,
          _call: string,
          args: unknown,
        ) => {
          dispatched.push(args);
        };

        process.store.register(
          "dispatch-shell-start",
          "call-shell-start",
          "run-shell-start",
          "shell.exec",
          { input: "npm test", target: "macbook" },
        );
        await process.handleRes({
          type: "res",
          id: "dispatch-shell-start",
          ok: true,
          data: { status: "running", output: "", sessionId: "sh_macbook" },
        });

        expect(process.store.getValue("shellSessionTarget:sh_macbook")).toBe("macbook");

        process.currentRun = {
          runId: "run-shell-continuation",
          conversationId: "default",
          approvalPolicy: {
            default: "auto",
            rules: [{ match: "shell.exec", target: "macbook", action: "deny" }],
          },
        };

        registerToolBlock(process, "run-shell-continuation", [
          { type: "toolCall", id: "call-shell-poll", name: "Shell", arguments: { input: "", sessionId: "sh_macbook" } },
        ]);
        await process.processToolCalls("run-shell-continuation");

        expect(dispatched).toEqual([]);
        expect(process.store.getResults("run-shell-continuation")).toMatchObject([{
          id: "call-shell-poll",
          status: "error",
          error: "Tool execution denied by policy",
        }]);
      });
    });

    it("fails shell continuations when the session device is unknown", async () => {
      const pid = "mech-res-shell-session-unknown-target";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      await runInDurableObject(stub, async (instance: Process) => {
        const process = instance as any;
        process.sendSignal = vi.fn();
        process.scheduleTick = vi.fn(async () => {});
        process.dispatchSyscall = vi.fn();
        process.generation = {
          async generate() {
            return {
              role: "assistant",
              content: [{
                type: "toolCall",
                id: "call-shell-unknown-poll",
                name: "Shell",
                arguments: { input: "", sessionId: "sh_unknown" },
              }],
              api: "test",
              provider: "test",
              model: "test",
              usage: testUsage(),
              stopReason: "toolUse",
              timestamp: Date.now(),
            };
          },
          async generateText() {
            return "";
          },
        };
        process.store.appendMessage("user", "poll an unknown shell", {
          runId: "run-shell-unknown-continuation",
        });
        process.currentRun = {
          runId: "run-shell-unknown-continuation",
          conversationId: "default",
          config: {
            executor: { kind: "process", pid },
            profile: "task",
            provider: "test",
            model: "test",
            apiKey: "",
            reasoning: "off",
            maxTokens: 8192,
            contextWindowTokens: 128000,
            contextWindowSource: "config",
            maxContextBytes: 32768,
            generationStreaming: "off",
          },
          tools: [],
          devices: [],
          systemPrompt: "Test system prompt.",
          approvalPolicy: {
            default: "auto",
            rules: [{ match: "shell.exec", target: "macbook", action: "deny" }],
          },
        };

        await process.runTick("run-shell-unknown-continuation");

        expect(process.dispatchSyscall).not.toHaveBeenCalled();
        expect(process.store.getResults("run-shell-unknown-continuation")).toMatchObject([{
          id: "call-shell-unknown-poll",
          status: "error",
          error: expect.stringContaining("Shell session continuation requires an explicit target"),
        }]);
        process.store.clearPendingToolCalls();
        process.currentRun = null;
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
