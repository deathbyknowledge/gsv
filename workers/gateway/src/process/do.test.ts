type ProcessTestValue<T = string | number | boolean | null | undefined> = T;

import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:workers";
import {
  evictDurableObject,
  runInDurableObject,
  runDurableObjectAlarm,
} from "cloudflare:test";
import {
  createAssistantMessageEventStream,
  type Context,
} from "@earendil-works/pi-ai";
import type { Process } from "./do";
import { Kernel } from "../kernel/do";
import {
  bodyFromBytes,
  bodyFromText,
  bodyToText,
  REQUEST_CANCEL_SIGNAL,
  type AiConfigResult,
  type ProcAbortResult,
  type ProcessIdentity,
} from "@humansandmachines/gsv/protocol";
import type { RequestFrame, ResponseFrame, ResponseOkFrame } from "../protocol/frames";
import type {
  ProcessAdapterDeliverArgs,
  ProcessAdapterDeliverRequestFrame,
  ProcessResourcesRetainRequestFrame,
  ProcessRuntimeEventDeliverArgs,
  ProcessRuntimeEventDeliverRequestFrame,
  ProcessResourceWriteRequestFrame,
  ProcessRunAttachRequestFrame,
  ProcessScheduleDeliverArgs,
  ProcessScheduleDeliverRequestFrame,
} from "../protocol/process-frames";
import { getProcessByPid, getKernelPtr } from "../shared/utils";
import { stableOpaqueId } from "../shared/stable-id";
import { TOOL_TO_SYSCALL } from "../syscalls/constants";
import { DEFAULT_TOOL_APPROVAL_POLICY } from "./approval";
import { estimateContextInputTokens } from "./context-pressure";
import { PROCESS_V001_INITIAL_SCHEMA } from "./schema/v001_initial";
import { PROCESS_V004_PENDING_TOOL_DISPATCH_ID } from "./schema/v004_pending_tool_dispatch_id";
import { PROCESS_V005_TOOL_RESULT_OUTCOME } from "./schema/v005_tool_result_outcome";
import { PROCESS_V006_PENDING_HIL_OWNER } from "./schema/v006_pending_hil_owner";
import { PROCESS_V009_TYPED_MESSAGE_QUEUE } from "./schema/v009_typed_message_queue";
import { processDurableObjectName } from "../installation/routing";
import { installationStoragePrefix } from "../installation/storage";
import { MANAGED_LIFECYCLE_RECHECK_MS } from "../installation/lifecycle";

const ROOT_IDENTITY: ProcessIdentity = {
  uid: 0,
  gid: 0,
  gids: [0],
  username: "root",
  home: "/root",
  cwd: "/root",
};
// SAFETY: test fixture is constructed with the asserted domain shape.
const DEFAULT_PROFILE = "task" as const;

// SAFETY: test fixture is constructed with the asserted domain shape.

function makeReq(call: string, args: ProcessTestValue): RequestFrame {
  // SAFETY: test fixture is constructed with the asserted domain shape.
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

function makeRuntimeEventDeliverReq(
  args: ProcessRuntimeEventDeliverArgs,
): ProcessRuntimeEventDeliverRequestFrame {
  return {
    type: "req",
    id: crypto.randomUUID(),
    call: "proc.runtime.event.deliver",
    args,
  };
}

function makeRuntimeEventReq(
  eventId: string,
  workPid: string,
): ProcessRuntimeEventDeliverRequestFrame {
  return {
    type: "req",
    id: crypto.randomUUID(),
    call: "proc.runtime.event.deliver",
    args: {
      eventId,
      event: {
        type: "adapter.work.returned",
        workPid,
      },
    },
  };
}

function registerToolBlock(
  process: any,
  runId: string,
  toolCalls: Array<{ id: string; name: string; arguments: ProcessTestValue }>,
): void {
  if (process.currentRun?.runId === runId) {
    process.currentRun = {
      ...process.currentRun,
      offeredToolNames: [
        ...new Set([
          ...(process.currentRun.offeredToolNames ?? []),
          ...toolCalls.map((toolCall) => toolCall.name),
        ]),
      ],
    };
  }
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

function offeredTools(...names: string[]) {
  return names.map((name) => ({
    name,
    description: `${name} test tool`,
    inputSchema: { type: "object", properties: {} },
  }));
// SAFETY: test fixture is constructed with the asserted domain shape.
}

function responsibilityKernelResult(call: string) {
  if (call === "r12y.list") {
    return { responsibilities: [], count: 0, revision: 0 };
  }
  if (call === "r12y.changes") {
    return { transitions: [], revision: 0, hasMore: false };
  }
  return undefined;
}

function messageAction(text: string, id = `message-${crypto.randomUUID()}`) {
  return {
    // SAFETY: test fixture is constructed with the asserted domain shape.
    type: "toolCall" as const,
    id,
    name: "Shell",
    arguments: {
      input: `message send <<'GSV_MESSAGE' && yield\n${text}\nGSV_MESSAGE`,
    },
  };
// SAFETY: test fixture is constructed with the asserted domain shape.
}

function messageUpdateAction(text: string, id = `message-${crypto.randomUUID()}`) {
  return {
    // SAFETY: test fixture is constructed with the asserted domain shape.
    type: "toolCall" as const,
    id,
    name: "Shell",
    arguments: {
      input: `message send <<'GSV_MESSAGE'\n${text}\nGSV_MESSAGE`,
    },
  };
// SAFETY: test fixture is constructed with the asserted domain shape.
}

function yieldAction(id = `yield-${crypto.randomUUID()}`) {
  return {
    // SAFETY: test fixture is constructed with the asserted domain shape.
    type: "toolCall" as const,
    id,
    name: "Shell",
    arguments: {
      input: "yield",
    },
  };
// SAFETY: test fixture is constructed with the asserted domain shape.
}

function terminalTestConfig(pid: string) {
  return {
    // SAFETY: test fixture is constructed with the asserted domain shape.
    executor: { kind: "process" as const, pid },
    // SAFETY: test fixture is constructed with the asserted domain shape.
    profile: "task" as const,
    provider: "test",
    model: "test",
    apiKey: "",
    // SAFETY: test fixture is constructed with the asserted domain shape.
    reasoning: "off" as const,
    maxTokens: 8192,
    contextWindowTokens: 128000,
    // SAFETY: test fixture is constructed with the asserted domain shape.
    contextWindowSource: "config" as const,
    maxContextBytes: 32768,
    // SAFETY: test fixture is constructed with the asserted domain shape.
    generationStreaming: "off" as const,
  };
// SAFETY: test fixture is constructed with the asserted domain shape.
}

function terminalTestResponse(content: Array<Record<string, ProcessTestValue>>) {
  return {
    // SAFETY: test fixture is constructed with the asserted domain shape.
    role: "assistant" as const,
    content,
    api: "test",
    provider: "test",
    model: "test",
    usage: testUsage(),
    // SAFETY: test fixture is constructed with the asserted domain shape.
    stopReason: "stop" as const,
    timestamp: Date.now(),
  };
}

function mockRunEventSink(
  process: any,
  pid: string,
  emitted: Array<{ signal: string; payload: ProcessTestValue }>,
): void {
  process.openRunEventSink = async (runId: string) => ({
    emit: async (seq: number, event: ProcessTestValue) => {
      emitted.push({
        signal: "proc.run.stream",
        payload: { pid, runId, seq, event },
      });
    },
    close: async () => {},
  });
}

function openAiChatSseChunk(payload: Record<string, ProcessTestValue>): string {
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

const KIMI_WORKERS_CONTEXT_OVERFLOW_ERROR =
  '8007: {"object":"error","message":"The input (301552 tokens) is longer than the model\'s context length (262144 tokens).","type":"BadRequestError","param":null,"code":400}';

// SAFETY: test fixture is constructed with the asserted domain shape.

function kimiWorkersConfigWithFallback(pid: string, contextWindowTokens = 1_000_000) {
  return {
    // SAFETY: test fixture is constructed with the asserted domain shape.
    executor: { kind: "process" as const, pid },
    // SAFETY: test fixture is constructed with the asserted domain shape.
    profile: "task" as const,
    provider: "workers-ai",
    model: "@cf/moonshotai/kimi-k2.6",
    apiKey: "",
    reasoning: "off",
    maxTokens: 100,
    contextWindowTokens,
    // SAFETY: test fixture is constructed with the asserted domain shape.
    contextWindowSource: "config" as const,
    maxContextBytes: 32768,
    fallbacks: [{
      profileId: "overflow-backup",
      profileName: "Overflow Backup",
      provider: "openrouter",
      model: "fallback-model",
      apiKey: "fallback-key",
      maxTokens: 100,
      contextWindowTokens,
      // SAFETY: test fixture is constructed with the asserted domain shape.
      contextWindowSource: "config" as const,
      generationTimeoutMs: 180000,
      // SAFETY: test fixture is constructed with the asserted domain shape.
      generationStreaming: "auto" as const,
    }],
  };
// SAFETY: test fixture is constructed with the asserted domain shape.
}

async function stubGeneration(
  stub: DurableObjectStub<Process>,
  generate: (request: any) => string | Promise<string>,
) {
  await runInDurableObject(stub, (instance: Process) => {
    // SAFETY: test fixture is constructed with the asserted domain shape.
    const process = instance as any;
    process.generation = {
      async generate(request: any) {
        const text = await generate(request);
        return {
          role: "assistant",
          content: [
            { type: "text", text },
            messageAction(text),
          ],
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
  // SAFETY: test fixture is constructed with the asserted domain shape.
  await runInDurableObject(kernel, (instance: Kernel) => {
    // SAFETY: test fixture is constructed with the asserted domain shape.
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
  // SAFETY: test fixture is constructed with the asserted domain shape.
  while (Date.now() < deadline) {
    const done = await runInDurableObject(stub, (instance: Process) => {
      // SAFETY: test fixture is constructed with the asserted domain shape.
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
  // SAFETY: test fixture is constructed with the asserted domain shape.
  while (Date.now() < deadline) {
    const message = await runInDurableObject(stub, (instance: Process) => (
      // SAFETY: test fixture is constructed with the asserted domain shape.
      (instance as any).store.getMessages().find(predicate)
    ));
    if (message) {
      return message;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for process message");
}

async function waitForTaskTitle(
  stub: DurableObjectStub<Process>,
  expected: string,
  timeoutMs = 2_000,
) {
  const deadline = Date.now() + timeoutMs;
  // SAFETY: test fixture is constructed with the asserted domain shape.
  while (Date.now() < deadline) {
    const title = await runInDurableObject(stub, (instance: Process) => (
      // SAFETY: test fixture is constructed with the asserted domain shape.
      (instance as any).store.getValue("taskTitle")
    ));
    if (title === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for task title: ${expected}`);
}

async function driveProcessUntilIdle(
  stub: DurableObjectStub<Process>,
  timeoutMs = 50_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await runDurableObjectAlarm(stub);
    // SAFETY: test fixture is constructed with the asserted domain shape.
    const done = await runInDurableObject(stub, (instance: Process) => {
      // SAFETY: test fixture is constructed with the asserted domain shape.
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
  const res = await stub.recvFrame(makeReq("proc.setidentity", { identity, profile: DEFAULT_PROFILE }));
  // SAFETY: test fixture is constructed with the asserted domain shape.
  expect((res as ResponseFrame).ok).toBe(true);
  return stub;
}

// ---------------------------------------------------------------------------
// Tier 1: Mechanical tests (no LLM)
// ---------------------------------------------------------------------------

describe("Process DO — mechanical", () => {
  it("derives inference attribution from its named installation", async () => {
    const installationId = "inst_managed_process";
    const pid = "mech-managed-inference";
    const name = processDurableObjectName(installationId, pid);
    const stub = env.PROCESS.get(env.PROCESS.idFromName(name));
    const identityResponse = await stub.recvFrame(makeReq("proc.setidentity", {
      identity: ROOT_IDENTITY,
      profile: DEFAULT_PROFILE,
    }));
    // SAFETY: test fixture is constructed with the asserted domain shape.
    expect((identityResponse as ResponseFrame).ok).toBe(true);

    const result = await runInDurableObject(stub, async (instance: Process) => {
      // SAFETY: test fixture is constructed with the asserted domain shape.
      const process = instance as any;
      const first = await process.buildInferenceAttribution(
        { provider: "gsv", model: "default" },
        "run",
        "run-managed",
      );
      const repeated = await process.buildInferenceAttribution(
        { provider: "gsv", model: "default" },
        "run",
        "run-managed",
      );
      process.store.appendMessage("user", "next model turn");
      const next = await process.buildInferenceAttribution(
        { provider: "gsv", model: "default" },
        "run",
        "run-managed",
      );
      return { first, repeated, next };
    });

    expect(result.first).toMatchObject({
      installationId,
      actor: { localUid: 0, processId: pid, runId: "run-managed" },
      workload: "background",
    });
    expect(result.first.logicalRequestId).toMatch(/^inference:[a-f0-9]{64}$/);
    expect(result.repeated.logicalRequestId).toBe(result.first.logicalRequestId);
    expect(result.next.logicalRequestId).not.toBe(result.first.logicalRequestId);
  });

  it("pauses a managed run without advancing it while the installation is suspended", async () => {
    const runId = "run-managed-suspended";
    const name = processDurableObjectName(
      "inst_managed_suspended",
      "mech-managed-suspended",
    );
    const stub = env.PROCESS.get(env.PROCESS.idFromName(name));

    await runInDurableObject(stub, async (instance: Process) => {
      const scheduleTick = vi.fn(async () => {});
      const runTick = vi.fn(async () => {});
      // SAFETY: test fixture is constructed with the asserted domain shape.
      const process = instance as {
        managedWorkGate(): Promise<{
          allowed: false;
          code: 423;
          message: string;
        }>;
        scheduleTick: typeof scheduleTick;
        runTick: typeof runTick;
        store: {
          getValue(key: string): string | null;
          setValue(key: string, value: string): void;
        };
      };
      process.managedWorkGate = async () => ({
        allowed: false,
        code: 423,
        message: "Managed installation is suspended",
      });
      process.scheduleTick = scheduleTick;
      process.runTick = runTick;
      process.store.setValue("currentRun", JSON.stringify({ runId }));

      await instance.tick({ runId, generation: 0 });

      expect(JSON.parse(process.store.getValue("currentRun") ?? "null"))
        .toEqual({ runId });
      expect(runTick).not.toHaveBeenCalled();
      expect(scheduleTick).toHaveBeenCalledWith(
        runId,
        MANAGED_LIFECYCLE_RECHECK_MS,
        false,
      );
    });
  });

  it("retains a successor tick after a scheduled tick pauses for managed lifecycle", async () => {
    const runId = "run-managed-scheduled-suspended";
    const name = processDurableObjectName(
      "inst_managed_scheduled_suspended",
      "mech-managed-scheduled-suspended",
    );
    const stub = env.PROCESS.get(env.PROCESS.idFromName(name));

    await runInDurableObject(stub, async (instance: Process, state) => {
      // SAFETY: the Process test fixture exposes these private scheduler seams.
      const process = instance as {
        managedWorkGate(): Promise<{
          allowed: false;
          code: 423;
          message: string;
        }>;
        schedule(
          when: Date,
          callback: "tick",
          payload: { runId: string; generation: number },
          options: { idempotent: true },
        ): Promise<{ id: string }>;
        store: {
          setValue(key: string, value: string): void;
        };
        tasks: {
          alarm(): Promise<void>;
        };
      };
      process.managedWorkGate = async () => ({
        allowed: false,
        code: 423,
        message: "Managed installation is suspended",
      });
      process.store.setValue("currentRun", JSON.stringify({ runId }));
      const executing = await process.schedule(
        new Date(Date.now() - 1_000),
        "tick",
        { runId, generation: 0 },
        { idempotent: true },
      );

      await process.tasks.alarm();

      const successors = state.storage.sql.exec<{
        id: string;
        callback: string;
        payload: string;
      }>(
        `SELECT id, callback, payload
         FROM cf_agents_schedules
         WHERE callback = 'tick'`,
      ).toArray();
      expect(successors).toHaveLength(1);
      expect(successors[0]).toMatchObject({
        callback: "tick",
        payload: JSON.stringify({ runId, generation: 0 }),
      });
      expect(successors[0]?.id).not.toBe(executing.id);
    });
  });

  it("stops a managed gate continuation after the process is killed", async () => {
    const pid = "mech-managed-gate-kill";
    const stub = env.PROCESS.get(env.PROCESS.idFromName(
      processDurableObjectName("inst_managed_gate_kill", pid),
    ));
    await stub.recvFrame(makeReq("proc.setidentity", {
      identity: ROOT_IDENTITY,
      profile: DEFAULT_PROFILE,
    }));

// SAFETY: test fixture is constructed with the asserted domain shape.

    await runInDurableObject(stub, async (instance: Process) => {
      // SAFETY: test fixture is constructed with the asserted domain shape.
      const process = instance as any;
      let releaseGate!: () => void;
      let markGateStarted!: () => void;
      const gateBlocked = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
      const gateStarted = new Promise<void>((resolve) => {
        markGateStarted = resolve;
      });
      process.currentRun = { runId: "run-managed-gate-kill" };
      process.managedWorkGate = vi.fn(async () => {
        markGateStarted();
        await gateBlocked;
        return { allowed: true };
      });
      process.scheduleTick = vi.fn(async () => {});

      const pausing = process.pauseManagedRun("run-managed-gate-kill");
      await gateStarted;
      await expect(process.recvFrame(makeReq("proc.kill", { archive: false })))
        .resolves.toMatchObject({ ok: true, data: { ok: true, pid } });
      releaseGate();
      await expect(pausing).resolves.toBe(true);
      expect(process.scheduleTick).not.toHaveBeenCalled();
    });
  });

  it("records terminal adapter delivery outcomes in process history", async () => {
    const pid = "mech-delivery-notice";
    const stub = await initProcess(pid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

    const notice = {
      type: "sig",
      signal: "proc.delivery.notice",
      payload: {
        noticeId: "notice:mech-delivery-notice",
        runId: "run-delivery-notice",
        deliveryKind: "final",
        state: "ambiguous",
        message: "The message reached the adapter, but provider delivery is ambiguous.",
      },
    // SAFETY: test fixture is constructed with the asserted domain shape.
    } as const;
    await stub.recvFrame(notice);
    await stub.recvFrame(notice);

// SAFETY: test fixture is constructed with the asserted domain shape.

    await runInDurableObject(stub, (instance: Process) => {
      // SAFETY: test fixture is constructed with the asserted domain shape.
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

// SAFETY: test fixture is constructed with the asserted domain shape.

    await runInDurableObject(stub, async (instance: Process) => {
      // SAFETY: test fixture is constructed with the asserted domain shape.
      const process = instance as any;
      for (let index = 0; index <= 256; index += 1) {
        await process.handleSig({
          type: "sig",
          signal: "proc.delivery.notice",
          payload: {
            noticeId: `notice:bounded:${index}`,
            runId: `run-${index}`,
            message: `Delivery notice ${index}`,
          },
        });
      }
      expect(process.store.getValue("deliveryNotice:notice:bounded:0")).toBeNull();
      expect(process.store.getValue("deliveryNotice:notice:bounded:256")).not.toBeNull();
      expect(JSON.parse(process.store.getValue("deliveryNoticeIds"))).toHaveLength(256);
    });
  }, 15_000);

  it("projects proc.run signals into kernel process activity", async () => {
    const pid = "mech-kernel-process-activity";
    await registerInKernel(pid, ROOT_IDENTITY);
    const kernel = await getKernelPtr();

// SAFETY: test fixture is constructed with the asserted domain shape.

    const state = await runInDurableObject(kernel, async (instance: Kernel) => {
      // SAFETY: test fixture is constructed with the asserted domain shape.
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
          queuedCount: 1,
          timestamp: 1075,
        },
      });
      const waitingTool = k.procs.get(pid);

      await project({
        type: "sig",
        signal: "proc.run.tool.finished",
        payload: {
          pid,
          runId: "run-activity",
          executionId: "execution-1",
          callId: "call-1",
          outcome: "completed",
          timestamp: 1076,
        },
      });
      const stillWaitingTool = k.procs.get(pid);

      await project({
        type: "sig",
        signal: "proc.changed",
        payload: {
          pid,
          runId: "run-activity",
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
          queuedCount: 0,
          timestamp: 1200,
        },
      });
      const idle = k.procs.get(pid);

      return { running, retrying, waitingTool, stillWaitingTool, resumed, waiting, idle };
    });

    expect(state.running).toMatchObject({
      state: "running",
      activeRunId: "run-activity",
      queuedCount: 1,
      lastActiveAt: 1000,
    });
    expect(state.retrying).toMatchObject({
      state: "running",
      activeRunId: "run-activity",
      queuedCount: 1,
      lastActiveAt: 1050,
    });
    expect(state.waitingTool).toMatchObject({
      state: "waiting_tool",
      activeRunId: "run-activity",
      lastActiveAt: 1075,
    });
    expect(state.stillWaitingTool).toMatchObject({
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
      queuedCount: 1,
      lastActiveAt: 1100,
    });
    expect(state.idle).toMatchObject({
      state: "idle",
      activeRunId: null,
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
      // SAFETY: test fixture is constructed with the asserted domain shape.
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

// SAFETY: test fixture is constructed with the asserted domain shape.

      const response = await runInDurableObject(kernel, (instance: Kernel) =>
        instance.recvFrame(pid, makeReq("ai.tools", {})),
      // SAFETY: test fixture is constructed with the asserted domain shape.
      ) as ResponseOkFrame;

      expect(response.ok).toBe(true);
      // SAFETY: test fixture is constructed with the asserted domain shape.
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
    it("derives pid and stores identity", async () => {
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
      await stub.recvFrame(makeReq("proc.setidentity", { identity: newIdentity, profile: "mcp" }));

      await runInDurableObject(stub, (instance: Process) => {
        expect(instance.identity.uid).toBe(1000);
        expect(instance.identity.username).toBe("alice");
      });
    });

    it("stores the process's initial task title", async () => {
      const pid = "mech-setid-title";
      await registerInKernel(pid, ROOT_IDENTITY);
      const stub = await getProcessByPid(pid);

      await stub.recvFrame(makeReq("proc.setidentity", {
        identity: ROOT_IDENTITY,
        title: "  Explicit task title  ",
        autoTitle: true,
      }));

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        expect(process.store.getValue("taskTitle")).toBe("Explicit task title");
        expect(process.store.getValue("autoTaskTitle")).toBeNull();
      });
    });
  });

  describe("automatic task titles", () => {
    it("generates one title from the first admitted message", async () => {
      const pid = "mech-auto-task-title";
      await registerInKernel(pid, ROOT_IDENTITY);
      const stub = await getProcessByPid(pid);
      await stub.recvFrame(makeReq("proc.setidentity", {
        identity: ROOT_IDENTITY,
        autoTitle: true,
      }));

      const kernelCalls: Array<{ call: string; args: any }> = [];
      const emitted: Array<{ signal: string; payload: any }> = [];
      // SAFETY: test fixture is constructed with the asserted domain shape.
      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        process.scheduleTick = async () => {};
        process.kernelRpc = async (call: string, args: any) => {
          kernelCalls.push({ call, args });
          if (call !== "ai.text.generate") {
            throw new Error(`unexpected kernel syscall: ${call}`);
          }
          return { text: "  \"Plan Database Migration.\"\nsecond line" };
        };
        process.sendSignal = async (signal: string, payload: any) => {
          emitted.push({ signal, payload });
        };
      });

// SAFETY: test fixture is constructed with the asserted domain shape.

      const first = await stub.recvFrame(makeReq("proc.send", {
        message: "Please plan a careful database migration.",
      // SAFETY: test fixture is constructed with the asserted domain shape.
      })) as ResponseOkFrame;
      expect(first.data).toMatchObject({ ok: true, status: "started" });
      await waitForTaskTitle(stub, "Plan Database Migration");

      expect(kernelCalls).toHaveLength(1);
      expect(kernelCalls[0]).toMatchObject({
        call: "ai.text.generate",
        args: {
          messages: [{ role: "user", content: "Please plan a careful database migration." }],
          options: { maxTokens: 32, reasoning: "off", timeoutMs: 20_000 },
        },
      });
      expect(emitted.filter((entry) =>
        entry.signal === "proc.changed" && entry.payload.changes?.includes("title")
      ).map((entry) => entry.payload.title)).toEqual([
        "Please plan a careful database migration",
        "Plan Database Migration",
      ]);

      await stub.recvFrame(makeReq("proc.send", { message: "Add rollback steps too." }));
      expect(kernelCalls).toHaveLength(1);
    });

    it("keeps the bounded first-message fallback when generation fails", async () => {
      const pid = "mech-auto-task-title-fallback";
      await registerInKernel(pid, ROOT_IDENTITY);
      const stub = await getProcessByPid(pid);
      await stub.recvFrame(makeReq("proc.setidentity", {
        identity: ROOT_IDENTITY,
        autoTitle: true,
      }));

      const emitted: Array<{ signal: string; payload: any }> = [];
      // SAFETY: test fixture is constructed with the asserted domain shape.
      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        process.scheduleTick = async () => {};
        process.kernelRpc = async () => {
          throw new Error("title generation unavailable");
        };
        process.sendSignal = async (signal: string, payload: any) => {
          emitted.push({ signal, payload });
        };
      });

      await stub.recvFrame(makeReq("proc.send", {
        message: "Investigate flaky checkout tests.",
      }));
      await waitForTaskTitle(stub, "Investigate flaky checkout tests");
      await vi.waitFor(() => expect(emitted.some((entry) =>
        entry.signal === "proc.changed" && entry.payload.title === "Investigate flaky checkout tests"
      )).toBe(true));
    });

    it("cancels title generation and ignores a late result after process reset", async () => {
      const pid = "mech-auto-task-title-reset";
      await registerInKernel(pid, ROOT_IDENTITY);
      const stub = await getProcessByPid(pid);
      await stub.recvFrame(makeReq("proc.setidentity", {
        identity: ROOT_IDENTITY,
        autoTitle: true,
      }));

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        let releaseGeneration!: () => void;
        let markGenerationStarted!: () => void;
        let markGenerationCompleted!: () => void;
        let generationSignal: AbortSignal | undefined;
        const generationBlocked = new Promise<void>((resolve) => {
          releaseGeneration = resolve;
        });
        const generationStarted = new Promise<void>((resolve) => {
          markGenerationStarted = resolve;
        });
        const generationCompleted = new Promise<void>((resolve) => {
          markGenerationCompleted = resolve;
        });
        const emitted: Array<{ signal: string; payload: any }> = [];
        process.scheduleTick = async () => {};
        const generateTaskTitle = process.generateTaskTitle.bind(process);
        process.generateTaskTitle = async (...args: ProcessTestValue[]) => {
          try {
            return await generateTaskTitle(...args);
          } finally {
            markGenerationCompleted();
          }
        };
        process.kernelRpc = async (
          call: string,
          _args: ProcessTestValue,
          signal?: AbortSignal,
        ) => {
          if (call !== "ai.text.generate") {
            throw new Error(`unexpected kernel syscall: ${call}`);
          }
          generationSignal = signal;
          markGenerationStarted();
          await generationBlocked;
          return { text: "Diagnose Checkout Flakiness" };
        };
        process.sendSignal = async (signal: string, payload: any) => {
          emitted.push({ signal, payload });
        };

// SAFETY: test fixture is constructed with the asserted domain shape.

        const send = await process.recvFrame(makeReq("proc.send", {
          message: "Investigate flaky checkout tests.",
        // SAFETY: test fixture is constructed with the asserted domain shape.
        })) as ResponseOkFrame;
        expect(send.data).toMatchObject({ ok: true, status: "started" });
        await generationStarted;
        expect(generationSignal?.aborted).toBe(false);
        expect(process.store.getValue("taskTitle"))
          .toBe("Investigate flaky checkout tests");

        // SAFETY: test fixture is constructed with the asserted domain shape.
        const reset = await process.recvFrame(makeReq("proc.reset", {})) as ResponseOkFrame;
        expect(reset.data).toMatchObject({ ok: true, pid });
        expect(generationSignal?.aborted).toBe(true);
        expect(generationSignal?.reason).toEqual(new Error("Process execution was reset: process.reset"));

        releaseGeneration();
        await generationCompleted;

        expect(process.store.getHistoryGeneration()).toBe(2);
        expect(process.store.getValue("taskTitle")).toBe("Investigate flaky checkout tests");
        expect(process.store.messageCount()).toBe(0);
        expect(emitted.filter((entry) =>
          entry.signal === "proc.changed" && entry.payload.changes?.includes("title")
        ).map((entry) => entry.payload.title)).toEqual([
          "Investigate flaky checkout tests",
        ]);
      });
    });

    it("aborts owned title work when the process is killed", async () => {
      const pid = "mech-auto-task-title-kill";
      const stub = await initProcess(pid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        const controller = new AbortController();
        process.taskTitleAbortController = controller;
        process.sendSignal = vi.fn(async () => {});

// SAFETY: test fixture is constructed with the asserted domain shape.

        const killed = await process.recvFrame(makeReq("proc.kill", {
          archive: false,
        // SAFETY: test fixture is constructed with the asserted domain shape.
        })) as ResponseOkFrame;

        expect(killed.data).toMatchObject({ ok: true, pid });
        expect(controller.signal.aborted).toBe(true);
        expect(controller.signal.reason).toEqual(
          new Error("Process execution was reset: process.kill"),
        );
        expect(process.taskTitleAbortController).toBeNull();
      });
    });
  });

  describe("proc.ai.config", () => {
    it("stores snapshots, redacts reads by default, patches fields, and clears", async () => {
      const pid = "mech-ai-config";
      const stub = await initProcess(pid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

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
      // SAFETY: test fixture is constructed with the asserted domain shape.
      })) as ResponseOkFrame;
      expect(setResponse.ok).toBe(true);
      // SAFETY: test fixture is constructed with the asserted domain shape.
      expect((setResponse.data as any).config).toMatchObject({
        profile: { id: "fast", name: "Fast" },
        values: {
          "config/ai/provider": "openai",
          "config/ai/model": "gpt-4.1-mini",
          "config/ai/api_key": "redacted",
        },
      });

      // SAFETY: test fixture is constructed with the asserted domain shape.
      const redactedGet = await stub.recvFrame(makeReq("proc.ai.config.get", {})) as ResponseOkFrame;
      // SAFETY: test fixture is constructed with the asserted domain shape.
      expect((redactedGet.data as any).config.values["config/ai/api_key"]).toBe("redacted");

      // SAFETY: test fixture is constructed with the asserted domain shape.
      const rawGet = await stub.recvFrame(makeReq("proc.ai.config.get", { redacted: false })) as ResponseOkFrame;
      // SAFETY: test fixture is constructed with the asserted domain shape.
      expect((rawGet.data as any).config.values["config/ai/api_key"]).toBe("sk-process");
      // SAFETY: test fixture is constructed with the asserted domain shape.
      expect((rawGet.data as any).config.values).not.toHaveProperty("config/ai/max_tokens");
      // SAFETY: test fixture is constructed with the asserted domain shape.
      expect((rawGet.data as any).config.values).not.toHaveProperty("config/ai/max_context_bytes");

      // SAFETY: test fixture is constructed with the asserted domain shape.
      const patchResponse = await stub.recvFrame(makeReq("proc.ai.config.set", {
        key: "config/ai/model",
        value: "gpt-4.2",
      // SAFETY: test fixture is constructed with the asserted domain shape.
      })) as ResponseOkFrame;
      // SAFETY: test fixture is constructed with the asserted domain shape.
      expect((patchResponse.data as any).config.profile).toMatchObject({ id: "fast", name: "Fast" });
      // SAFETY: test fixture is constructed with the asserted domain shape.
      expect((patchResponse.data as any).config.values["config/ai/model"]).toBe("gpt-4.2");

      // SAFETY: test fixture is constructed with the asserted domain shape.
      const clearResponse = await stub.recvFrame(makeReq("proc.ai.config.set", { clear: true })) as ResponseOkFrame;
      // SAFETY: test fixture is constructed with the asserted domain shape.
      expect((clearResponse.data as any).config).toBeNull();
      // SAFETY: test fixture is constructed with the asserted domain shape.
      const afterClear = await stub.recvFrame(makeReq("proc.ai.config.get", {})) as ResponseOkFrame;
      // SAFETY: test fixture is constructed with the asserted domain shape.
      expect((afterClear.data as any).config).toBeNull();
    });

    it("keeps profile-only snapshots for server-side secret resolution", async () => {
      const pid = "mech-ai-config-profile-only";
      const stub = await initProcess(pid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      const setResponse = await stub.recvFrame(makeReq("proc.ai.config.set", {
        values: {},
        profile: {
          id: "fast",
          name: "Fast",
        },
      // SAFETY: test fixture is constructed with the asserted domain shape.
      })) as ResponseOkFrame;

      // SAFETY: test fixture is constructed with the asserted domain shape.
      expect((setResponse.data as any).config).toMatchObject({
        profile: { id: "fast", name: "Fast" },
        values: {},
      });

      // SAFETY: test fixture is constructed with the asserted domain shape.
      const getResponse = await stub.recvFrame(makeReq("proc.ai.config.get", { redacted: false })) as ResponseOkFrame;
      // SAFETY: test fixture is constructed with the asserted domain shape.
      expect((getResponse.data as any).config).toMatchObject({
        profile: { id: "fast", name: "Fast" },
        values: {},
      });

// SAFETY: test fixture is constructed with the asserted domain shape.

      const patchResponse = await stub.recvFrame(makeReq("proc.ai.config.set", {
        key: "config/ai/reasoning",
        value: "high",
      // SAFETY: test fixture is constructed with the asserted domain shape.
      })) as ResponseOkFrame;
      // SAFETY: test fixture is constructed with the asserted domain shape.
      expect((patchResponse.data as any).config).toMatchObject({
        profile: { id: "fast", name: "Fast" },
        values: {
          "config/ai/reasoning": "high",
        },
      });

// SAFETY: test fixture is constructed with the asserted domain shape.

      const clearFieldResponse = await stub.recvFrame(makeReq("proc.ai.config.set", {
        key: "config/ai/reasoning",
        value: "",
      // SAFETY: test fixture is constructed with the asserted domain shape.
      })) as ResponseOkFrame;
      // SAFETY: test fixture is constructed with the asserted domain shape.
      expect((clearFieldResponse.data as any).config).toMatchObject({
        profile: { id: "fast", name: "Fast" },
        values: {},
      });
    });
  });

  describe("model context", () => {
    it("keeps an empty epoch baseline immutable when work arrives mid-run", async () => {
      const pid = "mech-r12y-mid-run-create";
      const runId = "run-r12y-mid-run-create";
      const responsibilityId = "r12y:00000000-0000-4000-8000-000000000009";
      const requestResponsibilityId = "r12y:00000000-0000-4000-8000-000000000011";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      const result = await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test exercises Process-owned context epoch and runtime-event internals.
        const process = instance as any;
        const responsibility = {
          id: responsibilityId,
          ownerUid: 0,
          title: "Review contact message msg:one with the owner",
          details: {
            eventType: "federation.message.received",
            contactId: "contact:flynn",
            contactGeneration: "generation:flynn",
            conversationId: "conv:flynn",
            messageId: "msg:one",
            deliveryId: "delivery:one",
            remoteDisplayName: "Flynn",
            resourceCount: 1,
            contentTrust: "untrusted",
          },
          source: {
            kind: "event",
            eventType: "federation.received",
            eventId: "delivery:one",
          },
          assignee: { kind: "ship" },
          state: "open",
          priority: "high",
          revision: 1,
          createdAtMs: 200,
          updatedAtMs: 200,
        };
        const requestResponsibility = {
          ...responsibility,
          id: requestResponsibilityId,
          title: "Track contact request request:one",
          details: {
            eventType: "federation.request",
            contactId: "contact:flynn",
            contactGeneration: "generation:flynn",
            conversationId: "conv:flynn",
            requestId: "request:one",
            direction: "incoming",
            requestKind: "task",
            requestTitle: "Review the launch plan",
            state: "offered",
            revision: 1,
            remoteDisplayName: "Flynn",
            contentTrust: "untrusted",
            latestDeliveryId: "delivery:request-one",
          },
        };
        process.kernelRpc = vi.fn(async (call: string, args: any) => {
          if (call === "r12y.list") {
            return { responsibilities: [], count: 0, revision: 0 };
          }
          if (call === "r12y.changes") {
            return args.afterRevision < 1
              ? {
                  transitions: [responsibility, requestResponsibility].map((record, index) => ({
                    revision: index + 1,
                    responsibilityId: record.id,
                    kind: "created",
                    afterState: "open",
                    changedFields: ["created"],
                    actor: { kind: "system", component: "federation" },
                    record,
                    createdAtMs: 200 + index,
                  })),
                  revision: 2,
                  hasMore: false,
                }
              : { transitions: [], revision: 2, hasMore: false };
          }
          throw new Error(`unexpected kernel call: ${call}`);
        });
        const run = {
          runId,
          config: {
            ...terminalTestConfig(pid),
            skillIndexMode: "off",
            systemContextFiles: [{
              name: "10-responsibilities.md",
              text: "Responsibility baseline:\n{{r12y}}",
            }],
          },
          tools: [],
          devices: [],
          mcpServers: [],
          approvalPolicy: { default: "auto", rules: [] },
        };
        process.currentRun = run;
        const epoch = await process.ensureContextEpoch(runId, run, run.config);
        const promptBefore = epoch.systemPrompt;

        const admission = await instance.recvFrame(makeRuntimeEventDeliverReq({
          eventId: "r12y.ready:batch:00000000-0000-4000-8000-000000000008",
          event: {
            type: "r12y.ready",
            batchId: "batch:00000000-0000-4000-8000-000000000008",
            ledgerRevision: 2,
            responsibilityIds: [responsibilityId, requestResponsibilityId],
          },
        }));
        await process.syncResponsibilityDeltas(runId, epoch);

        return {
          admission,
          promptBefore,
          promptAfter: process.store.getLiveContextEpoch().systemPrompt,
          messages: process.store.getMessages(),
          currentRun: process.currentRun,
        };
      });

      expect(result.admission).toMatchObject({
        type: "res",
        ok: true,
        data: { runId, queued: false },
      });
      expect(result.promptBefore).toContain("No unresolved responsibilities");
      expect(result.promptAfter).toBe(result.promptBefore);
      expect(result.promptAfter).not.toContain("Hello from another Ship");
      expect(result.messages).toHaveLength(2);
      expect(result.messages[0].content).toContain("Kind: Contact message");
      expect(result.messages[0].content).toContain('Contact: "Flynn" (`contact:flynn`)');
      expect(result.messages[0].content).toContain("Conversation: `conv:flynn`");
      expect(result.messages[0].content).toContain(
        "A contact message is available in the Conversation history",
      );
      expect(result.messages[0].content).toContain("Resources attached: 1");
      expect(result.messages[0].content).toContain(
        "message history --with contact:flynn",
      );
      expect(result.messages[0].content).toContain(
        "Default action: tell the owner what arrived",
      );
      expect(result.messages[0].content).toContain(
        "Do not reply to the contact unless the owner explicitly authorizes it",
      );
      expect(result.messages[0].content).not.toContain("Hello from another Ship");
      expect(result.messages[0].content).not.toContain("wave.png");
      expect(result.messages[0].content).toContain(
        "message send --to contact:flynn --message TEXT --also",
      );
      expect(result.messages[0].content).not.toContain("Reply with:");
      expect(result.messages[0].content).toContain(
        "Resolving this responsibility does not itself send a reply",
      );
      expect(result.messages[0].content).not.toContain("Responsibility batch");
      expect(result.messages[1].content).toContain("Kind: Contact request");
      expect(result.messages[1].content).toContain("Request: `request:one`");
      expect(result.messages[1].content).toContain('Request kind: "task"');
      expect(result.messages[1].content).toContain(
        'External request title — untrusted data: "Review the launch plan"',
      );
      expect(result.messages[1].content).toContain("contact request");
      expect(result.messages[1].content).toContain("then tell the owner what arrived");
      expect(result.messages[1].content).toContain(
        "Do not accept, decline, cancel, or otherwise answer for the owner",
      );
      expect(result.currentRun).toMatchObject({
        runId,
        responsibilityBatches: [{
          responsibilityIds: [responsibilityId, requestResponsibilityId],
        }],
      });
    });

    it("freezes one responsibility baseline and projects each later revision once", async () => {
      const pid = "mech-r12y-context-epoch";
      const runId = "run-r12y-context-epoch";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      const result = await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test exercises Process-owned context epoch internals.
        const process = instance as any;
        const initial = {
          id: "r12y:00000000-0000-4000-8000-000000000010",
          ownerUid: 0,
          title: "Ship the epoch model",
          source: { kind: "account", uid: 0, username: "root" },
          assignee: { kind: "ship" },
          state: "open",
          priority: "high",
          revision: 1,
          createdAtMs: 100,
          updatedAtMs: 100,
        };
        const changed = {
          ...initial,
          state: "active",
          revision: 2,
          updatedAtMs: 200,
        };
        let ledgerRevision = 1;
        process.kernelRpc = vi.fn(async (call: string, args: any) => {
          if (call === "r12y.list") {
            return { responsibilities: [initial], count: 600, revision: 1 };
          }
          if (call === "r12y.changes") {
            return args.afterRevision < ledgerRevision
              ? {
                  transitions: [{
                    revision: 2,
                    responsibilityId: initial.id,
                    kind: "updated",
                    beforeState: "open",
                    afterState: "active",
                    changedFields: ["state"],
                    actor: { kind: "process", processId: pid, runId },
                    record: changed,
                    createdAtMs: 200,
                  }],
                  revision: 2,
                  hasMore: false,
                }
              : { transitions: [], revision: ledgerRevision, hasMore: false };
          }
          throw new Error(`unexpected kernel call: ${call}`);
        });
        const run = {
          runId,
          config: {
            ...terminalTestConfig(pid),
            skillIndexMode: "off",
            systemContextFiles: [{
              name: "10-responsibilities.md",
              text: "Responsibility baseline:\n{{r12y}}",
            }],
          },
          tools: [],
          devices: [],
          mcpServers: [],
          approvalPolicy: { default: "auto", rules: [] },
        };
        process.currentRun = run;

        const epoch = await process.ensureContextEpoch(runId, run, run.config);
        const promptBefore = epoch.systemPrompt;
        ledgerRevision = 2;
        const sameEpoch = await process.ensureContextEpoch(runId, run, run.config);
        await process.syncResponsibilityDeltas(runId, sameEpoch);
        await process.syncResponsibilityDeltas(runId, process.store.getLiveContextEpoch());

        return {
          epoch: process.store.getLiveContextEpoch(),
          promptBefore,
          promptAfter: run.systemPrompt,
          transitions: process.store.listContextEpochTransitions(epoch.id),
          deltaMessages: process.store.getMessages().filter((message: any) => (
            message.role === "system" && message.content.includes("ledger revision 2")
          )),
          calls: process.kernelRpc.mock.calls,
        };
      });

      expect(result.promptBefore).toContain("Ship the epoch model");
      expect(result.promptBefore).toContain("599 additional unresolved responsibilities");
      expect(result.promptAfter).toBe(result.promptBefore);
      expect(result.epoch).toMatchObject({
        r12yRevision: 1,
        r12yCount: 600,
        observedR12yRevision: 2,
        state: "live",
      });
      expect(result.transitions).toHaveLength(1);
      expect(result.deltaMessages).toHaveLength(1);
      expect(result.calls.filter(([call]: [string]) => call === "r12y.list"))
        .toHaveLength(1);
    });

    it("appends availability deltas without rotating the frozen epoch", async () => {
      const pid = "mech-context-projection-delta";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      const result = await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test exercises Process-owned context epoch internals.
        const process = instance as any;
        process.kernelRpc = vi.fn(async (call: string) => {
          const responsibilityResult = responsibilityKernelResult(call);
          if (responsibilityResult) return responsibilityResult;
          throw new Error(`unexpected kernel call: ${call}`);
        });
        const config = {
          ...terminalTestConfig(pid),
          systemContextFiles: [{
            name: "00-runtime.md",
            text: "Date: {{current.date}}\nTargets:\n{{devices}}\nMCP:\n{{mcpServers}}",
          }],
          skillIndexMode: "summary" as const,
          skillIndex: [{
            id: "alpha",
            name: "Alpha",
            description: "Alpha workflow",
            source: { kind: "home" as const, label: "home", writable: true },
          }],
        };
        const firstSnapshot = {
          devices: [{
            id: "laptop",
            label: "Laptop",
            platform: "linux",
            implements: ["shell.exec"],
          }],
          mcpServers: ["Search"],
          systemContextFiles: config.systemContextFiles,
          system: { timezone: "UTC" },
          skillIndex: config.skillIndex,
          skillIndexMode: config.skillIndexMode,
        };
        const firstProjection = {
          version: 1 as const,
          runtime: { date: "2026-08-28", timezone: "UTC" },
          targets: [{
            id: "laptop",
            implements: ["shell.exec"],
            label: "Laptop",
            platform: "linux",
          }],
          mcpServers: firstSnapshot.mcpServers,
          skills: {
            mode: config.skillIndexMode,
            entries: [{ id: "alpha", description: "Alpha workflow" }],
          },
        };
        const firstRun = {
          runId: "run-projection-a",
          config,
          tools: [],
          devices: firstSnapshot.devices,
          mcpServers: firstSnapshot.mcpServers,
          approvalPolicy: { default: "auto", rules: [] },
        };
        process.currentRun = firstRun;
        const firstEpoch = await process.ensureContextEpoch(
          firstRun.runId,
          firstRun,
          config,
          firstSnapshot,
          firstProjection,
        );

        const nextSnapshot = {
          ...firstSnapshot,
          devices: [{
            id: "desktop",
            label: "Desktop",
            platform: "linux",
            implements: ["fs.read", "shell.exec"],
          }],
          mcpServers: ["Calendar"],
          skillIndex: [{
            id: "beta",
            name: "Beta",
            description: "Beta workflow",
            source: { kind: "home" as const, label: "home", writable: true },
          }],
        };
        const nextProjection = {
          version: 1 as const,
          runtime: { date: "2026-08-29", timezone: "UTC" },
          targets: [{
            id: "desktop",
            implements: ["fs.read", "shell.exec"],
            label: "Desktop",
            platform: "linux",
          }],
          mcpServers: nextSnapshot.mcpServers,
          skills: {
            mode: config.skillIndexMode,
            entries: [{ id: "beta", description: "Beta workflow" }],
          },
        };
        const nextRun = {
          ...firstRun,
          runId: "run-projection-b",
          systemPrompt: undefined,
          contextEpochId: undefined,
          devices: nextSnapshot.devices,
          mcpServers: nextSnapshot.mcpServers,
        };
        process.currentRun = nextRun;
        const sameEpoch = await process.ensureContextEpoch(
          nextRun.runId,
          nextRun,
          config,
          nextSnapshot,
          nextProjection,
        );
        await process.syncContextProjection(nextRun.runId, sameEpoch, nextProjection);

        return {
          firstEpoch,
          liveEpoch: process.store.getLiveContextEpoch(),
          epochs: process.store.listContextEpochs(),
          messages: process.store.getMessages(),
        };
      });

      expect(result.liveEpoch.id).toBe(result.firstEpoch.id);
      expect(result.epochs).toHaveLength(1);
      expect(result.liveEpoch.systemPrompt).toContain("Date: 2026-08-28");
      expect(result.liveEpoch.systemPrompt).toContain("laptop: Laptop (linux)");
      expect(result.liveEpoch.systemPrompt).toContain("- Search");
      expect(result.liveEpoch.systemPrompt).toContain("<name>alpha</name>");
      expect(result.liveEpoch.systemPrompt).not.toContain("desktop");
      expect(result.liveEpoch.observedProjection).toMatchObject({
        runtime: { date: "2026-08-29" },
        targets: [{ id: "desktop" }],
        mcpServers: ["Calendar"],
        skills: { entries: [{ id: "beta" }] },
      });
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].content).toContain("Context availability changed.");
      expect(result.messages[0].content).toContain("- Added: `desktop`");
      expect(result.messages[0].content).toContain("- Removed: `laptop`");
      expect(result.messages[0].content).toContain("Current date: 2026-08-29");
    });

    it("archives and replaces a legacy epoch before installing projection state", async () => {
      const pid = "mech-context-projection-upgrade";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      const result = await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test exercises the supported context-epoch migration boundary.
        const process = instance as any;
        process.kernelRpc = vi.fn(async (call: string) => {
          const responsibilityResult = responsibilityKernelResult(call);
          if (responsibilityResult) return responsibilityResult;
          throw new Error(`unexpected kernel call: ${call}`);
        });
        const legacyProjection = {
          version: 1,
          runtime: { date: "2026-08-28", timezone: "UTC" },
          targets: [],
          mcpServers: [],
          skills: { mode: "off", entries: [] },
        };
        const legacy = process.store.createContextEpoch({
          id: "epoch-legacy",
          generation: 1,
          systemPrompt: "legacy prompt",
          r12yRevision: 0,
          r12yCount: 0,
          r12yBaseline: [],
          sourceManifest: { version: 1 },
          observedProjection: legacyProjection,
          now: 100,
        });
        process.store.appendMessage("user", "Old epoch activity", {
          runId: "run-legacy",
        });
        const config = {
          ...terminalTestConfig(pid),
          skillIndexMode: "off" as const,
          systemContextFiles: [{ name: "00-test.md", text: "current prompt" }],
        };
        const snapshot = {
          devices: [],
          mcpServers: [],
          systemContextFiles: config.systemContextFiles,
          system: { timezone: "UTC" },
          skillIndex: [],
          skillIndexMode: "off" as const,
        };
        const run = {
          runId: "run-current",
          config,
          tools: [],
          devices: [],
          mcpServers: [],
          approvalPolicy: { default: "auto", rules: [] },
        };
        process.store.appendMessage("user", "New epoch activity", { runId: run.runId });
        process.currentRun = run;
        const replacement = await process.ensureContextEpoch(
          run.runId,
          run,
          config,
          snapshot,
          legacyProjection,
        );
        return {
          legacy,
          replacement,
          epochs: process.store.listContextEpochs(),
        };
      });

      expect(result.replacement.id).not.toBe(result.legacy.id);
      expect(result.replacement.sourceManifest).toMatchObject({
        version: 2,
        contextProjection: { version: 1 },
      });
      expect(result.epochs).toHaveLength(2);
      expect(result.epochs[0]).toMatchObject({
        id: "epoch-legacy",
        state: "closed",
        closeReason: "context.changed",
        archivePath: expect.stringContaining("/epochs/epoch-legacy.json.gz"),
      });
    });

    it("closes and archives the exact epoch when standing context changes", async () => {
      const pid = "mech-context-epoch-rotation";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      const result = await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test exercises Process-owned context epoch internals.
        const process = instance as any;
        process.kernelRpc = vi.fn(async (call: string) => {
          const responsibilityResult = responsibilityKernelResult(call);
          if (responsibilityResult) return responsibilityResult;
          throw new Error(`unexpected kernel call: ${call}`);
        });
        process.store.appendMessage("user", "Preserve this exact activity.", {
          runId: "run-epoch-a",
        });
        const configA = {
          ...terminalTestConfig(pid),
          skillIndexMode: "off",
          systemContextFiles: [{ name: "00-test.md", text: "epoch alpha" }],
        };
        const runA = {
          runId: "run-epoch-a",
          config: configA,
          tools: [],
          devices: [],
          mcpServers: [],
          approvalPolicy: { default: "auto", rules: [] },
        };
        process.currentRun = runA;
        const epochA = await process.ensureContextEpoch(runA.runId, runA, configA);
        process.store.recordContextEpochRun(runA.runId, {
          runId: runA.runId,
          status: "ok",
          delivery: {
            kind: "message",
            conversationId: "conv:ship",
            messageId: "msg:epoch-a",
          },
        }, 200);

        const configB = {
          ...configA,
          systemContextFiles: [{ name: "00-test.md", text: "epoch beta" }],
        };
        const runB = {
          ...runA,
          runId: "run-epoch-b",
          config: configB,
          systemPrompt: undefined,
        };
        process.store.appendMessage("user", "This belongs to epoch beta.", {
          runId: runB.runId,
        });
        process.currentRun = runB;
        const epochB = await process.ensureContextEpoch(runB.runId, runB, configB);
        const epochs = process.store.listContextEpochs();
        const closed = epochs.find((epoch: any) => epoch.id === epochA.id);
        if (!closed?.archivePath) throw new Error("Expected closed epoch archive");
        const archived = await process.storage.get(closed.archivePath.replace(/^\/+/, ""));
        if (!archived) throw new Error("Expected stored epoch archive");
        const manifest = await new Response(
          archived.body.pipeThrough(new DecompressionStream("gzip")),
        ).json();
        return { epochA, epochB, epochs, manifest };
      });

      expect(result.epochA.systemPrompt).toContain("epoch alpha");
      expect(result.epochB.systemPrompt).toContain("epoch beta");
      expect(result.epochB.id).not.toBe(result.epochA.id);
      expect(result.epochs).toHaveLength(2);
      expect(result.epochs[0]).toMatchObject({
        id: result.epochA.id,
        state: "closed",
        closeReason: "context.changed",
        archivePath: expect.stringContaining("/epochs/"),
      });
      expect(result.epochs[1]).toMatchObject({
        id: result.epochB.id,
        state: "live",
      });
      expect(result.manifest).toMatchObject({
        epoch: {
          id: result.epochA.id,
          systemPrompt: expect.stringContaining("epoch alpha"),
          processActivity: [expect.objectContaining({
            content: "Preserve this exact activity.",
          })],
          runBoundaries: [expect.objectContaining({
            runId: "run-epoch-a",
            delivery: {
              kind: "message",
              conversationId: "conv:ship",
              messageId: "msg:epoch-a",
            },
          })],
        },
      });
      expect(result.manifest.epoch.processActivity).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ content: "This belongs to epoch beta." }),
        ]),
      );
    });

    it("admits a typed work-return event exactly once", async () => {
      const stub = await initProcess("mech-work-return-event", ROOT_IDENTITY);
      const firstRequest = makeRuntimeEventReq(
        "adapter-home:event-1",
        "proc:work-1",
      );
      const first = await stub.recvFrame(firstRequest);
      await evictDurableObject(stub);
      const replayRequest = makeRuntimeEventReq(
        "adapter-home:event-1",
        "proc:work-1",
      );
      const replay = await stub.recvFrame(replayRequest);

      expect(first).toMatchObject({
        type: "res",
        id: firstRequest.id,
        ok: true,
        data: { runId: "adapter-home:event-1", queued: false },
      });
      expect(replay).toMatchObject({
        type: "res",
        id: replayRequest.id,
        ok: true,
        data: { runId: "adapter-home:event-1", queued: false },
      });

// SAFETY: test fixture is constructed with the asserted domain shape.

      const messages = await runInDurableObject(stub, (instance: Process) => (
        // SAFETY: test fixture is constructed with the asserted domain shape.
        (instance as any).store.getMessages()
      ));
      const admitted = messages.filter((message: any) => (
        message.runId === "adapter-home:event-1"
        && message.content.includes("returned from work process")
      ));
      expect(admitted).toHaveLength(1);
      expect(admitted[0]).toMatchObject({
        role: "system",
        runId: "adapter-home:event-1",
      });
      expect(admitted[0].content).toContain("returned from work process `proc:work-1`");
      expect(admitted[0].content).toContain("No work-session transcript was attached");
    });

    // SAFETY: test fixture is constructed with the asserted domain shape.
    it("includes process system messages as model-visible events", async () => {
      const pid = "mech-system-context-1";
      const stub = await initProcess(pid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        process.store.appendMessage("system", "Delegated task finished with result GREEN.");
        process.store.appendMessage("user", "What was the result?");

        const messages = await process.buildContextMessages("default");
        expect(messages).toHaveLength(2);
        expect(messages[0]).toMatchObject({ role: "user" });
        // SAFETY: test fixture is constructed with the asserted domain shape.
        expect((messages[0] as any).content).toContain("[GSV EVENT]");
        // SAFETY: test fixture is constructed with the asserted domain shape.
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

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
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
        // SAFETY: test fixture is constructed with the asserted domain shape.
        expect((messages[1] as any).toolCallId).toBe("call_shell");
        // SAFETY: test fixture is constructed with the asserted domain shape.
        expect((messages[2] as any).content).toContain("[GSV EVENT]");
        // SAFETY: test fixture is constructed with the asserted domain shape.
        expect((messages[2] as any).content).toContain("Delegated task from process `worker` finished");
      });
    });

    it("does not drop tool results after 200 stored messages", async () => {
      const pid = "mech-context-tool-result-after-200";
      const stub = await initProcess(pid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
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

    it("admits a responsibility batch into the active run exactly once", async () => {
      const stub = await initProcess("mech-r12y-event-active", ROOT_IDENTITY);
      const args: ProcessRuntimeEventDeliverArgs = {
        eventId: "r12y.ready:batch:00000000-0000-4000-8000-000000000001",
        event: {
          type: "r12y.ready",
          batchId: "batch:00000000-0000-4000-8000-000000000001",
          ledgerRevision: 7,
          responsibilityIds: ["r12y:00000000-0000-4000-8000-000000000002"],
        },
      };

      await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        process.sendSignal = vi.fn(async () => {});
        process.scheduleTick = vi.fn(async () => {});
        process.currentRun = { runId: "run-busy" };

        const first = await instance.recvFrame(makeRuntimeEventDeliverReq(args));
        const repeat = await instance.recvFrame(makeRuntimeEventDeliverReq(args));

        expect(first).toMatchObject({
          type: "res",
          ok: true,
          data: {
            eventId: args.eventId,
            runId: "run-busy",
            queued: false,
          },
        });
        // SAFETY: test fixture is constructed with the asserted domain shape.
        expect((repeat as any).data).toEqual((first as any).data);
        expect(process.store.getMessages()).toHaveLength(0);
        expect(process.currentRun).toMatchObject({
          runId: "run-busy",
          pendingRuntimeEvents: 1,
          responsibilityBatches: [{
            batchId: args.event.batchId,
            responsibilityIds: [args.event.responsibilityIds[0]],
          }],
        });
      });
    });

    it("prevents a responsibility-triggered run from yielding unhandled work", async () => {
      const pid = "mech-r12y-yield-boundary";
      const runId = "run-r12y-yield-boundary";
      const responsibilityId = "r12y:00000000-0000-4000-8000-000000000020";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test exercises the Process-owned run-control boundary.
        const process = instance as any;
        const responsibility = {
          id: responsibilityId,
          ownerUid: 0,
          title: "Repair the adapter",
          source: { kind: "system", component: "adapter" },
          assignee: { kind: "ship" },
          state: "open",
          priority: "high",
          revision: 1,
          createdAtMs: 100,
          updatedAtMs: 100,
        };
        process.currentRun = {
          runId,
          responsibilityBatches: [{
            batchId: "batch:00000000-0000-4000-8000-000000000021",
            responsibilityIds: [responsibilityId],
          }],
        };
        process.kernelRpc = vi.fn(async () => ({
          responsibilities: [responsibility],
          count: 1,
          revision: responsibility.revision,
        }));
        process.emitMessageStream = vi.fn(async () => {});
        process.completeMessageStream = vi.fn(async () => {});

        const blockedYield = await process.executeRunControlAction(
          runId,
          "yield-action",
          { ok: true, command: { action: "yield" } },
          [],
        );
        const blockedMessage = await process.executeRunControlAction(
          runId,
          "message-action",
          {
            ok: true,
            command: { action: "message", text: "I handled it.", finish: true },
          },
          [],
        );

        expect(blockedYield).toMatchObject({
          ok: false,
          failureKind: "command",
          error: expect.stringContaining(responsibilityId),
        });
        expect(blockedMessage).toMatchObject({
          ok: false,
          failureKind: "command",
          error: expect.stringContaining(responsibilityId),
        });
        expect(process.emitMessageStream).not.toHaveBeenCalled();
        expect(process.completeMessageStream).not.toHaveBeenCalled();

        process.kernelRpc.mockResolvedValue({
          responsibilities: [{
            ...responsibility,
            assignee: { kind: "process", processId: "proc:repair-child" },
            state: "active",
            leaseExpiresAtMs: Date.now() + 60_000,
            revision: 2,
            updatedAtMs: 200,
          }],
          count: 1,
          revision: 2,
        });
        const delegatedYield = await process.executeRunControlAction(
          runId,
          "delegated-yield-action",
          { ok: true, command: { action: "yield" } },
          [],
        );

        expect(delegatedYield).toMatchObject({
          ok: true,
          action: "yield",
          finish: true,
        });
        expect(process.emitMessageStream).toHaveBeenCalledOnce();

        process.kernelRpc.mockResolvedValue({
          responsibilities: [{
            ...responsibility,
            assignee: { kind: "process", processId: "proc:repair-child" },
            state: "waiting",
            blocker: "Worker stopped responding",
            leaseExpiresAtMs: Date.now() - 1,
            revision: 3,
            updatedAtMs: 300,
          }],
          count: 1,
          revision: 3,
        });
        const expiredDelegation = await process.executeRunControlAction(
          runId,
          "expired-delegation-yield",
          { ok: true, command: { action: "yield" } },
          [],
        );
        expect(expiredDelegation).toMatchObject({
          ok: false,
          failureKind: "command",
          error: expect.stringContaining(responsibilityId),
        });
      });
    });


    // SAFETY: test fixture is constructed with the asserted domain shape.
    it("records an unknown-only tool response as a terminal failure and continues", async () => {
      const pid = "mech-unoffered-unknown-only";
      const stub = await initProcess(pid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        const emitted: Array<{ signal: string; payload: any }> = [];
        let generationCalls = 0;
        process.sendSignal = vi.fn(async (signal: string, payload: any) => {
          emitted.push({ signal, payload });
        });
        process.scheduleTick = vi.fn(async () => {});
        process.dispatchSyscall = vi.fn(async () => {});
        process.executeCodeModeTool = vi.fn(async () => {});
        process.generation = {
          async generate() {
            generationCalls += 1;
            return generationCalls === 1
              ? {
                  role: "assistant",
                  content: [{
                    type: "toolCall",
                    id: "forged-unknown",
                    name: "RootAccess",
                    arguments: { command: "read secrets" },
                  }],
                  api: "test",
                  provider: "test",
                  model: "test",
                  usage: testUsage(),
                  stopReason: "toolUse",
                  timestamp: Date.now(),
                }
              : {
                  role: "assistant",
                  content: [
                    { type: "text", text: "Recovered from the invalid tool call." },
                    messageAction("Recovered from the invalid tool call.", "recovery-message"),
                  ],
                  api: "test",
                  provider: "test",
                  model: "test",
                  usage: testUsage(),
                  stopReason: "stop",
                  timestamp: Date.now(),
                };
          },
          async generateText() {
            return "unused";
          },
        };
        process.store.appendMessage("user", "Answer without tools.", {
          runId: "run-unoffered-unknown-only",
        });
        process.currentRun = {
          runId: "run-unoffered-unknown-only",
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

        await process.runTick("run-unoffered-unknown-only");
        await process.runTick("run-unoffered-unknown-only");

        const messages = process.store.getMessages();
        expect(messages.find((message: any) => message.role === "assistant")?.toolCalls)
          .toContain("RootAccess");
        expect(messages.find((message: any) => message.role === "toolResult")).toMatchObject({
          content: 'Tool "RootAccess" was not offered for this generation',
          toolCallId: "forged-unknown",
        });
        expect(process.store.getResults("run-unoffered-unknown-only")).toEqual([]);
        expect(process.dispatchSyscall).not.toHaveBeenCalled();
        expect(process.executeCodeModeTool).not.toHaveBeenCalled();
        expect(emitted.some((entry) => entry.signal === "proc.run.hil.requested")).toBe(false);
        expect(emitted.findLast((entry) => entry.signal === "proc.run.finished")?.payload)
          .toMatchObject({
            status: "ok",
            result: { text: "Recovered from the invalid tool call." },
            delivery: { kind: "message" },
          });
      });
    });

    it("dispatches only offered calls from a mixed tool batch", async () => {
      const pid = "mech-offered-mixed-batch";
      const runId = "run-offered-mixed-batch";
      const stub = await initProcess(pid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        const emitted: Array<{ signal: string; payload: any }> = [];
        let generationCalls = 0;
        process.sendSignal = vi.fn(async (signal: string, payload: any) => {
          emitted.push({ signal, payload });
        });
        process.schedule = vi.fn(async () => {});
        process.scheduleTick = vi.fn(async () => {});
        process.executeCodeModeTool = vi.fn(async () => {});
        process.dispatchSyscall = vi.fn(async (
          _runId: string,
          dispatchId: string,
        ) => {
          process.store.resolve(dispatchId, "read completed");
        });
        process.generation = {
          async generate(request: any) {
            generationCalls += 1;
            expect(request.context.tools.map((tool: any) => tool.name)).toEqual([
              "Read",
              "Shell",
            ]);
            return generationCalls === 1
              ? {
                  role: "assistant",
                  content: [
                    {
                      type: "toolCall",
                      id: "offered-read",
                      name: "Read",
                      arguments: { path: "/root/allowed.txt" },
                    },
                    {
                      type: "toolCall",
                      id: "forged-shell-mixed",
                      name: "Shell",
                      arguments: { input: "cat /root/secret", target: "gsv" },
                    },
                  ],
                  api: "test",
                  provider: "test",
                  model: "test",
                  usage: testUsage(),
                  stopReason: "toolUse",
                  timestamp: Date.now(),
                }
              : {
                  role: "assistant",
                  content: [
                    { type: "text", text: "Recovered from the rejected call." },
                    messageAction("Recovered from the rejected call.", "mixed-message"),
                  ],
                  api: "test",
                  provider: "test",
                  model: "test",
                  usage: testUsage(),
                  stopReason: "stop",
                  timestamp: Date.now(),
                };
          },
          async generateText() {
            return "unused";
          },
        };
        process.store.appendMessage("user", "Read the allowed file.", { runId });
        process.currentRun = {
          runId,
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
          tools: offeredTools("Read"),
          devices: [],
          mcpServers: [],
          systemPrompt: "Test system prompt.",
          approvalPolicy: { default: "auto", rules: [] },
        };

        await process.runTick(runId);
        await vi.waitFor(() => {
          expect(process.dispatchSyscall).toHaveBeenCalledOnce();
        });
        await process.runTick(runId);

        expect(process.dispatchSyscall).toHaveBeenCalledWith(
          runId,
          expect.any(String),
          "fs.read",
          { path: "/root/allowed.txt" },
        );
        expect(process.executeCodeModeTool).not.toHaveBeenCalled();
        expect(process.store.getResults(runId)).toEqual([]);
        expect(process.store.getMessages().filter((message: any) => (
          message.role === "toolResult"
        )).map((message: any) => [message.toolCallId, message.content])).toEqual([
          ["forged-shell-mixed", 'Tool "Shell" was not offered for this generation'],
          ["offered-read", "read completed"],
          ["mixed-message", "Message committed and run yielded"],
        ]);
        expect(emitted.some((entry) => entry.signal === "proc.run.hil.requested")).toBe(false);
        expect(emitted.findLast((entry) => entry.signal === "proc.run.finished")?.payload)
          .toMatchObject({
            status: "ok",
            result: { text: "Recovered from the rejected call." },
            delivery: { kind: "message" },
          });
      });
    });

    it("rejects work tools combined with run control without dispatching them", async () => {
      const pid = "mech-terminal-combination";
      const runId = "run-terminal-combination";
      const stub = await initProcess(pid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        process.sendSignal = vi.fn(async () => {});
        process.scheduleTick = vi.fn(async () => {});
        process.dispatchSyscall = vi.fn(async () => {});
        process.generation = {
          async generate() {
            return terminalTestResponse([
              {
                type: "toolCall",
                id: "combined-read",
                name: "Read",
                arguments: { path: "/root/file" },
              },
              messageAction("Premature answer.", "combined-message"),
            ]);
          },
          async generateText() {
            return "unused";
          },
        };
        process.store.appendMessage("user", "Read before answering.", { runId });
        process.currentRun = {
          runId,
          config: terminalTestConfig(pid),
          tools: offeredTools("Read"),
          devices: [],
          systemPrompt: "Test system prompt.",
          approvalPolicy: { default: "auto", rules: [] },
        };

        await process.runTick(runId);

        expect(process.dispatchSyscall).not.toHaveBeenCalled();
        expect(process.store.getResults(runId)).toEqual([]);
        expect(process.store.getMessages().filter((message: any) => (
          message.role === "toolResult"
        )).map((message: any) => [message.toolCallId, message.content])).toEqual([
          [
            "combined-read",
            "message send and yield must be issued separately from other tool actions",
          ],
          [
            "combined-message",
            "message send and yield must be issued separately from other tool actions",
          ],
        ]);
        expect(process.scheduleTick).toHaveBeenCalledOnce();
      });
    });

    it("continues after sending an update and finishes only when yielded", async () => {
      const pid = "mech-message-then-yield";
      const runId = "run-message-then-yield";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        const emitted: Array<{ signal: string; payload: any }> = [];
        let generationCalls = 0;
        process.sendSignal = vi.fn(async (signal: string, payload: any) => {
          emitted.push({ signal, payload });
        });
        process.scheduleTick = vi.fn(async () => {});
        process.generation = {
          async generate() {
            generationCalls += 1;
            return terminalTestResponse(generationCalls === 1
              ? [messageUpdateAction("I found the issue and I am fixing it.", "progress-send")]
              : [messageAction("Fixed.", "final-send")]);
          },
          async generateText() {
            return "unused";
          },
        };
        process.store.appendMessage("user", "Fix it and keep me posted.", { runId });
        process.currentRun = {
          runId,
          config: terminalTestConfig(pid),
          tools: [],
          devices: [],
          systemPrompt: "Test system prompt.",
          approvalPolicy: { default: "auto", rules: [] },
        };

        await process.runTick(runId);

        expect(process.currentRun).toMatchObject({ runId });
        expect(process.scheduleTick).toHaveBeenCalledOnce();
        expect(emitted.some((entry) => entry.signal === "proc.run.finished")).toBe(false);
        expect(process.store.getMessages().find((message: any) => (
          message.toolCallId === "progress-send"
        ))).toMatchObject({ content: "Message committed; run remains active" });

        await process.runTick(runId);

        expect(process.currentRun).toBeNull();
        expect(process.store.getMessages().find((message: any) => (
          message.toolCallId === "final-send"
        ))).toMatchObject({ content: "Message committed and run yielded" });
        expect(emitted.findLast((entry) => entry.signal === "proc.run.finished")?.payload)
          .toMatchObject({
            status: "ok",
            reason: "run.yielded",
            result: { text: "Fixed." },
            delivery: { kind: "message" },
          });
      });
    });

    it("linearizes a canonical message commit before concurrent abort", async () => {
      const pid = "mech-message-commit-abort";
      const runId = "run-message-commit-abort";
      const actionId = "message-before-abort";
      const stub = await initProcess(pid, ROOT_IDENTITY);
      const kernel = await getKernelPtr();
      let originalCommitProcessMessage: any;
      let releaseCommit!: () => void;
      let markCommitStarted!: () => void;
      const commitBlocked = new Promise<void>((resolve) => {
        releaseCommit = resolve;
      });
      const commitStarted = new Promise<void>((resolve) => {
        markCommitStarted = resolve;
      });

      await runInDurableObject(kernel, (instance: Kernel) => {
        // SAFETY: test fixture delays the internal canonical commit boundary.
        const k = instance as any;
        originalCommitProcessMessage = k.commitProcessMessage;
        k.commitProcessMessage = vi.fn(async (processId: string, args: any) => {
          expect(processId).toBe(pid);
          expect(args).toMatchObject({ runId, actionId, text: "Committed first." });
          markCommitStarted();
          await commitBlocked;
          return {
            id: "message-before-abort",
            conversationId: "conversation-before-abort",
            sequence: 1,
            author: { kind: "process", pid, uid: ROOT_IDENTITY.uid },
            text: "Committed first.",
            origin: { kind: "process", pid, runId },
            processId: pid,
            runId,
            createdAt: Date.now(),
          };
        });
      });

      try {
        await runInDurableObject(stub, async (instance: Process) => {
          // SAFETY: test exercises the Process-owned lifecycle boundary.
          const process = instance as any;
          process.currentRun = { runId };
          process.completeMessageStream = vi.fn(async () => {});
          process.emitRunFinished = vi.fn();

          const committing = process.executeRunControlAction(
            runId,
            actionId,
            {
              ok: true,
              command: { action: "message", text: "Committed first.", finish: false },
            },
            [],
          );
          await commitStarted;

          let abortFinished = false;
          const aborting = process.handleProcAbort({ runId }).then((result: ProcAbortResult) => {
            abortFinished = true;
            return result;
          });
          await new Promise((resolve) => setTimeout(resolve, 10));

          expect(abortFinished).toBe(false);
          expect(process.currentRun).toMatchObject({ runId });

          releaseCommit();
          await expect(committing).resolves.toMatchObject({
            ok: true,
            delivery: {
              kind: "message",
              conversationId: "conversation-before-abort",
              messageId: "message-before-abort",
            },
          });
          await expect(aborting).resolves.toMatchObject({
            ok: true,
            aborted: true,
            runId,
          });
          expect(process.currentRun).toBeNull();
        });
      } finally {
        await runInDurableObject(kernel, (instance: Kernel) => {
          // SAFETY: restore the test-only internal Kernel override.
          (instance as any).commitProcessMessage = originalCommitProcessMessage;
        });
      }
    });

    it("requires an explicit yield and bounds the correction", async () => {
      const pid = "mech-terminal-action-required";
      const runId = "run-terminal-action-required";
      const stub = await initProcess(pid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      const result = await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        const emitted: Array<{ signal: string; payload: any }> = [];
        process.sendSignal = vi.fn(async (signal: string, payload: any) => {
          emitted.push({ signal, payload });
        });
        process.scheduleTick = vi.fn(async () => {});
        process.generation = {
          async generate() {
            return terminalTestResponse([{ type: "text", text: "This is only a draft." }]);
          },
          async generateText() {
            return "unused";
          },
        };
        process.store.appendMessage("user", "Answer me.", { runId });
        process.currentRun = {
          runId,
          config: terminalTestConfig(pid),
          tools: [],
          devices: [],
          systemPrompt: "Test system prompt.",
          approvalPolicy: { default: "auto", rules: [] },
        };

        await process.runTick(runId);
        expect(process.scheduleTick).toHaveBeenCalledOnce();
        const correction = process.store.getMessages().find((message: any) => (
          message.role === "system" && message.runId === runId
        ));
        expect(correction?.content).toContain("Run `yield` now");
        expect((await process.buildContextMessages("default"))
          .find((message: any) => message.content.includes("Run `yield` now"))
          ?.content).toContain("[GSV EVENT]");

        await process.runTick(runId);
        return { emitted, messages: process.store.getMessages() };
      });

      expect(result.messages.filter((message: any) => message.role === "assistant"))
        .toHaveLength(2);
      expect(result.emitted.findLast((entry) => entry.signal === "proc.run.finished")?.payload)
        .toMatchObject({
          status: "error",
          reason: "message.action.missing",
          error: "The model did not yield after correction",
        });
    });

    it("gives rejected message commands an independent five-attempt budget", async () => {
      const pid = "mech-terminal-command-recovery";
      const runId = "run-terminal-command-recovery";
      const stub = await initProcess(pid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        const emitted: Array<{ signal: string; payload: any }> = [];
        let generationCalls = 0;
        process.sendSignal = vi.fn(async (signal: string, payload: any) => {
          emitted.push({ signal, payload });
        });
        process.scheduleTick = vi.fn(async () => {});
        process.generation = {
          async generate() {
            generationCalls += 1;
            return terminalTestResponse([{
              type: "toolCall",
              id: `invalid-terminal-${generationCalls}`,
              name: "Shell",
              arguments: {
                input: "message send --to here --message hello",
              },
            }]);
          },
          async generateText() {
            return "unused";
          },
        };
        process.store.appendMessage("user", "Say hello.", { runId });
        process.currentRun = {
          runId,
          config: terminalTestConfig(pid),
          tools: [],
          devices: [],
          systemPrompt: "Test system prompt.",
          approvalPolicy: { default: "auto", rules: [] },
        };

        for (let attempt = 1; attempt < 5; attempt += 1) {
          await process.runTick(runId);
          expect(process.currentRun).toMatchObject({
            terminalCommandFailures: attempt,
          });
          expect(process.currentRun.terminalCorrectionRounds).toBeUndefined();
          expect(process.currentRun.terminalDeliveryFailures).toBeUndefined();
        }
        expect(process.scheduleTick).toHaveBeenCalledTimes(4);
        expect(process.store.getMessages().find((message: any) => (
          message.toolCallId === "invalid-terminal-1"
        ))?.content).toContain("Run-control command rejected (attempt 1 of 5)");

        await process.runTick(runId);

        expect(emitted.findLast((entry) => entry.signal === "proc.run.finished")?.payload)
          .toMatchObject({
            status: "error",
            reason: "message.command.failed",
            error: "message send does not accept --to for the current conversation",
          });
      });
    });

    it("counts terminal delivery failures separately from command correction", async () => {
      const pid = "mech-terminal-delivery-recovery";
      const runId = "run-terminal-delivery-recovery";
      const stub = await initProcess(pid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        const emitted: Array<{ signal: string; payload: any }> = [];
        let generationCalls = 0;
        process.sendSignal = vi.fn(async (signal: string, payload: any) => {
          emitted.push({ signal, payload });
        });
        process.scheduleTick = vi.fn(async () => {});
        process.executeRunControlAction = vi.fn(async () => ({
          ok: false,
          action: "message",
          text: "hello",
          delivery: { kind: "none" },
          failureKind: "delivery",
          error: "temporary commit failure",
        }));
        process.generation = {
          async generate() {
            generationCalls += 1;
            return terminalTestResponse([
              messageAction("hello", `delivery-terminal-${generationCalls}`),
            ]);
          },
          async generateText() {
            return "unused";
          },
        };
        process.store.appendMessage("user", "Say hello.", { runId });
        process.currentRun = {
          runId,
          config: terminalTestConfig(pid),
          tools: [],
          devices: [],
          systemPrompt: "Test system prompt.",
          approvalPolicy: { default: "auto", rules: [] },
        };

        await process.runTick(runId);
        await process.runTick(runId);
        expect(process.currentRun).toMatchObject({
          terminalDeliveryFailures: 2,
        });
        expect(process.currentRun.terminalCommandFailures).toBeUndefined();
        expect(process.currentRun.terminalCorrectionRounds).toBeUndefined();
        expect(process.store.getMessages().find((message: any) => (
          message.toolCallId === "delivery-terminal-1"
        ))?.content).toContain("Message delivery failed (attempt 1 of 3)");

        await process.runTick(runId);

        expect(emitted.findLast((entry) => entry.signal === "proc.run.finished")?.payload)
          .toMatchObject({
            status: "error",
            reason: "message.delivery.failed",
            error: "temporary commit failure",
          });
      });
    });

    it("finishes silently without committing a canonical message", async () => {
      const pid = "mech-terminal-silence";
      const runId = "run-terminal-silence";
      const stub = await initProcess(pid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      const result = await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        const emitted: Array<{ signal: string; payload: any }> = [];
        process.sendSignal = vi.fn(async (signal: string, payload: any) => {
          emitted.push({ signal, payload });
        });
        process.emitMessageStream = vi.fn(async () => {});
        process.dispatchSyscall = vi.fn(async () => {});
        process.generation = {
          async generate() {
            return terminalTestResponse([
              { type: "thinking", thinking: "No interruption is useful." },
              yieldAction("yield-action"),
            ]);
          },
          async generateText() {
            return "unused";
          },
        };
        process.store.appendMessage("user", "No reply needed.", { runId });
        process.currentRun = {
          runId,
          conversationId: "conv:home",
          config: terminalTestConfig(pid),
          tools: [],
          devices: [],
          systemPrompt: "Test system prompt.",
          approvalPolicy: {
            default: "auto",
            rules: [{ match: "shell.exec", action: "ask" }],
          },
        };

        await process.runTick(runId);
        return {
          emitted,
          streamCalls: process.emitMessageStream.mock.calls,
          messages: process.store.getMessages(),
          dispatchCalls: process.dispatchSyscall.mock.calls,
        };
      });

      expect(result.streamCalls).toEqual([
        [runId, expect.objectContaining({ id: `draft:${runId}:yield-action` }), "silenced"],
      ]);
      expect(result.messages.find((message: any) => message.toolCallId === "yield-action"))
        .toMatchObject({ content: "Run yielded" });
      expect(result.dispatchCalls).toEqual([]);
      expect(result.emitted.findLast((entry) => entry.signal === "proc.run.finished")?.payload)
        .toMatchObject({
          status: "ok",
          reason: "run.yielded",
          result: { text: null },
          delivery: { kind: "none" },
        });
    });

    it("returns ordinary IPC output to its caller without human run control", async () => {
      const pid = "mech-terminal-ipc-message";
      const runId = "run-terminal-ipc-message";
      const stub = await initProcess(pid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      const result = await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        const emitted: Array<{ signal: string; payload: any }> = [];
        process.sendSignal = vi.fn(async (signal: string, payload: any) => {
          emitted.push({ signal, payload });
        });
        process.completeMessageStream = vi.fn(async () => {});
        process.generation = {
          async generate(request: any) {
            expect(request.context.systemPrompt).toContain(
              "This run is a delegated Process call",
            );
            expect(request.context.tools).toBeUndefined();
            return terminalTestResponse([
              { type: "text", text: "Private worker result." },
            ]);
          },
          async generateText() {
            return "unused";
          },
        };
        process.store.appendMessage("user", "Return to the caller.", { runId });
        process.currentRun = {
          runId,
          returnToCaller: true,
          config: terminalTestConfig(pid),
          tools: [],
          devices: [],
          systemPrompt: "Test system prompt.",
          approvalPolicy: { default: "auto", rules: [] },
        };

        await process.runTick(runId);
        return { emitted, streamCalls: process.completeMessageStream.mock.calls };
      });

      expect(result.streamCalls).toEqual([]);
      expect(result.emitted.findLast((entry) => entry.signal === "proc.run.finished")?.payload)
        .toMatchObject({
          status: "ok",
          reason: "ipc.returned",
          result: { text: "Private worker result." },
          delivery: { kind: "none" },
        });
    });

    it("keeps an IPC result when a legacy worker also asks for silence", async () => {
      const pid = "mech-terminal-ipc-silence";
      const runId = "run-terminal-ipc-silence";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        const emitted: Array<{ signal: string; payload: any }> = [];
        process.sendSignal = vi.fn(async (signal: string, payload: any) => {
          emitted.push({ signal, payload });
        });
        process.generation = {
          async generate() {
            return terminalTestResponse([
              { type: "text", text: "Useful private result." },
              yieldAction("ipc-yield"),
            ]);
          },
          async generateText() {
            return "unused";
          },
        };
        process.store.appendMessage("user", "Return privately.", { runId });
        process.currentRun = {
          runId,
          returnToCaller: true,
          config: terminalTestConfig(pid),
          tools: [],
          devices: [],
          systemPrompt: "Test system prompt.",
          approvalPolicy: { default: "auto", rules: [] },
        };

        await process.runTick(runId);

        expect(emitted.findLast((entry) => entry.signal === "proc.run.finished")?.payload)
          .toMatchObject({
            status: "ok",
            reason: "ipc.returned",
            result: { text: "Useful private result." },
            delivery: { kind: "none" },
          });
      });
    });

    it("aborts a transient Message projection when its streamed text changes", async () => {
      const pid = "mech-terminal-stream-change";
      const runId = "run-terminal-stream-change";
      const stub = await initProcess(pid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      const calls = await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        process.currentRun = { runId };
        process.emitMessageStream = vi.fn(async () => {});
        await process.completeMessageStream(runId, "message-1", "Hello");
        await process.completeMessageStream(runId, "message-1", "Goodbye");
        return process.emitMessageStream.mock.calls;
      });

      expect(calls).toEqual([
        [runId, expect.objectContaining({ text: "Hello", aborted: true }), "started"],
        [runId, expect.objectContaining({ text: "Hello", aborted: true }), "delta", "Hello"],
        [
          runId,
          expect.objectContaining({ text: "Hello", aborted: true }),
          "aborted",
          undefined,
          "Committed message differs from its stream",
        ],
      ]);
    });

    it("emits live proc.changed message signals for scheduled runtime events", async () => {
      const pid = "mech-schedule-live-message";
      const stub = await initProcess(pid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      const result = await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        const emitted: Array<{ signal: string; payload: ProcessTestValue }> = [];
        process.sendSignal = async (signal: string, payload: ProcessTestValue) => {
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
        const contextMessages = await process.buildContextMessages("default");
        return { emitted, messages, contextMessages };
      });

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]).toMatchObject({
        role: "system",
      });
      expect(result.messages[0].content).toContain("Scheduled event `nightly` fired.");
      expect(result.contextMessages[0]).toMatchObject({
        role: "user",
        content: expect.stringContaining("[From: schedule sched-1]"),
      });
      expect(result.contextMessages[0].content).toContain(
        "[Directed endpoint: this GSV process.]",
      );
      expect(result.contextMessages[0].content).toContain("[GSV EVENT]");
      expect(result.emitted).toHaveLength(2);
      expect(result.emitted[0]).toMatchObject({
        signal: "proc.changed",
        payload: expect.objectContaining({
          pid,
          changes: ["messages"],
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
      // SAFETY: test fixture is constructed with the asserted domain shape.
      const activeState = await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        return {
          messages: process.store.getMessages(),
          queueSize: process.store.queueSize(),
          currentRunId: process.currentRun?.runId ?? null,
        };
      });

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        (instance as any).currentRun = null;
      });
      const recordedRepeatRequest = makeScheduleDeliverReq(args);
      const recordedRepeat = await stub.recvFrame(recordedRepeatRequest);
      // SAFETY: test fixture is constructed with the asserted domain shape.
      const recordedState = await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
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
      // SAFETY: test fixture is constructed with the asserted domain shape.
      expect((activeRepeat as any).data).toEqual((first as any).data);
      // SAFETY: test fixture is constructed with the asserted domain shape.
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
      // SAFETY: test fixture is constructed with the asserted domain shape.
      const args = {
        runId: "run-schedule-idempotent-queued",
        scheduleId: "sched-idempotent-queued",
        message: "send this reminder once",
        replyTo: {
          // SAFETY: test fixture is constructed with the asserted domain shape.
          kind: "adapter" as const,
          adapter: "telegram",
          accountId: "primary",
          actorId: "telegram-user-1",
          // SAFETY: test fixture is constructed with the asserted domain shape.
          surface: { kind: "dm" as const, id: "telegram-chat-1" },
        },
      };

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        (instance as any).currentRun = {
          runId: "run-busy",
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
      // SAFETY: test fixture is constructed with the asserted domain shape.
      expect((repeated as any).data).toEqual((first as any).data);
      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        expect(process.currentRun).toMatchObject({ runId: "run-busy" });
        expect(process.store.getMessages()).toEqual([]);
        expect(process.store.queueSize()).toBe(1);
        expect(process.store.drainQueue()).toEqual([
          expect.objectContaining({
            runId: args.runId,
            role: "system",
            kind: "schedule.event",
            message: expect.stringContaining(args.message),
          }),
        ]);
      });
    });

    it("rejects a scheduled runtime event when process teardown wins admission", async () => {
      const stub = await initProcess("mech-schedule-teardown-race", ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      const result = await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        const releaseLifecycle = await process.acquireLifecycleTransition();
        const request = makeScheduleDeliverReq({
          scheduleId: "sched-teardown-race",
          message: "do not run",
        });
        const delivery = instance.recvFrame(request);
        await Promise.resolve();
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

    it("wakes a busy process for a scheduled runtime event", async () => {
      const stub = await initProcess("mech-schedule-busy-wake", ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        process.sendSignal = vi.fn(async () => {});
        process.scheduleTick = vi.fn(async () => {});
        process.currentRun = { runId: "run-busy" };

        await instance.recvFrame(makeScheduleDeliverReq({
          scheduleId: "sched-busy",
          message: "check now",
        }));
        expect(process.currentRun).toMatchObject({
          runId: "run-busy",
          pendingRuntimeEvents: 1,
        });
        const contextMessages = await process.buildContextMessages("default");
        expect(contextMessages).toHaveLength(1);
        expect(contextMessages[0].content).toContain("[From: schedule sched-busy]");
        expect(contextMessages[0].content).not.toContain("[Directed endpoint:");

        await process.finishRun("run-busy", { status: "ok", resultText: "done" });
        expect(process.currentRun).not.toBeNull();
        expect(process.currentRun.runId).not.toBe("run-busy");
      });
    });

    // SAFETY: test fixture is constructed with the asserted domain shape.
    it("keeps a scheduled adapter reply as a distinct queued run with chronological delivery context", async () => {
      const stub = await initProcess("mech-schedule-adapter-reply", ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        process.sendSignal = vi.fn(async () => {});
        process.scheduleTick = vi.fn(async () => {});
        process.currentRun = { runId: "run-busy" };
        process.generation = {
          async generate(request: any) {
            expect(request.context.systemPrompt).toBe("Test system prompt.");
            const input = JSON.stringify(request.context.messages);
            expect(input).toContain("[From: schedule sched-adapter-reply]");
            expect(input).toContain(
              "[Directed endpoint: this Telegram direct message.]",
            );
            expect(input).not.toContain("message send");
            expect(input).not.toContain("--also");
            expect(input).not.toContain("telegram-user-1");
            expect(input).not.toContain("telegram-chat-1");
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
        expect(process.store.queueSize()).toBe(1);

        process.currentRun = null;
        expect(process.claimNextQueuedRun()).toMatchObject({ runId: "run-scheduled-reply" });
        expect(process.currentRun).toMatchObject({ runId: "run-scheduled-reply" });
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

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
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

// SAFETY: test fixture is constructed with the asserted domain shape.

      const emitted = await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        const emitted: Array<{ signal: string; payload: ProcessTestValue }> = [];
        process.sendSignal = async (signal: string, payload: ProcessTestValue) => {
          emitted.push({ signal, payload });
        };
        process.generation = {
          async generate() {
            return {
              role: "assistant",
              content: [{ type: "text", text: "done" }],
              api: "workers-ai-binding",
              provider: "workers-ai",
              model: "@cf/nvidia/nemotron-3-120b-a12b",
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

      // SAFETY: test fixture is constructed with the asserted domain shape.
      const history = (await stub.recvFrame(makeReq("proc.history", {}))) as ResponseOkFrame;
      expect(history.ok).toBe(true);
      // SAFETY: test fixture is constructed with the asserted domain shape.
      expect((history.data as any).contextRevision).toBe(2);
      // SAFETY: test fixture is constructed with the asserted domain shape.
      expect((history.data as any).context).toMatchObject({
        provider: "workers-ai",
        model: "@cf/nvidia/nemotron-3-120b-a12b",
        reasoning: "off",
        contextWindowTokens: 256000,
        revision: 2,
        inputTokens: 1290,
        confirmedInputTokens: 1290,
        estimatedTrailingInputTokens: 0,
        inputBudgetTokens: 247808,
        remainingInputTokens: 246518,
        outputTokens: 56,
        totalTokens: 1290,
        source: "provider",
      });

      // SAFETY: test fixture is constructed with the asserted domain shape.
      const contextSignals = (emitted as Array<{ signal: string; payload: any }>)
        // SAFETY: test fixture is constructed with the asserted domain shape.
        .filter((entry) => entry.signal === "proc.changed" && Array.isArray((entry.payload as { changes?: unknown[] }).changes) && ((entry.payload as { changes?: unknown[] }).changes ?? []).includes("context"));
      expect(contextSignals).toHaveLength(2);
      expect(contextSignals[0].payload.context).toMatchObject({
        revision: 1,
        source: "estimate",
      });
      expect(contextSignals[1].payload.context).toMatchObject({
        revision: 2,
        inputTokens: 1290,
        source: "provider",
      });
    });

    it("alerts once per context epoch and rearms after compaction", async () => {
      const pid = "mech-context-runway-alert";
      const stub = await initProcess(pid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      const result = await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        const emitted: Array<{ signal: string; payload: ProcessTestValue }> = [];
        const generationContexts: string[] = [];
        const inputBudgetTokens = 1_000_000;
        let remainingInputTokens = 164_001;
        let revision = 0;
        process.sendSignal = async (signal: string, payload: ProcessTestValue) => {
          emitted.push({ signal, payload });
        };
        process.updateContextState = vi.fn(async (runId: string) => {
          const inputTokens = inputBudgetTokens - remainingInputTokens;
          revision += 1;
          return {
            revision,
            runId,
            provider: "test",
            model: "test",
            contextWindowTokens: 1_008_192,
            maxOutputTokens: 8_192,
            estimatedInputTokens: inputTokens,
            inputTokens,
            confirmedInputTokens: 0,
            estimatedTrailingInputTokens: inputTokens,
            inputBudgetTokens,
            remainingInputTokens,
            availableInputTokens: inputBudgetTokens,
            pressure: inputTokens / inputBudgetTokens,
            level: "warn",
            source: "estimate",
            updatedAt: Date.now(),
          };
        });
        process.generation = {
          async generate(request: any) {
            generationContexts.push(JSON.stringify(request.context));
            return terminalTestResponse([
              { type: "text", text: "done" },
              messageAction("done"),
            ]);
          },
          async generateText() {
            return "done";
          },
        };

        const run = async (runId: string, message: string) => {
          process.store.appendMessage("user", message, { runId });
          process.currentRun = {
            runId,
            config: {
              ...terminalTestConfig(pid),
              contextWindowTokens: 1_008_192,
            },
            tools: [],
            devices: [],
            systemPrompt: "Test system prompt.",
            approvalPolicy: { default: "auto", rules: [] },
          };
          await process.runTick(runId);
        };

        await run("run-before-runway-alert", "not quite yet");
        remainingInputTokens = 164_000;
        await run("run-at-runway-alert", "cross the threshold");
        remainingInputTokens = 150_000;
        await run("run-after-runway-alert", "keep going");
        const runwayEventsBeforeCompaction = emitted.filter((entry) => {
          // SAFETY: emitted Process test payloads use the asserted optional lifecycle-event shape.
          return entry.signal === "proc.changed"
            && (entry.payload as { event?: string }).event === "context.runway";
        }).length;

        await expect(process.handleHistoryCompact({
          keepLast: 1,
          summary: "Checkpoint summary.",
        })).resolves.toMatchObject({ ok: true });
        remainingInputTokens = 164_000;
        await run("run-rearmed-runway-alert", "new context epoch");

        return {
          emitted,
          generationContexts,
          messages: process.store.getMessages(),
          segments: process.store.listHistorySegments(),
          runwayEventsBeforeCompaction,
        };
      });

      expect(result.generationContexts).toHaveLength(4);
      expect(result.generationContexts[0]).not.toContain("Context runway is getting low.");
      expect(result.generationContexts[1]).toContain("[GSV EVENT]");
      expect(result.generationContexts[1]).toContain("Context runway is getting low.");
      expect(result.generationContexts[1]).toContain("About 164,000 input tokens remain");
      expect(result.generationContexts[1]).toContain(
        "About 64,000 tokens of that runway remain before GSV automatically compacts",
      );
      expect(result.generationContexts[2].match(/Context runway is getting low\./gu))
        .toHaveLength(1);
      expect(result.generationContexts[3].match(/Context runway is getting low\./gu))
        .toHaveLength(1);
      expect(result.messages.filter((message: any) => (
        message.role === "system" && message.content.includes("Context runway is getting low.")
      ))).toHaveLength(1);
      expect(result.segments).toHaveLength(1);
      expect(result.runwayEventsBeforeCompaction).toBe(1);

      const runwayEvents = result.emitted.filter((entry) => {
        // SAFETY: emitted Process test payloads use the asserted optional lifecycle-event shape.
        return entry.signal === "proc.changed"
          && (entry.payload as { event?: string }).event === "context.runway";
      });
      expect(runwayEvents).toHaveLength(2);
      expect(new Set(runwayEvents.map((entry) => (
        // SAFETY: context.runway lifecycle payloads always carry their context epoch id.
        (entry.payload as { epochId: string }).epochId
      ))).size).toBe(2);
      runwayEvents.forEach((entry) => {
        expect(entry.payload).toMatchObject({
          inputBudgetTokens: 1_000_000,
          remainingInputTokens: 164_000,
          boundaryRemainingTokens: 100_000,
          thresholdRemainingTokens: 164_000,
          compactAtPressure: 0.9,
          overflow: "auto-compact",
        });
      });
    });

    it("delivers a runway alert before its own tokens cross the soft boundary", async () => {
      const pid = "mech-context-runway-alert-headroom";
      const stub = await initProcess(pid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      const result = await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        const generationContexts: string[] = [];
        const inputBudgetTokens = 1_000_000;
        let revision = 0;
        process.sendSignal = async () => {};
        process.store.setValue("historyPolicy", JSON.stringify({
          overflow: "fail",
          compactAtPressure: 0.9,
          compactToPressure: 0.4,
          updatedAt: Date.now(),
        }));
        process.updateContextState = vi.fn(async (
          runId: string,
          _config: AiConfigResult,
          context: Context,
        ) => {
          const includesRunwayAlert = JSON.stringify(context)
            .includes("Context runway is getting low.");
          const inputTokens = includesRunwayAlert ? 900_100 : 899_999;
          revision += 1;
          return {
            revision,
            runId,
            provider: "test",
            model: "test",
            contextWindowTokens: 1_008_192,
            maxOutputTokens: 8_192,
            estimatedInputTokens: inputTokens,
            inputTokens,
            confirmedInputTokens: 0,
            estimatedTrailingInputTokens: inputTokens,
            inputBudgetTokens,
            remainingInputTokens: inputBudgetTokens - inputTokens,
            availableInputTokens: inputBudgetTokens,
            pressure: inputTokens / inputBudgetTokens,
            level: "critical",
            source: "estimate",
            updatedAt: Date.now(),
          };
        });
        process.generation = {
          async generate(request: any) {
            generationContexts.push(JSON.stringify(request.context));
            return terminalTestResponse([
              { type: "text", text: "done" },
              messageAction("done"),
            ]);
          },
          async generateText() {
            return "done";
          },
        };

        process.store.appendMessage("user", "Preserve the warning for this turn.", {
          runId: "run-context-runway-alert-headroom",
        });
        process.currentRun = {
          runId: "run-context-runway-alert-headroom",
          config: {
            ...terminalTestConfig(pid),
            contextWindowTokens: 1_008_192,
          },
          tools: [],
          devices: [],
          systemPrompt: "Test system prompt.",
          approvalPolicy: { default: "auto", rules: [] },
        };
        await process.runTick("run-context-runway-alert-headroom");

        return {
          generationContexts,
          messages: process.store.getMessages(),
        };
      });

      expect(result.generationContexts).toHaveLength(1);
      expect(result.generationContexts[0]).toContain("Context runway is getting low.");
      expect(result.messages.some((message: any) => (
        message.role === "system"
        && message.content.includes("Context limit policy stopped this run.")
      ))).toBe(false);
    });

    it("includes interaction origin in model context without rewriting stored content", async () => {
      const pid = "mech-origin-context";
      const stub = await initProcess(pid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        process.sendSignal = async () => {};
        process.generation = {
          async generate(request: any) {
            expect(request.context.systemPrompt).toBe("Test system prompt.");
            const first = request.context.messages[0];
            const second = request.context.messages[1];
            const third = request.context.messages[2];
            const fourth = request.context.messages[3];
            expect(first.role).toBe("user");
            expect(first.content).toContain("[From: Telegram direct message]");
            expect(first.content).toContain(
              "[Directed endpoint: this Telegram direct message.]",
            );
            expect(first.content).not.toContain("Steve James");
            expect(first.content).toContain("hello from telegram");
            expect(second.role).toBe("user");
            expect(second.content).toContain("[From: WhatsApp group GSV Dev from @sam]");
            expect(second.content).toContain(
              "[Directed endpoint: this WhatsApp group.]",
            );
            expect(second.content).toContain("check this from the group");
            expect(third.role).toBe("user");
            expect(third.content).toBe("same source follow-up");
            expect(fourth.role).toBe("user");
            expect(fourth.content).toContain("[From: GSV Web Desktop]");
            expect(fourth.content).toContain(
              "[Directed endpoint: this GSV client.]",
            );
            expect(fourth.content).toContain("now from chat");
            return {
              role: "assistant",
              content: [
                { type: "text", text: "noted" },
                messageAction("noted", "origin-message"),
              ],
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
          runId: "run-telegram",
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
          runId: "run-whatsapp-1",
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
          runId: "run-whatsapp-2",
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
          runId: "run-web",
          origin: JSON.stringify({
            kind: "client",
            connectionId: "conn-1",
            clientId: "gsv-ui",
            platform: "browser",
          }),
        });
        process.currentRun = {
          runId: "run-origin-context",
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
        expect(messages.filter((message: any) => message.role !== "toolResult")
          .map((message: any) => message.content)).toEqual([
          "hello from telegram",
          "check this from the group",
          "same source follow-up",
          "now from chat",
          "noted",
        ]);
      });
    });

    it("keeps prior model input stable when later runs change reply destination", async () => {
      const stub = await initProcess("mech-reply-context-prefix", ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        process.store.appendMessage("user", "start in the web client", {
          runId: "run-client",
          origin: JSON.stringify({
            kind: "client",
            connectionId: "conn-1",
            clientId: "gsv-ui",
            platform: "browser",
          }),
        });
        const clientContext = await process.buildContextMessages("default");
        expect(clientContext[0].content).toContain(
          "[Directed endpoint: this GSV client.]",
        );

        process.store.appendMessage("assistant", "client response", { runId: "run-client" });
        process.store.appendMessage("user", "continue from my phone", {
          runId: "run-device",
          origin: JSON.stringify({ kind: "device", deviceId: "phone" }),
        });
        const deviceContext = await process.buildContextMessages("default");
        expect(deviceContext.slice(0, clientContext.length)).toEqual(clientContext);
        expect(deviceContext[2].content).toContain(
          "[Directed endpoint: this GSV device client.]",
        );

        process.store.appendMessage("assistant", "device response", { runId: "run-device" });
        process.store.appendMessage("user", "delegated request", {
          runId: "run-process",
          origin: JSON.stringify({ kind: "process", sourcePid: "child" }),
        });
        const processContext = await process.buildContextMessages("default");
        expect(processContext.slice(0, deviceContext.length)).toEqual(deviceContext);
        expect(processContext[4].content).toContain(
          "[Directed endpoint: the calling GSV process.]",
        );

        process.store.appendMessage("assistant", "process response", { runId: "run-process" });
        process.store.appendMessage("user", "route-less work", { runId: "run-local" });
        const localContext = await process.buildContextMessages("default");
        expect(localContext.slice(0, processContext.length)).toEqual(processContext);
        expect(localContext[6].content).toContain(
          "[Directed endpoint: this GSV process.]",
        );
      });
    });

    it("does not let a same-run system record change the reply destination", async () => {
      const stub = await initProcess("mech-reply-context-same-run", ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        process.store.appendMessage("user", "hello from telegram", {
          runId: "run-adapter",
          origin: JSON.stringify({
            kind: "adapter",
            adapter: "telegram",
            accountId: "primary",
            surface: { kind: "dm", id: "telegram-chat-1" },
            actorId: "telegram-user-1",
          }),
        });
        process.store.appendMessage("system", "Temporary provider error.", {
          runId: "run-adapter",
        });

        const context = await process.buildContextMessages("default");
        expect(context[0].content).toContain(
          "[Directed endpoint: this Telegram direct message.]",
        );
        expect(context[1].content).toContain("[GSV EVENT]");
        expect(context[1].content).not.toContain("[Directed endpoint:");
      });
    });

    it("includes assistant thinking blocks in live proc.run.output signals", async () => {
      const pid = "mech-chat-text-thinking";
      const stub = await initProcess(pid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      const emitted = await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        const emitted: Array<{ signal: string; payload: ProcessTestValue }> = [];
        process.sendSignal = async (signal: string, payload: ProcessTestValue) => {
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

        process.store.appendMessage("user", "include reasoning");
        process.currentRun = {
          runId: "run-chat-text-thinking",
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

      // SAFETY: test fixture is constructed with the asserted domain shape.
      const textSignal = (emitted as Array<{ signal: string; payload: any }>)
        .find((entry) => entry.signal === "proc.run.output");
      expect(textSignal?.payload).toMatchObject({
        text: "done",
        pid,
        runId: "run-chat-text-thinking",
        thinking: [
          { type: "thinking", thinking: "Need to preserve this reasoning." },
        ],
      });
    });

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
      const result = await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        const emitted: Array<{ signal: string; payload: any }> = [];
        process.sendSignal = async (signal: string, payload: ProcessTestValue) => {
          emitted.push({ signal, payload });
        };
        process.generation = {
          async generate() {
            return {
              role: "assistant",
              content: [
                { type: "text", text: "Here is the report." },
                messageAction("Here is the report.", "report-message"),
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
        process.store.appendMessage("user", "Send the report.");
        process.currentRun = {
          runId: "run-final-reply-media",
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

// SAFETY: test fixture is constructed with the asserted domain shape.

        const attach = await process.recvFrame({
          type: "req",
          id: crypto.randomUUID(),
          call: "proc.run.attach",
          args: {
            runId: "run-final-reply-media",
            media: [resource],
          },
        } satisfies ProcessRunAttachRequestFrame);
        await process.runTick("run-final-reply-media");
        const history = await process.handleProcHistory({});
        return {
          attach,
          emitted,
          history,
          messages: process.store.getMessages(),
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
      expect(result.messages.findLast((message: any) => message.role === "assistant"))
        .toMatchObject({
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
      expect(result.emitted.find((entry) => entry.signal === "proc.run.output")?.payload)
        .toMatchObject({
          runId: "run-final-reply-media",
          media: [expect.objectContaining({
            type: "resource",
            ref: expect.objectContaining({
              path: expect.stringMatching(/^\/root\/\.gsv\/media\/archived-media:[0-9a-f]{64}$/),
            }),
          })],
        });
      expect(result.emitted.find((entry) => entry.signal === "proc.run.finished")?.payload)
        .toMatchObject({
          runId: "run-final-reply-media",
          result: {
            text: "Here is the report.",
          },
        });
      const finishedPayload = result.emitted.find((entry) =>
        entry.signal === "proc.run.finished"
      )?.payload;
      expect(finishedPayload).not.toHaveProperty("result.media");
      // SAFETY: test fixture is constructed with the asserted domain shape.
      const archivedKey = (result.history as any).messages
        .find((message: any) => message.role === "assistant").content.media[0].path
        .replace(/^\/+/, "");
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
      const firstKey = await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const rewrites = await (instance as any).persistArchivedMediaKeys([liveKey]);
        // SAFETY: test fixture is constructed with the asserted domain shape.
        return rewrites.get(liveKey).key as string;
      });

      await env.STORAGE.put(liveKey, new Uint8Array([9, 8, 7]), {
        httpMetadata: { contentType: "image/png" },
      });
      // SAFETY: test fixture is constructed with the asserted domain shape.
      const secondKey = await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const rewrites = await (instance as any).persistArchivedMediaKeys([liveKey]);
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
      const archivedKey = await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const rewrites = await (instance as any).persistArchivedMediaKeys([liveKey]);
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

// SAFETY: test fixture is constructed with the asserted domain shape.

      await expect(runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        return (instance as any).persistArchivedMediaKeys([liveKey]);
      })).rejects.toThrow("archived media content-address collision");
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
      const valid = await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: this focused test invokes a private archive validator on a real Process instance.
        const process = instance as any;
        return process.isValidOwnedArchiveObject(key, object);
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

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        process.sendSignal = vi.fn(async () => {});
        process.currentRun = {
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
        const abort = await process.handleProcAbort({ runId: "run-aborted-reply-media" });
        expect(abort).toMatchObject({ ok: true, aborted: true });
      });

      expect(await env.STORAGE.head(key)).not.toBeNull();
    });

    it("retries reasoning-only model turns", async () => {
      const pid = "mech-chat-thinking-only";
      const stub = await initProcess(pid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      const result = await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        const emitted: Array<{ signal: string; payload: ProcessTestValue }> = [];
        let calls = 0;
        process.sendSignal = async (signal: string, payload: ProcessTestValue) => {
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
                messageAction("visible answer", "visible-answer-message"),
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
          contextState: process.store.getContextState(),
          historyUsage: process.store.getHistoryUsage(),
          messages: process.store.getMessages(),
        };
      });

      expect(result.calls).toBe(2);
      expect(result.messages.filter((message: any) => message.role !== "toolResult")
        .map((message: any) => [message.role, message.content])).toEqual([
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
      const output = result.emitted.find((entry) => entry.signal === "proc.run.output")?.payload as any;
      expect(output?.text).toBe("visible answer");
      // SAFETY: test fixture is constructed with the asserted domain shape.
      const finished = result.emitted.find((entry) => entry.signal === "proc.run.finished")?.payload as any;
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

// SAFETY: test fixture is constructed with the asserted domain shape.

      const result = await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        const emitted: Array<{ signal: string; payload: ProcessTestValue }> = [];
        let calls = 0;
        process.sendSignal = async (signal: string, payload: ProcessTestValue) => {
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
      // SAFETY: test fixture is constructed with the asserted domain shape.
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

// SAFETY: test fixture is constructed with the asserted domain shape.

      const result = await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        const emitted: Array<{ signal: string; payload: ProcessTestValue }> = [];
        let calls = 0;
        process.sendSignal = async (signal: string, payload: ProcessTestValue) => {
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
              content: [
                { type: "text", text: "recovered" },
                messageAction("recovered", "provider-recovery-message"),
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

        process.store.appendMessage("user", "recover please");
        process.currentRun = {
          runId: "run-chat-empty-final-throw",
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
      expect(result.messages.filter((message: any) => message.role !== "toolResult")
        .map((message: any) => [message.role, message.content])).toEqual([
        ["user", "recover please"],
        ["assistant", "recovered"],
      ]);
      // SAFETY: test fixture is constructed with the asserted domain shape.
      const finished = result.emitted.find((entry) => entry.signal === "proc.run.finished")?.payload as any;
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

// SAFETY: test fixture is constructed with the asserted domain shape.

      const result = await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        const emitted: Array<{ signal: string; payload: ProcessTestValue }> = [];
        let calls = 0;
        process.sendSignal = async (signal: string, payload: ProcessTestValue) => {
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
          tools: offeredTools("Shell"),
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
      // SAFETY: test fixture is constructed with the asserted domain shape.
      const retry = result.emitted.find((entry) => entry.signal === "proc.run.retrying")?.payload as any;
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

// SAFETY: test fixture is constructed with the asserted domain shape.

      const result = await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        const emitted: Array<{ signal: string; payload: ProcessTestValue }> = [];
        let calls = 0;
        process.sendSignal = async (signal: string, payload: ProcessTestValue) => {
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
      // SAFETY: test fixture is constructed with the asserted domain shape.
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

// SAFETY: test fixture is constructed with the asserted domain shape.

      const result = await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        const emitted: Array<{ signal: string; payload: ProcessTestValue }> = [];
        const calls: Array<{ provider: string; model: string; accountId?: string }> = [];
        process.sendSignal = async (signal: string, payload: ProcessTestValue) => {
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
              content: [
                { type: "text", text: "fallback pong" },
                messageAction("fallback pong", "fallback-message"),
              ],
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
      expect(result.messages.filter((message: any) => message.role !== "toolResult")
        .map((message: any) => [message.role, message.content])).toEqual([
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
      const retry = result.emitted.find((entry) => entry.signal === "proc.run.retrying")?.payload as any;
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
      const finished = result.emitted.find((entry) => entry.signal === "proc.run.finished")?.payload as any;
      expect(finished).toMatchObject({
        status: "ok",
        reason: "run.yielded",
      });
    });

    it("reapplies context policy after switching to a smaller fallback model", async () => {
      const pid = "mech-chat-fallback-auto-compact";
      const stub = await initProcess(pid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      const result = await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        const emitted: Array<{ signal: string; payload: ProcessTestValue }> = [];
        const calls: Array<{ provider: string; model: string; context: string }> = [];
        const compactionConfigs: Array<{ provider: string; model: string }> = [];
        process.sendSignal = async (signal: string, payload: ProcessTestValue) => {
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
              content: [
                { type: "text", text: "fallback after compaction" },
                messageAction("fallback after compaction", "fallback-compaction-message"),
              ],
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
        process.store.appendMessage("user", "Context that must stay live.", {
          runId: "run-chat-fallback-auto-compact",
        });
        process.store.setValue("historyPolicy", JSON.stringify({
          overflow: "auto-compact",
          compactAtPressure: 0.5,
          compactToPressure: 0.4,
          updatedAt: Date.now(),
        }));
        process.currentRun = {
          runId: "run-chat-fallback-auto-compact",
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
          segments: process.store.listHistorySegments(),
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
      expect(result.messages.filter((message: any) => message.role !== "toolResult")
        .map((message: any) => [message.role, message.content])).toEqual([
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

    it("switches to a fallback Codex account for the same model stack", async () => {
      const pid = "mech-chat-provider-error-account-fallback";
      const stub = await initProcess(pid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      const result = await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
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
              content: [
                { type: "text", text: "secondary account pong" },
                messageAction("secondary account pong", "secondary-account-message"),
              ],
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
      expect(result.messages.filter((message: any) => message.role !== "toolResult")
        .map((message: any) => [message.role, message.content])).toEqual([
        ["user", "try another account"],
        ["assistant", "secondary account pong"],
      ]);
    });

    it("auto-compacts and retries the same Kimi model after a thrown provider overflow", async () => {
      const pid = "mech-chat-kimi-overflow-throw-compact";
      const runId = "run-chat-kimi-overflow-throw-compact";
      const stub = await initProcess(pid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      const result = await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
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
        process.generation = {
          async generate(request: any) {
            calls.push({
              provider: request.config.provider,
              model: request.config.model,
              context: JSON.stringify(request.context),
            });
            timeline.push(`generate:${calls.length}`);
            if (calls.length === 1) {
              throw new Error(KIMI_WORKERS_CONTEXT_OVERFLOW_ERROR);
            }
            return {
              role: "assistant",
              content: [
                { type: "text", text: "same model after compaction" },
                messageAction("same model after compaction", "same-model-message"),
              ],
              api: "test",
              provider: request.config.provider,
              model: request.config.model,
              usage: testUsage(20, 3),
              stopReason: "stop",
              timestamp: Date.now(),
            };
          },
          async generateText(request: any) {
            summaryCalls += 1;
            expect(request.config).toMatchObject({
              provider: "workers-ai",
              model: "@cf/moonshotai/kimi-k2.6",
            });
            expect(JSON.stringify(request.context)).toContain("old Kimi context A");
            return "Kimi overflow compact summary.";
          },
        };

        process.store.appendMessage("user", "old Kimi context A");
        process.store.appendMessage("assistant", "old Kimi context B");
        process.store.appendMessage("user", "Kimi context that must stay live.", { runId });
        process.store.setValue("historyPolicy", JSON.stringify({
          overflow: "auto-compact",
          compactAtPressure: 0.9,
          compactToPressure: 0.4,
          updatedAt: Date.now(),
        }));
        process.currentRun = {
          runId,
          config: kimiWorkersConfigWithFallback(pid),
          tools: [],
          devices: [],
          systemPrompt: "Test system prompt.",
          approvalPolicy: { default: "auto", rules: [] },
        };

        await process.runTick(runId);
        return {
          calls,
          emitted,
          messages: process.store.getMessages(),
          segments: process.store.listHistorySegments(),
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
      expect(result.messages.filter((message: any) => message.role !== "toolResult")
        .map((message: any) => [message.role, message.content])).toEqual([
        ["system", expect.stringContaining("Kimi overflow compact summary.")],
        ["user", "Kimi context that must stay live."],
        ["assistant", "same model after compaction"],
      ]);
      const retrying = result.emitted.filter((entry) => entry.signal === "proc.run.retrying");
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

// SAFETY: test fixture is constructed with the asserted domain shape.

      const result = await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        const emitted: Array<{ signal: string; payload: ProcessTestValue }> = [];
        const calls: Array<{ provider: string; model: string; context: string }> = [];
        let summaryCalls = 0;
        process.sendSignal = async (signal: string, payload: ProcessTestValue) => {
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
                usage: {
                  ...testUsage(301_552, 0),
                  cost: {
                    input: 0.12,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    total: 0.12,
                  },
                },
                stopReason: "error",
                errorMessage: KIMI_WORKERS_CONTEXT_OVERFLOW_ERROR,
                timestamp: Date.now(),
              };
            }
            return {
              role: "assistant",
              content: [
                { type: "text", text: "returned overflow recovered" },
                messageAction("returned overflow recovered", "returned-overflow-message"),
              ],
              api: "test",
              provider: request.config.provider,
              model: request.config.model,
              usage: testUsage(20, 3),
              stopReason: "stop",
              timestamp: Date.now(),
            };
          },
          async generateText() {
            summaryCalls += 1;
            return "Returned overflow compact summary.";
          },
        };

        process.store.appendMessage("user", "old returned overflow context A");
        process.store.appendMessage("assistant", "old returned overflow context B");
        process.store.appendMessage("user", "Returned overflow context that must stay live.", { runId });
        process.store.setValue("historyPolicy", JSON.stringify({
          overflow: "auto-compact",
          compactAtPressure: 0.9,
          compactToPressure: 0.4,
          updatedAt: Date.now(),
        }));
        process.currentRun = {
          runId,
          config: kimiWorkersConfigWithFallback(pid),
          tools: [],
          devices: [],
          systemPrompt: "Test system prompt.",
          approvalPolicy: { default: "auto", rules: [] },
        };

        await process.runTick(runId);
        return {
          calls,
          emitted,
          historyUsage: process.store.getHistoryUsage(),
          messages: process.store.getMessages(),
          segments: process.store.listHistorySegments(),
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
      expect(result.messages.filter((message: any) => message.role !== "toolResult")
        .map((message: any) => [message.role, message.content])).toEqual([
        ["system", expect.stringContaining("Returned overflow compact summary.")],
        ["user", "Returned overflow context that must stay live."],
        ["assistant", "returned overflow recovered"],
      ]);
      const retrying = result.emitted.filter((entry) => entry.signal === "proc.run.retrying");
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
    });

    it("applies fail policy to provider overflow without compacting or using fallback", async () => {
      const pid = "mech-chat-kimi-overflow-policy-fail";
      const runId = "run-chat-kimi-overflow-policy-fail";
      const stub = await initProcess(pid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      const result = await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        const emitted: Array<{ signal: string; payload: ProcessTestValue }> = [];
        const calls: Array<{ provider: string; model: string }> = [];
        let summaryCalls = 0;
        process.sendSignal = async (signal: string, payload: ProcessTestValue) => {
          emitted.push({ signal, payload });
        };
        process.generation = {
          async generate(request: any) {
            calls.push({
              provider: request.config.provider,
              model: request.config.model,
            });
            if (calls.length === 1) {
              throw new Error(KIMI_WORKERS_CONTEXT_OVERFLOW_ERROR);
            }
            return {
              role: "assistant",
              content: [{ type: "text", text: "fallback must not run" }],
              api: "test",
              provider: request.config.provider,
              model: request.config.model,
              stopReason: "stop",
              timestamp: Date.now(),
            };
          },
          async generateText() {
            summaryCalls += 1;
            return "summary must not run";
          },
        };

        process.store.appendMessage("user", "old fail-policy context A");
        process.store.appendMessage("assistant", "old fail-policy context B");
        process.store.appendMessage("user", "Fail-policy context that must stay live.", { runId });
        process.store.setValue("historyPolicy", JSON.stringify({
          overflow: "fail",
          compactAtPressure: 0.9,
          compactToPressure: 0.4,
          updatedAt: Date.now(),
        }));
        process.currentRun = {
          runId,
          config: kimiWorkersConfigWithFallback(pid),
          tools: [],
          devices: [],
          systemPrompt: "Test system prompt.",
          approvalPolicy: { default: "auto", rules: [] },
        };

        await process.runTick(runId);
        return {
          calls,
          currentRun: process.currentRun,
          emitted,
          messages: process.store.getMessages(),
          segments: process.store.listHistorySegments(),
          summaryCalls,
        };
      });

      expect(result.calls).toEqual([
        { provider: "workers-ai", model: "@cf/moonshotai/kimi-k2.6" },
      ]);
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
      expect(result.emitted).toEqual(expect.arrayContaining([
        {
          signal: "proc.run.finished",
          payload: expect.objectContaining({
            runId,
            status: "error",
            reason: "context.policy.fail",
          }),
        },
      ]));
    });

    it("terminates repeated provider overflow after one compaction without using fallback", async () => {
      const pid = "mech-chat-kimi-overflow-repeated";
      const runId = "run-chat-kimi-overflow-repeated";
      const stub = await initProcess(pid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      const result = await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        const emitted: Array<{ signal: string; payload: ProcessTestValue }> = [];
        const calls: Array<{ provider: string; model: string }> = [];
        let summaryCalls = 0;
        process.sendSignal = async (signal: string, payload: ProcessTestValue) => {
          emitted.push({ signal, payload });
        };
        process.generation = {
          async generate(request: any) {
            calls.push({
              provider: request.config.provider,
              model: request.config.model,
            });
            throw new Error(KIMI_WORKERS_CONTEXT_OVERFLOW_ERROR);
          },
          async generateText() {
            summaryCalls += 1;
            return "Repeated overflow compact summary.";
          },
        };

        process.store.appendMessage("user", "old repeated-overflow context A");
        process.store.appendMessage("assistant", "old repeated-overflow context B");
        process.store.appendMessage("user", "Repeated-overflow context that must stay live.", { runId });
        process.store.setValue("historyPolicy", JSON.stringify({
          overflow: "auto-compact",
          compactAtPressure: 0.9,
          compactToPressure: 0.4,
          updatedAt: Date.now(),
        }));
        process.currentRun = {
          runId,
          config: kimiWorkersConfigWithFallback(pid),
          tools: [],
          devices: [],
          systemPrompt: "Test system prompt.",
          approvalPolicy: { default: "auto", rules: [] },
        };

        await process.runTick(runId);
        return {
          calls,
          currentRun: process.currentRun,
          emitted,
          messages: process.store.getMessages(),
          segments: process.store.listHistorySegments(),
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
      const retrying = result.emitted.filter((entry) => entry.signal === "proc.run.retrying");
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
      expect(result.emitted).toEqual(expect.arrayContaining([
        {
          signal: "proc.run.finished",
          payload: expect.objectContaining({
            runId,
            status: "error",
            reason: "context.provider_overflow",
          }),
        },
      ]));
    });

    it("terminates provider overflow when no history prefix can be compacted", async () => {
      const pid = "mech-chat-kimi-overflow-empty-prefix";
      const runId = "run-chat-kimi-overflow-empty-prefix";
      const stub = await initProcess(pid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      const result = await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        const emitted: Array<{ signal: string; payload: ProcessTestValue }> = [];
        const calls: Array<{ provider: string; model: string }> = [];
        let summaryCalls = 0;
        process.sendSignal = async (signal: string, payload: ProcessTestValue) => {
          emitted.push({ signal, payload });
        };
        process.generation = {
          async generate(request: any) {
            calls.push({
              provider: request.config.provider,
              model: request.config.model,
            });
            if (calls.length === 1) {
              throw new Error(KIMI_WORKERS_CONTEXT_OVERFLOW_ERROR);
            }
            return {
              role: "assistant",
              content: [{ type: "text", text: "fallback must not run" }],
              api: "test",
              provider: request.config.provider,
              model: request.config.model,
              stopReason: "stop",
              timestamp: Date.now(),
            };
          },
          async generateText() {
            summaryCalls += 1;
            return "summary must not run";
          },
        };

        process.store.appendMessage("user", "Only live message.", { runId });
        process.store.setValue("historyPolicy", JSON.stringify({
          overflow: "auto-compact",
          compactAtPressure: 0.9,
          compactToPressure: 0.4,
          updatedAt: Date.now(),
        }));
        process.currentRun = {
          runId,
          config: kimiWorkersConfigWithFallback(pid),
          tools: [],
          devices: [],
          systemPrompt: "Test system prompt.",
          approvalPolicy: { default: "auto", rules: [] },
        };

        await process.runTick(runId);
        return {
          calls,
          currentRun: process.currentRun,
          emitted,
          messages: process.store.getMessages(),
          segments: process.store.listHistorySegments(),
          summaryCalls,
        };
      });

      expect(result.calls).toEqual([
        { provider: "workers-ai", model: "@cf/moonshotai/kimi-k2.6" },
      ]);
      expect(result.summaryCalls).toBe(0);
      expect(result.segments).toHaveLength(0);
      expect(result.currentRun).toBeNull();
      expect(result.messages.at(-1)?.content).toContain(
        "Context pressure reached the compaction boundary, but no completed history prefix can be archived.",
      );
      expect(result.emitted.some((entry) => entry.signal === "proc.run.retrying")).toBe(false);
      expect(result.emitted).toEqual(expect.arrayContaining([
        {
          signal: "proc.run.finished",
          payload: expect.objectContaining({
            runId,
            status: "error",
            reason: "context.auto_compact.empty",
          }),
        },
      ]));
    });

    it("surfaces thrown provider context overflow separately from generation errors", async () => {
      const pid = "mech-chat-provider-context-overflow-throw";
      const stub = await initProcess(pid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      const result = await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        const emitted: Array<{ signal: string; payload: ProcessTestValue }> = [];
        process.sendSignal = async (signal: string, payload: ProcessTestValue) => {
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
      expect(systemMessage?.content).toContain(
        "Context pressure reached the compaction boundary, but no completed history prefix can be archived.",
      );
      expect(systemMessage?.content).not.toContain("Generation failed:");
      expect(result.emitted).toEqual(expect.arrayContaining([
        {
          signal: "proc.run.finished",
          payload: expect.objectContaining({
            status: "error",
            reason: "context.auto_compact.empty",
            runId: "run-chat-provider-context-overflow-throw",
          }),
        },
      ]));
    });

    it("surfaces nested thrown provider context overflow separately from generation errors", async () => {
      const pid = "mech-chat-provider-context-overflow-nested";
      const stub = await initProcess(pid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      const result = await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        const emitted: Array<{ signal: string; payload: ProcessTestValue }> = [];
        process.sendSignal = async (signal: string, payload: ProcessTestValue) => {
          emitted.push({ signal, payload });
        };
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
          emitted,
          messages: process.store.getMessages(),
        };
      });

      expect(result.currentRun).toBeNull();
      const systemMessage = result.messages.find((message: any) => message.role === "system");
      expect(systemMessage?.content).toContain(
        "Context pressure reached the compaction boundary, but no completed history prefix can be archived.",
      );
      expect(systemMessage?.content).not.toContain("Generation failed:");
      expect(result.emitted).toEqual(expect.arrayContaining([
        {
          signal: "proc.run.finished",
          payload: expect.objectContaining({
            status: "error",
            reason: "context.auto_compact.empty",
            runId: "run-chat-provider-context-overflow-nested",
          }),
        },
      ]));
    });

    it("surfaces returned provider context overflow and records provider usage", async () => {
      const pid = "mech-chat-provider-context-overflow-response";
      const stub = await initProcess(pid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      const result = await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        const emitted: Array<{ signal: string; payload: ProcessTestValue }> = [];
        process.sendSignal = async (signal: string, payload: ProcessTestValue) => {
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
          contextState: process.store.getContextState(),
          historyUsage: process.store.getHistoryUsage(),
          messages: process.store.getMessages(),
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
      expect(result.emitted).toEqual(expect.arrayContaining([
        {
          signal: "proc.run.finished",
          payload: expect.objectContaining({
            status: "error",
            reason: "context.auto_compact.empty",
            runId: "run-chat-provider-context-overflow-response",
          }),
        },
      ]));
    });

    // SAFETY: test fixture is constructed with the asserted domain shape.
    it("mirrors provider stream events as proc.run.stream signals with fallbacks configured", async () => {
      const pid = "mech-chat-stream";
      const stub = await initProcess(pid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      const emitted = await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        const emitted: Array<{ signal: string; payload: ProcessTestValue }> = [];
        process.sendSignal = async (signal: string, payload: ProcessTestValue) => {
          emitted.push({ signal, payload });
        };
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

      // SAFETY: test fixture is constructed with the asserted domain shape.
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
        seq: 3,
        event: {
          type: "text_delta",
          delta: "he",
        },
      });
      // SAFETY: test fixture is constructed with the asserted domain shape.
      const outputSignal = (emitted as Array<{ signal: string; payload: any }>)
        .find((entry) => entry.signal === "proc.run.output");
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
        await runInDurableObject(stub, async (instance: Process) => {
          // SAFETY: test fixture is constructed with the asserted domain shape.
          const process = instance as any;
          const sink = await process.openRunEventSink(runId);
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
          const frames = await runInDurableObject(kernel, (instance: Kernel) => (
            // SAFETY: test fixture is constructed with the asserted domain shape.
            (instance as any).testRunStreamFrames
          ));
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

    it("keeps generation authoritative when the Kernel rejects stream attachment", async () => {
      const pid = "mech-chat-stream-rejected";
      const runId = "run-chat-stream-rejected";
      const stub = await initProcess(pid, ROOT_IDENTITY, { register: false });

// SAFETY: test fixture is constructed with the asserted domain shape.

      const response = await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        const message = {
          role: "assistant",
          content: [{ type: "text", text: "still completed" }],
          api: "test",
          provider: "test",
          model: "test",
          usage: {
            input: 1,
            output: 2,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 3,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: Date.now(),
        };
        process.currentRun = { runId };
        process.generation = {
          stream() {
            const stream = createAssistantMessageEventStream();
            stream.push({ type: "text_delta", contentIndex: 0, delta: "still completed", partial: message });
            stream.push({ type: "done", reason: "stop", message });
            return stream;
          },
        };

        return await process.generateAssistantResponseLocally({
          runId,
          config: {
            executor: { kind: "process", pid },
            profile: "task",
            provider: "test",
            model: "test",
            apiKey: "",
            reasoning: "off",
            maxTokens: 1024,
            contextWindowTokens: 8192,
            contextWindowSource: "config",
            maxContextBytes: 32768,
          },
          context: { systemPrompt: "", messages: [], tools: [] },
        }, {
          installationId: "singleton",
          logicalRequestId: "inference:test-stream-rejected",
          actor: { localUid: 0, processId: pid, runId },
        });
      });

      expect(response).toMatchObject({
        role: "assistant",
        content: [{ type: "text", text: "still completed" }],
      });
    });

    it("does not open provider event streams from noninteractive workers", async () => {
      const pid = "mech-background-stream";
      const stub = await initProcess(pid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      const sink = await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        process.store.setValue("interactive", "0");
        return await process.openRunEventSink("run-background");
      });

      expect(sink).toBeNull();
    });

    it("retries streamed reasoning-only model turns with monotonic stream sequence numbers", async () => {
      const pid = "mech-chat-stream-retry";
      const stub = await initProcess(pid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      const result = await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        const emitted: Array<{ signal: string; payload: ProcessTestValue }> = [];
        let calls = 0;
        process.sendSignal = async (signal: string, payload: ProcessTestValue) => {
          emitted.push({ signal, payload });
        };
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

        process.store.appendMessage("user", "stream retry please");
        process.currentRun = {
          runId: "run-chat-stream-retry",
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
      expect(result.messages.filter((message: any) => message.role !== "toolResult")
        .map((message: any) => [message.role, message.content])).toEqual([
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
      const outputSignal = result.emitted.find((entry) => entry.signal === "proc.run.output")?.payload as any;
      expect(outputSignal?.text).toBe("visible retry");
    });

    it("emits a retrying signal before a streamed retry succeeds with only tool calls", async () => {
      const pid = "mech-chat-stream-retry-tool-only";
      const stub = await initProcess(pid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      const result = await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        const emitted: Array<{ signal: string; payload: ProcessTestValue }> = [];
        let calls = 0;
        process.sendSignal = async (signal: string, payload: ProcessTestValue) => {
          emitted.push({ signal, payload });
        };
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
          tools: offeredTools("Read"),
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
      // SAFETY: test fixture is constructed with the asserted domain shape.
      const firstErrorIndex = result.emitted.findIndex((entry) =>
        // SAFETY: test fixture is constructed with the asserted domain shape.
        entry.signal === "proc.run.stream" && (entry.payload as any).event.type === "error"
      );
      // SAFETY: test fixture is constructed with the asserted domain shape.
      const secondStartIndex = result.emitted.findIndex((entry, index) =>
        index > retrySignalIndex &&
        entry.signal === "proc.run.stream" &&
        // SAFETY: test fixture is constructed with the asserted domain shape.
        (entry.payload as any).event.type === "start"
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

// SAFETY: test fixture is constructed with the asserted domain shape.

      const emitted = await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        const emitted: Array<{ signal: string; payload: ProcessTestValue }> = [];
        process.sendSignal = async (signal: string, payload: ProcessTestValue) => {
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

      // SAFETY: test fixture is constructed with the asserted domain shape.
      expect((emitted as Array<{ signal: string }>).some((entry) => entry.signal === "proc.run.stream")).toBe(false);
      // SAFETY: test fixture is constructed with the asserted domain shape.
      const outputSignal = (emitted as Array<{ signal: string; payload: any }>)
        .find((entry) => entry.signal === "proc.run.output");
      expect(outputSignal?.payload.text).toBe("hello");
    });

    it("routes kernel text executors through ai.text.generate", async () => {
      const pid = "mech-chat-kernel-executor";
      const stub = await initProcess(pid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      const result = await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        const kernelCalls: Array<{ call: string; args: any }> = [];
        process.sendSignal = async () => {};
        process.kernelRpc = async (call: string, args: any) => {
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
            message: {
              role: "assistant",
              content: [
                { type: "text", text: "kernel hello" },
                messageAction("kernel hello", "kernel-message"),
              ],
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
          tools: expect.arrayContaining([
            expect.objectContaining({ name: "Read" }),
            expect.objectContaining({ name: "Shell" }),
          ]),
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
      expect(result.messages.findLast((message: any) => message.role === "assistant"))
        .toMatchObject({
        role: "assistant",
        content: "kernel hello",
        });
    });

    it("routes device text executors through ai.text.generate target", async () => {
      const pid = "mech-chat-device-executor";
      const stub = await initProcess(pid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      const result = await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
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

// SAFETY: test fixture is constructed with the asserted domain shape.

      const result = await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        const deviceRequests: Array<{ target: string; call: string; args: any; ttlMs?: number }> = [];
        process.sendSignal = async () => {};
        process.kernelRpc = async (call: string, _args: any) => {
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
      expect(result.messages.findLast((message: any) => message.role === "assistant"))
        .toMatchObject({
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
      // SAFETY: test fixture is constructed with the asserted domain shape.
      expect((first as any).data).not.toHaveProperty("replayed");

      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
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

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
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

    it("queues process messages and preserves their run ids", async () => {
      const pid = "mech-send-queued";
      const stub = await initProcess(pid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      // Start first run
      const res1 = (await stub.recvFrame(
        makeReq("proc.send", { message: "First message" }),
      // SAFETY: test fixture is constructed with the asserted domain shape.
      )) as ResponseOkFrame;
      expect(res1.ok).toBe(true);

      // Send second message while run is active — should be queued
      // SAFETY: test fixture is constructed with the asserted domain shape.
      const res2 = (await stub.recvFrame(
        makeReq("proc.send", {
          message: "Second message",
          origin: { kind: "process", sourcePid: "child" },
        }),
      // SAFETY: test fixture is constructed with the asserted domain shape.
      )) as ResponseOkFrame;
      // SAFETY: test fixture is constructed with the asserted domain shape.
      expect((res2.data as any).queued).toBe(true);

      // Fire alarm for run 1 — fails (no AI binding in tests), finishRun dequeues
      // "Second message" and starts run 2
      await runDurableObjectAlarm(stub);
      await waitForRunComplete(stub);

      // Fire alarm for run 2 — fails again, finishRun finds empty queue, done
      await runDurableObjectAlarm(stub);
      await waitForRunComplete(stub);

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const store = (instance as any).store;
        const msgs = store.getMessages();
        const userMsgs = msgs.filter((m: any) => m.role === "user");
        expect(userMsgs).toHaveLength(2);
        expect(userMsgs[0].content).toBe("First message");
        expect(userMsgs[1].content).toBe("Second message");
        // SAFETY: test fixture is constructed with the asserted domain shape.
        expect(userMsgs[0].runId).toBe((res1.data as any).runId);
        // SAFETY: test fixture is constructed with the asserted domain shape.
        expect(userMsgs[1].runId).toBe((res2.data as any).runId);
        expect(store.queueSize()).toBe(0);
        expect(store.getValue("currentRun")).toBeNull();
      });
    });

    it("coalesces overlapping ticks onto the next durable generation", async () => {
      const stub = await initProcess("mech-single-active-tick", ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
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
        process.currentRun = { runId: "run-once" };

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

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        process.sendSignal = vi.fn(async () => {});
        process.currentRun = { runId: "run-failure" };
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

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
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
        process.currentRun = { runId: "run-old" };

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

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        const releaseLifecycle = await process.acquireLifecycleTransition();
        const sending = process.handleProcSend({
          message: "too late",
          origin: { kind: "client", connectionId: "client-1" },
        });
        await Promise.resolve();

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

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
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
          tools: offeredTools("Read"),
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

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        const finishedRuns: string[] = [];
        process.sendSignal = vi.fn();
        process.scheduleTick = vi.fn(async () => {});
        process.emitRunFinished = vi.fn((run: { runId: string }) => {
          finishedRuns.push(run.runId);
        });
        process.currentRun = { runId: "run-original" };

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

// SAFETY: test fixture is constructed with the asserted domain shape.

      try {
        const result = await runInDurableObject(stub, async (instance: Process) => {
          // SAFETY: test fixture is constructed with the asserted domain shape.
          const process = instance as any;
          process.currentRun = { runId: "run-existing" };
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
          currentRun: { runId: "run-existing" },
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

// SAFETY: test fixture is constructed with the asserted domain shape.

        await runInDurableObject(stub, async (instance: Process) => {
          // SAFETY: test fixture is constructed with the asserted domain shape.
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
          // SAFETY: test fixture is constructed with the asserted domain shape.
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

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
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
        // SAFETY: test fixture is constructed with the asserted domain shape.
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

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
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
        process.resolveMediaProcessingOptions = vi.fn(async (media: ProcessTestValue[] | undefined) => {
          if (media?.length) {
            markMediaStarted();
            await mediaBlocked;
          }
          return { ai: process.env.AI };
        });
        process.currentRun = { runId: "run-busy" };
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

        expect(process.store.drainQueue().map((entry: any) => entry.message)).toEqual([
          "first process message",
          "second process message",
        ]);
        process.currentRun = null;
      });
    });

    it("streams an incoming resource into immutable history and hydrates image context blocks", async () => {
      const pid = "mech-send-media";
      const stub = await initProcess(pid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      const upload = (await stub.recvFrame({
        type: "req",
        id: crypto.randomUUID(),
        call: "proc.resource.write",
        args: {
          resourceId: "proof",
          mediaType: "image",
          contentType: "image/png",
          filename: "proof.png",
        },
        body: bodyFromBytes(new Uint8Array([1, 2, 3])),
// SAFETY: test fixture is constructed with the asserted domain shape.
      } satisfies ProcessResourceWriteRequestFrame));
      if (!upload.ok) {
        throw new Error(upload.error.message);
      }
      expect(upload.data).toMatchObject({
        resource: {
          type: "resource",
          ref: {
            size: 3,
            path: expect.stringMatching(/^\/root\/\.gsv\/media\/archived-media:/),
          },
        },
      });
      const uploadedMedia = upload.data.resource;

// SAFETY: test fixture is constructed with the asserted domain shape.

      const res = (await stub.recvFrame(
        makeReq("proc.send", {
          message: "Describe this image.",
          media: [uploadedMedia],
        }),
      // SAFETY: test fixture is constructed with the asserted domain shape.
      )) as ResponseOkFrame;

      expect(res.ok).toBe(true);

// SAFETY: test fixture is constructed with the asserted domain shape.

      await vi.waitFor(async () => {
        const media = await runInDurableObject(stub, (instance: Process) => {
          // SAFETY: test fixture is constructed with the asserted domain shape.
          return (instance as any).store.getMessages()[0]?.media;
        });
        expect(media).toBeTruthy();
      });

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const store = (instance as any).store;
        const record = store.getMessages()[0];
        expect(record.role).toBe("user");
        expect(record.media).toBeTruthy();

        const media = JSON.parse(record.media!);
        expect(media).toHaveLength(1);
        expect(media[0].key).toMatch(/^root\/\.gsv\/media\/archived-media:/);
        expect(media[0].path).toBe(`/${media[0].key}`);

        const stored = await env.STORAGE.get(media[0].key);
        expect(stored).not.toBeNull();
        expect(stored?.customMetadata).toMatchObject({
          uid: "0",
          gid: "0",
          mode: "400",
          purpose: expect.any(String),
        });

        // SAFETY: test fixture is constructed with the asserted domain shape.
        const messages = await (instance as any).buildContextMessages();
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const user = messages[0] as any;
        expect(Array.isArray(user.content)).toBe(true);
        expect(user.content[0]).toEqual({
          type: "text",
          text: [
            "[Directed endpoint: this GSV process.]",
            "Describe this image.",
          ].join("\n"),
        });
        expect(user.content[1]).toEqual({
          type: "text",
          text: `Attached image "proof.png" [image/png] 3 B\nPath: /${media[0].key}`,
        });
        expect(user.content[2].type).toBe("image");
        expect(user.content[2].mimeType).toBe("image/png");
        expect(user.content[2].data).toBe("AQID");
      });
    });

    it("externalizes tool result images before history and rehydrates model image blocks", async () => {
      const pid = "mech-tool-result-media";
      const runId = "run-tool-result-media";
      const dispatchId = "dispatch-tool-result-media";
      const stub = await initProcess(pid, ROOT_IDENTITY);
      let mediaKey = "";

// SAFETY: test fixture is constructed with the asserted domain shape.

      try {
        await runInDurableObject(stub, async (instance: Process) => {
          // SAFETY: test fixture is constructed with the asserted domain shape.
          const process = instance as any;
          process.currentRun = { runId };
          process.sendSignal = vi.fn(async () => {});
          process.store.register(
            dispatchId,
            "call-tool-result-media",
            runId,
            "fs.read",
            { path: "/dev/camera/back/snapshot" },
          );
          process.store.register(
            "dispatch-tool-result-blocker",
            "call-tool-result-blocker",
            runId,
            "fs.read",
            { path: "/tmp/blocker" },
          );

          await expect(process.resolveStartedTool(runId, dispatchId, {
            ok: true,
            path: "/dev/camera/back/snapshot",
            kind: "image",
            contentType: "image/png",
            size: 3,
            content: [
              { type: "text", text: "Read image /dev/camera/back/snapshot [image/png, 3 B]" },
              { type: "image", data: "AQID", mimeType: "image/png" },
            ],
          })).resolves.toBe(true);

          const resolved = process.store.getResults(runId)[0];
          expect(JSON.stringify(resolved.result)).not.toContain("AQID");
          expect(resolved.result).toMatchObject({
            __gsvStoredToolResult: 1,
            output: {
              content: [
                { type: "text" },
                {
                  type: "image",
                  mimeType: "image/png",
                  path: expect.stringMatching(`^/var/media/0/${pid}/`),
                  size: 3,
                },
              ],
            },
          });

          await process.ingestToolResults(runId, process.store.getResults(runId), {
            interruptPending: "test completed",
          });
          const record = process.store.getMessages().find(
            (message: any) => message.toolCallId === "call-tool-result-media",
          );
          expect(record.content).not.toContain("AQID");
          const media = JSON.parse(record.media);
          expect(media).toHaveLength(1);
          mediaKey = media[0].key;

          const stored = await env.STORAGE.get(mediaKey);
          expect(stored && [...new Uint8Array(await stored.arrayBuffer())]).toEqual([1, 2, 3]);
          expect(stored?.customMetadata).toMatchObject({
            uid: "0",
            gid: "0",
            mode: "400",
            processId: pid,
            purpose: "tool-result-media",
          });

          const messages = await process.buildContextMessages();
          const result = messages.find(
            (message: any) => message.role === "toolResult"
              && message.toolCallId === "call-tool-result-media",
          );
          expect(result.content.some((block: any) => block.type === "image" && block.data === "AQID"))
            .toBe(true);

          const history = await process.handleProcHistory({});
          const historyResult = history.messages.find(
            (message: any) => message.content?.toolCallId === "call-tool-result-media",
          );
          expect(historyResult.content.media).toEqual([
            expect.objectContaining({
              type: "image",
              mimeType: "image/png",
              key: mediaKey,
              path: `/${mediaKey}`,
            }),
          ]);
        });
      } finally {
        if (mediaKey) await env.STORAGE.delete(mediaKey);
      }
    });

    it("cancels resource retention by request id", async () => {
      const pid = "mech-resource-retain-cancel";
      const sourcePath = "/root/resource-retain-cancel.png";
      const sourceKey = sourcePath.slice(1);
      const bytes = new Uint8Array([1, 2, 3]);
      await env.STORAGE.put(sourceKey, bytes, {
        httpMetadata: { contentType: "image/png" },
      });
      const source = await env.STORAGE.head(sourceKey);
      if (!source) throw new Error("fixture source was not stored");
      const stub = await initProcess(pid, ROOT_IDENTITY);

      try {
        await runInDurableObject(stub, async (instance: Process) => {
          // SAFETY: this test exercises private Process storage inside its own DO.
          const process = instance as any;
          let retainedKey = "";
          let releaseStored!: () => void;
          let markStored!: () => void;
          const stored = new Promise<void>((resolve) => {
            markStored = resolve;
          });
          const storedGate = new Promise<void>((resolve) => {
            releaseStored = resolve;
          });
          const realPut = process.storage.put.bind(process.storage);
          process.storage.put = vi.fn(async (...args: Parameters<R2Bucket["put"]>) => {
            const object = await realPut(...args);
            retainedKey = args[0];
            markStored();
            await storedGate;
            return object;
          });
          const request: ProcessResourcesRetainRequestFrame = {
            type: "req",
            id: "retain-cancelled",
            call: "proc.resources.retain",
            args: {
              batchId: "retain-cancelled",
              resources: [{
                type: "resource",
                ref: {
                  type: "file",
                  target: "gsv",
                  path: sourcePath,
                  revision: source.httpEtag,
                  contentType: "image/png",
                  size: bytes.byteLength,
                },
              }],
            },
          };

          const retaining = instance.recvFrame(request);
          await stored;
          await instance.recvFrame({
            type: "sig",
            signal: REQUEST_CANCEL_SIGNAL,
            payload: { id: request.id, reason: "Send cancelled" },
          });
          releaseStored();

          await expect(retaining).resolves.toMatchObject({
            type: "res",
            id: request.id,
            ok: false,
            error: { message: "Send cancelled" },
          });
          expect(retainedKey).toMatch(/^root\/\.gsv\/media\/archived-media:/);
          expect(await process.storage.head(retainedKey)).toBeNull();
        });
      } finally {
        await env.STORAGE.delete(sourceKey);
      }
    });

    it("does not delete another Process's retained copy when cancellation races", async () => {
      const sourcePath = "/root/resource-retain-cross-process.png";
      const sourceKey = sourcePath.slice(1);
      const bytes = new Uint8Array([4, 5, 6]);
      await env.STORAGE.put(sourceKey, bytes, {
        httpMetadata: { contentType: "image/png" },
      });
      const source = await env.STORAGE.head(sourceKey);
      if (!source) throw new Error("fixture source was not stored");
      const successfulStub = await initProcess("mech-resource-retain-owner", ROOT_IDENTITY);
      const cancelledStub = await initProcess("mech-resource-retain-cancelled", ROOT_IDENTITY);
      let successfulKey = "";
      let cancelledKey = "";

      const request = (
        id: string,
      ): ProcessResourcesRetainRequestFrame => ({
        type: "req",
        id,
        call: "proc.resources.retain",
        args: {
          batchId: id,
          resources: [{
            type: "resource",
            ref: {
              type: "file",
              target: "gsv",
              path: sourcePath,
              revision: source.httpEtag,
              contentType: "image/png",
              size: bytes.byteLength,
            },
          }],
        },
      });

      try {
        await runInDurableObject(successfulStub, async (instance: Process) => {
          const response = await instance.recvFrame(request("retain-successful"));
          if (!response || response.type !== "res" || !response.ok) {
            throw new Error("successful Process did not retain the fixture");
          }
          successfulKey = response.data.resources[0].ref.path.replace(/^\/+/, "");
          expect(await env.STORAGE.head(successfulKey)).not.toBeNull();
        });

        await runInDurableObject(cancelledStub, async (instance: Process) => {
          // SAFETY: this test exercises private Process storage inside its own DO.
          const process = instance as any;
          let firstArchiveHead = true;
          let releaseStored!: () => void;
          let markStored!: () => void;
          const stored = new Promise<void>((resolve) => {
            markStored = resolve;
          });
          const storedGate = new Promise<void>((resolve) => {
            releaseStored = resolve;
          });
          const realHead = process.storage.head.bind(process.storage);
          process.storage.head = vi.fn(async (key: string) => {
            if (firstArchiveHead && key.startsWith("root/.gsv/media/archived-media:")) {
              firstArchiveHead = false;
              return null;
            }
            return realHead(key);
          });
          const realPut = process.storage.put.bind(process.storage);
          process.storage.put = vi.fn(async (...args: Parameters<R2Bucket["put"]>) => {
            const object = await realPut(...args);
            cancelledKey = args[0];
            markStored();
            await storedGate;
            return object;
          });
          const retaining = instance.recvFrame(request("retain-cancelled-cross-process"));
          await stored;
          await instance.recvFrame({
            type: "sig",
            signal: REQUEST_CANCEL_SIGNAL,
            payload: { id: "retain-cancelled-cross-process", reason: "Send cancelled" },
          });
          releaseStored();

          await expect(retaining).resolves.toMatchObject({
            type: "res",
            id: "retain-cancelled-cross-process",
            ok: false,
            error: { message: "Send cancelled" },
          });
          expect(cancelledKey).not.toBe(successfulKey);
          expect(await env.STORAGE.head(cancelledKey)).toBeNull();
          expect(await env.STORAGE.head(successfulKey)).not.toBeNull();
        });
      } finally {
        await env.STORAGE.delete([sourceKey, successfulKey, cancelledKey].filter(Boolean));
      }
    });

    it("rolls back an incomplete resource retention batch", async () => {
      const pid = "mech-resource-retain-batch-rollback";
      const sourcePath = "/root/resource-retain-batch.png";
      const sourceKey = sourcePath.slice(1);
      const bytes = new Uint8Array([8, 9, 10]);
      await env.STORAGE.put(sourceKey, bytes, {
        httpMetadata: { contentType: "image/png" },
      });
      const source = await env.STORAGE.head(sourceKey);
      if (!source) throw new Error("fixture source was not stored");
      const stub = await initProcess(pid, ROOT_IDENTITY);

      try {
        await runInDurableObject(stub, async (instance: Process) => {
          // SAFETY: this test observes Process-owned archive writes inside its DO.
          const process = instance as any;
          const archivePrefix = "root/.gsv/media/archived-media:";
          const before = (await process.storage.list({ prefix: archivePrefix }))
            .objects.map((object: R2Object) => object.key).sort();
          const request: ProcessResourcesRetainRequestFrame = {
            type: "req",
            id: "retain-batch-rollback",
            call: "proc.resources.retain",
            args: {
              batchId: "delivery:batch-rollback",
              resources: [
                {
                  type: "resource",
                  ref: {
                    type: "file",
                    target: "gsv",
                    path: sourcePath,
                    revision: source.httpEtag,
                    contentType: "image/png",
                    size: bytes.byteLength,
                  },
                },
                {
                  type: "resource",
                  ref: {
                    type: "file",
                    target: "gsv",
                    path: "/root/resource-retain-missing.png",
                    revision: "missing-revision",
                    contentType: "image/png",
                    size: bytes.byteLength,
                  },
                },
              ],
            },
          };

          await expect(instance.recvFrame(request)).resolves.toMatchObject({
            type: "res",
            id: request.id,
            ok: false,
          });
          expect((await process.storage.list({ prefix: archivePrefix }))
            .objects.map((object: R2Object) => object.key).sort()).toEqual(before);
        });
      } finally {
        await env.STORAGE.delete(sourceKey);
      }
    });

    it("retains resources above the model hydration budget", async () => {
      const pid = "mech-resource-retain-large-reference";
      const retainedSize = 26 * 1024 * 1024;
      const sourceRevision = "revision:large-reference";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: this test supplies the R2 metadata contract without allocating a 26 MiB body.
        const process = instance as any;
        const realHead = process.storage.head.bind(process.storage);
        const head = vi.spyOn(process.storage, "head").mockImplementation(async (key: string) => {
          if (!key.startsWith("root/.gsv/media/archived-media:")) {
            return await realHead(key);
          }
          // SAFETY: the fixture supplies the complete R2Object metadata surface used by Process.
          return {
            key,
            version: "version:large-reference",
            size: retainedSize,
            etag: "etag:large-reference",
            httpEtag: "etag:large-reference",
            uploaded: new Date(0),
            httpMetadata: { contentType: "application/octet-stream" },
            customMetadata: {
              uid: "0",
              gid: "0",
              mode: "400",
              purpose: "resource",
              sourceEtag: sourceRevision,
              sourceContentType: "application/octet-stream",
            },
            range: undefined,
            checksums: {},
            writeHttpMetadata() {},
          } as R2Object;
        });
        const request: ProcessResourcesRetainRequestFrame = {
          type: "req",
          id: "retain-large-reference",
          call: "proc.resources.retain",
          args: {
            batchId: "delivery:large-reference",
            resources: [{
              type: "resource",
              ref: {
                type: "file",
                target: "machine:camera",
                path: "/captures/large.raw",
                revision: sourceRevision,
                contentType: "application/octet-stream",
                size: retainedSize,
              },
            }],
          },
        };

        try {
          await expect(instance.recvFrame(request)).resolves.toMatchObject({
            type: "res",
            id: request.id,
            ok: true,
            data: { resources: [{ ref: { size: retainedSize } }] },
          });
        } finally {
          head.mockRestore();
        }
      });
    });

    it("retains fs.read resources without storing transport base64", async () => {
      const pid = "mech-tool-result-resource";
      const runId = "run-tool-result-resource";
      const dispatchId = "dispatch-tool-result-resource";
      const sourcePath = "/root/tool-result-resource.png";
      const sourceKey = sourcePath.slice(1);
      const bytes = new Uint8Array([7, 8, 9]);
      await env.STORAGE.put(sourceKey, bytes, {
        httpMetadata: { contentType: "image/png" },
      });
      const source = await env.STORAGE.head(sourceKey);
      if (!source) throw new Error("fixture source was not stored");
      const stub = await initProcess(pid, ROOT_IDENTITY);
      let retainedKey = "";

      try {
        await runInDurableObject(stub, async (instance: Process) => {
          // SAFETY: this test exercises private Process lifecycle seams inside its own DO instance.
          const process = instance as any;
          process.currentRun = { runId };
          process.sendSignal = vi.fn(async () => {});
          process.store.register(
            dispatchId,
            "call-tool-result-resource",
            runId,
            "fs.read",
            { path: sourcePath },
          );
          process.store.register(
            "dispatch-tool-result-resource-blocker",
            "call-tool-result-resource-blocker",
            runId,
            "fs.read",
            { path: "/tmp/blocker" },
          );

          const resource = {
            type: "file" as const,
            target: "gsv",
            path: sourcePath,
            revision: source.httpEtag,
            contentType: "image/png",
            size: bytes.byteLength,
          };
          await expect(process.resolveStartedTool(runId, dispatchId, {
            ok: true,
            path: sourcePath,
            kind: "image",
            contentType: "image/png",
            size: bytes.byteLength,
            resource,
            content: [
              { type: "text", text: "Read image" },
              { type: "resource", ref: resource },
            ],
          })).resolves.toBe(true);

          const resolved = process.store.getResults(runId)[0];
          expect(JSON.stringify(resolved.result)).not.toContain("BwgJ");
          expect(resolved.result).toMatchObject({
            __gsvStoredToolResult: 1,
            output: {
              resource: {
                type: "file",
                target: "gsv",
                path: expect.stringMatching(/^\/root\/\.gsv\/media\/archived-media:/),
                revision: expect.any(String),
              },
              content: [
                { type: "text" },
                {
                  type: "resource",
                  ref: {
                    target: "gsv",
                    path: expect.stringMatching(/^\/root\/\.gsv\/media\/archived-media:/),
                  },
                },
              ],
            },
          });
          retainedKey = resolved.result.media[0].key;
          const retained = await env.STORAGE.get(retainedKey);
          expect(retained && [...new Uint8Array(await retained.arrayBuffer())]).toEqual([7, 8, 9]);
          expect(retained?.customMetadata).toMatchObject({
            uid: "0",
            gid: "0",
            mode: "400",
            purpose: "resource",
            sourceEtag: source.httpEtag,
            sourceContentType: "image/png",
          });

          await process.ingestToolResults(runId, process.store.getResults(runId), {
            interruptPending: "test completed",
          });
          const history = await process.handleProcHistory({});
          expect(history.messages.find((message: any) => message.role === "toolResult"))
            .toMatchObject({
              content: {
                resources: [{
                  type: "resource",
                  ref: {
                    type: "file",
                    target: "gsv",
                    path: expect.stringMatching(/^\/root\/\.gsv\/media\/archived-media:/),
                    revision: expect.any(String),
                    contentType: "image/png",
                    size: bytes.byteLength,
                  },
                }],
              },
            });
          const messages = await process.buildContextMessages();
          const result = messages.find(
            (message: any) => message.role === "toolResult"
              && message.toolCallId === "call-tool-result-resource",
          );
          expect(result.content.some((block: any) => block.type === "image" && block.data === "BwgJ"))
            .toBe(true);
        });
      } finally {
        await env.STORAGE.delete(sourceKey);
        if (retainedKey) await env.STORAGE.delete(retainedKey);
      }
    });

    it("reconciles repeated process media writes and drains the repeated body", async () => {
      const pid = "mech-media-write-idempotent";
      const stub = await initProcess(pid, ROOT_IDENTITY);
      // SAFETY: test fixture is constructed with the asserted domain shape.
      const args = {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        type: "image" as const,
        mimeType: "image/png",
        filename: "provider-image.png",
        mediaId: "provider-message-1:image-1",
      };

// SAFETY: test fixture is constructed with the asserted domain shape.

      const first = await runInDurableObject(stub, (instance: Process) =>
        (instance as any).storeIncomingResource(
          args,
          bodyFromBytes(new Uint8Array([1, 2, 3])),
        ));
      expect(first).toMatchObject({
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
      // SAFETY: test fixture is constructed with the asserted domain shape.
      const originalMedia = (first as any).media;

      let repeatedBodyPulled = false;
      const repeatedBody = new ReadableStream<Uint8Array>({
        pull(controller) {
          repeatedBodyPulled = true;
          controller.enqueue(new Uint8Array([9, 9, 9]));
          controller.close();
        },
      }, { highWaterMark: 0 });
      // SAFETY: test fixture is constructed with the asserted domain shape.
      const repeated = await runInDurableObject(stub, (instance: Process) =>
        (instance as any).storeIncomingResource(
          args,
          { stream: repeatedBody, length: 3 },
        ));

      expect(repeatedBodyPulled).toBe(true);
      expect(repeated).toEqual({ ok: true, media: originalMedia });

// SAFETY: test fixture is constructed with the asserted domain shape.

      const mimeConflict = await runInDurableObject(stub, (instance: Process) =>
        (instance as any).storeIncomingResource(
          { ...args, mimeType: "image/jpeg" },
          bodyFromBytes(new Uint8Array([4, 5, 6])),
        ));
      expect(mimeConflict).toEqual({
        ok: false,
        error: "Resource id conflicts with existing media",
      });
      // SAFETY: test fixture is constructed with the asserted domain shape.
      for (const conflictingArgs of [
        // SAFETY: test fixture is constructed with the asserted domain shape.
        { ...args, type: "document" as const },
        // SAFETY: test fixture is constructed with the asserted domain shape.
        { ...args, filename: "different-provider-image.png" },
        { ...args, duration: 12 },
        { ...args, transcription: "different transcript" },
      ]) {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const conflict = await runInDurableObject(stub, (instance: Process) =>
          (instance as any).storeIncomingResource(
            conflictingArgs,
            bodyFromBytes(new Uint8Array([4, 5, 6])),
          ));
        expect(conflict).toEqual({
          ok: false,
          error: "Resource id conflicts with existing media",
        });
      }

      const stored = await env.STORAGE.get(originalMedia.key);
      expect(stored).not.toBeNull();
      expect([...new Uint8Array(await new Response(stored!.body).arrayBuffer())]).toEqual([1, 2, 3]);
    });

    it("serializes concurrent repeated media writes into one storage put", async () => {
      const pid = "mech-media-write-concurrent-idempotent";
      const stub = await initProcess(pid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      const result = await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        const originalStorage = process.storage;
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
        process.storage = {
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
        };

// SAFETY: test fixture is constructed with the asserted domain shape.

        try {
          const args = {
            // SAFETY: test fixture is constructed with the asserted domain shape.
            type: "image" as const,
            mimeType: "image/png",
            filename: "concurrent.png",
            mediaId: "provider-message-2:image-1",
          };
          const first = process.storeIncomingResource(
            args,
            bodyFromBytes(new Uint8Array([1, 2, 3])),
          );
          await putStarted;
          const repeated = process.storeIncomingResource(
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
          process.storage = originalStorage;
          releasePut();
        }
      });

      expect(result.putCalls).toBe(1);
      expect(result.repeatedResult).toEqual(result.firstResult);
      expect(result.storedBytes).toEqual([1, 2, 3]);
    });

    it("keeps SVG attachments out of raster model image blocks", async () => {
      const stub = await initProcess("mech-svg-context", ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        const originalStorage = process.storage;
        const get = vi.fn();
        process.store.appendMessage("user", "Review this diagram.", {
          media: JSON.stringify([{
            type: "image",
            mimeType: "image/svg+xml",
            key: "var/media/0/mech-svg-context/diagram.svg",
            filename: "diagram.svg",
          }]),
        });
        process.storage = { get };

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
          process.storage = originalStorage;
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

// SAFETY: test fixture is constructed with the asserted domain shape.

      try {
        await runInDurableObject(stub, async (instance: Process) => {
          // SAFETY: test fixture is constructed with the asserted domain shape.
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
            pendingMediaMessageId: messageId,
          };
          process.sendSignal = vi.fn(async () => {});
          process.resolveMediaProcessingOptions = vi.fn(async () => ({ ai: process.env.AI }));

          await process.prepareRunMedia(runId, messageId, media);
        });

        expect(await env.STORAGE.head(ownKey)).toBeNull();
        expect(await env.STORAGE.head(foreignKey)).not.toBeNull();
      } finally {
        await env.STORAGE.delete([ownKey, foreignKey]);
      // SAFETY: test fixture is constructed with the asserted domain shape.
      }
    });

    it("requires the media body descriptor length", async () => {
      const stub = await initProcess("mech-media-length", ROOT_IDENTITY);
      const response = await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: this focused test invokes the private resource-ingress boundary directly.
        const process = instance as any;
        return process.storeIncomingResource({
          type: "image",
          mimeType: "image/png",
        }, {
          stream: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array([1, 2, 3]));
              controller.close();
            },
          }),
        });
      });

      expect(response).toEqual({
        ok: false,
        error: "Resource write requires an exact body length",
      });
    });

    it("rejects the reserved R2 directory-marker media id", async () => {
      const stub = await initProcess("mech-media-reserved-marker", ROOT_IDENTITY);
      const response = await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: this focused test invokes the private resource-ingress boundary directly.
        const process = instance as any;
        return process.storeIncomingResource({
          type: "document",
          mimeType: "application/octet-stream",
          mediaId: ".dir",
        }, bodyFromBytes(new Uint8Array([1])));
      });

      expect(response).toEqual({
        ok: false,
        error: "Resource id is invalid",
      });
    });

    it("deletes an upload that finishes after a process reset", async () => {
      const pid = "mech-media-reset-race";
      const stub = await initProcess(pid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        const originalStorage = process.storage;
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
        process.storage = {
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
        };

        try {
          const writing = process.storeIncomingResource(
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
          process.storage = originalStorage;
          releasePut();
        }
      });
    });

    it("bounds media materialized while building model context", async () => {
      const pid = "mech-bounded-context-media";
      const stub = await initProcess(pid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        const originalStorage = process.storage;
        const arrayBuffer = vi.fn(async () => new Uint8Array([1]).buffer);
        const prefix = `var/media/0/${pid}/`;
        process.store.appendMessage("user", "Review these images.", {
          media: JSON.stringify([
            { type: "image", mimeType: "image/png", key: `${prefix}oversized` },
            { type: "image", mimeType: "image/png", key: `${prefix}first` },
            { type: "image", mimeType: "image/png", key: `${prefix}second` },
          ]),
        });
        process.storage = {
          get: vi.fn(async (key: string) => ({
            size: key.endsWith("oversized") ? 25 * 1024 * 1024 + 1 : 15 * 1024 * 1024,
            arrayBuffer,
            body: { cancel: vi.fn(async () => {}) },
          })),
        };

        try {
          const messages = await process.buildContextMessages("default");
          expect(arrayBuffer).toHaveBeenCalledTimes(1);
          expect(messages[0].content).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: "image", data: "AQ==" }),
          ]));
        } finally {
          process.storage = originalStorage;
        }
      });
    });

    it("does not hydrate out-of-scope media from persisted history", async () => {
      const stub = await initProcess("mech-foreign-context-media", ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        const originalStorage = process.storage;
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
        process.storage = { get };

        try {
          const messages = await process.buildContextMessages("default");
          expect(get).not.toHaveBeenCalled();
          expect(messages[0].content).not.toEqual(expect.arrayContaining([
            expect.objectContaining({ type: "image" }),
          ]));
        } finally {
          process.storage = originalStorage;
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
      // SAFETY: test fixture is constructed with the asserted domain shape.
      await runInDurableObject(target, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        (instance as any).currentRun = {
          runId: "existing-target-run",
        };
      });

      const kernel = await getKernelPtr();
      // SAFETY: test fixture is constructed with the asserted domain shape.
      const response = await runInDurableObject(kernel, (instance: Kernel) =>
        instance.recvFrame(
          sourcePid,
          makeReq("proc.ipc.send", {
            pid: targetPid,
            message: "Please summarize the current build status.",
            metadata: { kind: "delegation" },
          }),
        ),
      // SAFETY: test fixture is constructed with the asserted domain shape.
      ) as ResponseOkFrame;

      expect(response.ok).toBe(true);
      expect(response.data).toMatchObject({
        ok: true,
        status: "started",
        pid: targetPid,
        sourcePid,
        queued: true,
      });

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(target, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        const store = process.store;
        const messages = store.getMessages();
        expect(messages).toHaveLength(0);
        expect(store.queueSize()).toBe(1);
        const queued = store.drainQueue();
        expect(queued[0].message).toContain(`Message from sam (${sourcePid}).`);
        expect(queued[0].message).toContain("Please summarize the current build status.");
        expect(queued[0].message).toContain('"kind": "delegation"');
        expect(process.currentRun).toMatchObject({
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
      // SAFETY: test fixture is constructed with the asserted domain shape.
      const response = await runInDurableObject(kernel, (instance: Kernel) =>
        instance.recvFrame(
          sourcePid,
          makeReq("proc.ipc.send", {
            pid: targetPid,
            message: "This should not cross uid boundaries.",
          }),
        ),
      // SAFETY: test fixture is constructed with the asserted domain shape.
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
      // SAFETY: test fixture is constructed with the asserted domain shape.
      await runInDurableObject(source, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        (instance as any).scheduleTick = async () => {};
      });
      // SAFETY: test fixture is constructed with the asserted domain shape.
      await runInDurableObject(target, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        (instance as any).currentRun = {
          runId: "existing-target-run",
        };
      });

      const kernel = await getKernelPtr();
      // SAFETY: test fixture is constructed with the asserted domain shape.
      const response = await runInDurableObject(kernel, (instance: Kernel) =>
        instance.recvFrame(
          sourcePid,
          makeReq("proc.ipc.call", {
            pid: targetPid,
            message: "Please reply with the status.",
            timeoutMs: 30_000,
          }),
        ),
      // SAFETY: test fixture is constructed with the asserted domain shape.
      ) as ResponseOkFrame;

      expect(response.ok).toBe(true);
      // SAFETY: test fixture is constructed with the asserted domain shape.
      const data = response.data as any;
      expect(data).toMatchObject({
        ok: true,
        status: "started",
        pid: targetPid,
        sourcePid,
        queued: true,
      });
      expect(data.callId).toBeTruthy();
      expect(data.deadlineAt).toBeGreaterThan(Date.now());

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(target, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const store = (instance as any).store;
        const queued = store.drainQueue();
        expect(queued).toHaveLength(1);
        expect(queued[0].message).toContain(`Delegated task from sam (${sourcePid}).`);
        expect(queued[0].message).toContain("Please complete this task before");
        expect(queued[0].message).toContain("Your final answer will be returned to the caller automatically.");
        expect(queued[0].message).not.toContain("Call id:");
        expect(queued[0].message).not.toContain("Reply target:");
        store.enqueue(data.runId, queued[0].message, { origin: "mail" });
      });

      await runInDurableObject(kernel, async (instance: Kernel) => {
        await instance.recvFrame(targetPid, {
          type: "sig",
          signal: "proc.run.finished",
          payload: {
            pid: targetPid,
            runId: data.runId,
            status: "ok",
            reason: "ipc.returned",
            result: { text: "status is green" },
            delivery: { kind: "none" },
          },
        });
      });

      await waitForStoredMessage(source, (message) => (
        message.content.includes(`Task id: \`${data.callId}\``)
      ));

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(source, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        const store = process.store;
        const messages = store.getMessages();
        expect(messages).toHaveLength(1);
        expect(messages[0].role).toBe("system");
        expect(messages[0].content).toContain(`Delegated task from process \`${targetPid}\` finished.`);
        expect(messages[0].content).toContain(`Task id: \`${data.callId}\`.`);
        expect(messages[0].content).toContain("status is green");
        expect(process.currentRun).toMatchObject({
        });
        process.currentRun = null;
      });
    });

    // SAFETY: test fixture is constructed with the asserted domain shape.
    it("returns aborted target runs to IPC callers as errors", async () => {
      const sourcePid = "mech-ipc-abort-source";
      const targetPid = "mech-ipc-abort-target";
      const source = await initProcess(sourcePid, ROOT_IDENTITY);
      await initProcess(targetPid, ROOT_IDENTITY);
      // SAFETY: test fixture is constructed with the asserted domain shape.
      await runInDurableObject(source, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        (instance as any).scheduleTick = vi.fn(async () => {});
      });

      const kernel = await getKernelPtr();
      // SAFETY: test fixture is constructed with the asserted domain shape.
      const response = await runInDurableObject(kernel, (instance: Kernel) =>
        instance.recvFrame(
          sourcePid,
          makeReq("proc.ipc.call", {
            pid: targetPid,
            message: "Start a delegated task.",
            timeoutMs: 30_000,
          }),
        ),
      // SAFETY: test fixture is constructed with the asserted domain shape.
      ) as ResponseOkFrame;
      // SAFETY: test fixture is constructed with the asserted domain shape.
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
            result: { text: null },
            delivery: { kind: "none" },
          },
        }),
      );

      await waitForStoredMessage(source, (message) => (
        message.content.includes(`Task id: \`${data.callId}\``)
      ));

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(source, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
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

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(source, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        (instance as any).scheduleTick = vi.fn(async () => {});
      });
      // SAFETY: test fixture is constructed with the asserted domain shape.
      await runInDurableObject(target, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        process.currentRun = { runId: "target-busy-run" };
      });

// SAFETY: test fixture is constructed with the asserted domain shape.

      const firstSend = (await source.recvFrame(makeReq("proc.send", {
        message: "delegate a slow task",
        origin: { kind: "client", connectionId: "client-1" },
      // SAFETY: test fixture is constructed with the asserted domain shape.
      }))) as ResponseOkFrame;
      // SAFETY: test fixture is constructed with the asserted domain shape.
      const sourceRunId = (firstSend.data as any).runId as string;

      const kernel = await getKernelPtr();
      // SAFETY: test fixture is constructed with the asserted domain shape.
      const ipcResponse = await runInDurableObject(kernel, (instance: Kernel) =>
        instance.recvFrame(sourcePid, {
          ...makeReq("proc.ipc.call", {
            pid: targetPid,
            message: "wait for the slow task",
            timeoutMs: 30_000,
          }),
          runId: sourceRunId,
        }),
      // SAFETY: test fixture is constructed with the asserted domain shape.
      ) as ResponseOkFrame;
      // SAFETY: test fixture is constructed with the asserted domain shape.
      const ipc = ipcResponse.data as any;
      expect(ipc).toMatchObject({ ok: true, queued: true });

// SAFETY: test fixture is constructed with the asserted domain shape.

      const secondSend = (await source.recvFrame(makeReq("proc.send", {
        message: "stop waiting and do this instead",
        origin: { kind: "client", connectionId: "client-1" },
      // SAFETY: test fixture is constructed with the asserted domain shape.
      }))) as ResponseOkFrame;
      // SAFETY: test fixture is constructed with the asserted domain shape.
      const successorRunId = (secondSend.data as any).runId as string;

      await vi.waitFor(async () => {
        expect(await runInDurableObject(kernel, (instance: Kernel) => (
          // SAFETY: test fixture is constructed with the asserted domain shape.
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
        // SAFETY: test fixture is constructed with the asserted domain shape.
        expect((instance as any).ipcCalls.get(ipc.callId)).toBeNull();
      });

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(source, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        expect(process.currentRun).toMatchObject({ runId: successorRunId });
        expect(process.store.getMessages().some((message: any) => (
          message.role === "system"
          && (message.content.includes(`Task id: \`${ipc.callId}\``)
            || message.content.includes("late delegated result"))
        ))).toBe(false);
        process.currentRun = null;
      });
      // SAFETY: test fixture is constructed with the asserted domain shape.
      await runInDurableObject(target, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        process.currentRun = null;
        process.store.clearQueue();
      });
    });

    it("drops IPC replies for a source run that was already aborted", async () => {
      const pid = "mech-ipc-aborted-source-run";
      const stub = await initProcess(pid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        process.sendSignal = vi.fn();
        process.scheduleTick = vi.fn(async () => {});
        process.rememberAbortedRun("run-aborted");
        process.currentRun = { runId: "run-successor" };

// SAFETY: test fixture is constructed with the asserted domain shape.

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
        // SAFETY: test fixture is constructed with the asserted domain shape.
        } as any);

        expect(process.store.getMessages()).toEqual([]);
        expect(process.store.queueSize()).toBe(0);
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

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
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

    it("keeps an overdue delegation open for its eventual reply", async () => {
      const pid = "mech-ipc-overdue-source";
      const stub = await initProcess(pid, ROOT_IDENTITY);
      const callId = "call-overdue";
      const createdAt = Date.now() - 1_000;

      await stub.recvFrame({
        type: "sig",
        signal: "ipc.overdue",
        payload: {
          callId,
          sourcePid: pid,
          targetPid: "target-process",
          runId: "target-run",
          createdAt,
          deadlineAt: Date.now(),
          nextCheckAt: Date.now() + 60_000,
          checkInCount: 1,
          status: "pending",
        },
      });
      await stub.recvFrame({
        type: "sig",
        signal: "ipc.overdue",
        payload: {
          callId,
          sourcePid: pid,
          targetPid: "target-process",
          runId: "target-run",
          createdAt,
          deadlineAt: Date.now() + 1_000,
          nextCheckAt: Date.now() + 61_000,
          checkInCount: 1,
          status: "pending",
        },
      });
      await stub.recvFrame({
        type: "sig",
        signal: "ipc.reply",
        payload: {
          callId,
          sourcePid: pid,
          targetPid: "target-process",
          runId: "target-run",
          createdAt: Date.now() - 1_000,
          deadlineAt: Date.now(),
          status: "completed",
          response: { text: "eventual result", usage: null },
        },
      });

      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        const messages = process.store.getMessages();
        expect(messages.filter((message: any) => (
          message.content.includes("is still running")
        ))).toHaveLength(1);
        expect(messages.some((message: any) => (
          message.content.includes("eventual result")
        ))).toBe(true);
        process.currentRun = null;
      });
    });

    it("deduplicates retried IPC terminal delivery by call id", async () => {
      const pid = "mech-ipc-deduplicated-reply";
      const stub = await initProcess(pid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        process.sendSignal = vi.fn();
        process.scheduleTick = vi.fn(async () => {});
        // SAFETY: test fixture is constructed with the asserted domain shape.
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
        // SAFETY: test fixture is constructed with the asserted domain shape.
        } as const;

        // SAFETY: test fixture is constructed with the asserted domain shape.
        await instance.recvFrame(frame as any);
        // SAFETY: test fixture is constructed with the asserted domain shape.
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

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        process.sendSignal = vi.fn();
        process.scheduleTick = vi.fn(async () => {});
        process.currentRun = { runId: "run-active" };

// SAFETY: test fixture is constructed with the asserted domain shape.

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
        // SAFETY: test fixture is constructed with the asserted domain shape.
        } as any);

        expect(process.store.getMessages()).toEqual([
          expect.objectContaining({
            role: "system",
            content: expect.stringContaining("delegated result for an older run"),
          }),
        ]);
        expect(process.currentRun).toMatchObject({
          runId: "run-active",
        });
        expect(process.currentRun).not.toHaveProperty("pendingRuntimeEvents");
        const queued = process.store.drainQueue();
        expect(queued).toHaveLength(1);
        expect(queued[0]).toMatchObject({
          role: "system",
          kind: "runtime.wake",
        });
        expect(queued[0].message).toContain("Review the GSV event above");
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

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(source, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        process.scheduleTick = vi.fn(async () => {});
        process.currentRun = {
          runId: "active-source-run",
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
          response: {
            text: "busy result",
            usage: null,
            media: [{
              type: "video",
              mimeType: "video/mp4",
              key: `home/worker/.gsv/media/archived-media:${"a".repeat(64)}`,
              path: `/home/worker/.gsv/media/archived-media:${"a".repeat(64)}`,
              filename: "clip.mp4",
              size: 1234,
            }],
          },
        },
      });

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(source, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        const messages = process.store.getMessages();
        expect(messages).toHaveLength(1);
        expect(messages[0].role).toBe("system");
        expect(messages[0].content).toContain(`Delegated task from process \`${targetPid}\` finished.`);
        expect(messages[0].content).toContain("busy result");
        expect(messages[0].content).toContain("Attachments:");
        expect(messages[0].content).toContain(`/home/worker/.gsv/media/archived-media:${"a".repeat(64)}`);
        expect(process.currentRun).toMatchObject({
          runId: "active-source-run",
          pendingRuntimeEvents: 1,
        });
        expect(process.store.queueSize()).toBe(0);
        expect(process.scheduleTick).not.toHaveBeenCalled();
      });

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(source, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        await process.finishRun("active-source-run", {
          reason: "turn.complete",
          status: "ok",
          text: "parent finished before reading the event",
        });
      });

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(source, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        const runtimeMessages = process.store.getMessages()
          .filter((message: any) => message.role === "system");
        expect(runtimeMessages.at(-1)?.content).toContain("A runtime event arrived while you were busy.");
        expect(process.store.getMessages().some((message: any) => (
          message.role === "user" && message.content.includes("A runtime event arrived while you were busy.")
        ))).toBe(false);
        expect(process.store.queueSize()).toBe(0);
        expect(process.currentRun?.runId).not.toBe("active-source-run");
        expect(process.currentRun).toMatchObject({});
        process.currentRun = null;
      });
    });

    it("uses a busy bounded IPC reply on the next tool-result turn", async () => {
      const sourcePid = "mech-ipc-next-turn-source";
      const targetPid = "mech-ipc-next-turn-target";
      const source = await initProcess(sourcePid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      const result = await runInDurableObject(source, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        const generatedInputs: string[] = [];
        process.sendSignal = async () => {};
        process.generation = {
          async generate(request: any) {
            generatedInputs.push(JSON.stringify(request.context.messages));
            return {
              role: "assistant",
              content: [
                { type: "text", text: "used delegated result" },
                messageAction("used delegated result", "delegated-result-message"),
              ],
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
          config: {
            ...terminalTestConfig(sourcePid),
            provider: "workers-ai",
            model: "@cf/test/model",
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
        expect(process.store.queueSize()).toBe(0);

        await process.runTick("active-source-turn");

        return {
          generatedInputs,
          queueSize: process.store.queueSize(),
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
      // SAFETY: test fixture is constructed with the asserted domain shape.
      const response = await runInDurableObject(kernel, (instance: Kernel) =>
        instance.recvFrame(
          sourcePid,
          makeReq("proc.ipc.call", {
            pid: targetPid,
            message: `Reply with exactly this token and nothing else: ${token}. Do not call tools.`,
            timeoutMs: 60_000,
          }),
        ),
      // SAFETY: test fixture is constructed with the asserted domain shape.
      ) as ResponseOkFrame;

      expect(response.ok).toBe(true);
      // SAFETY: test fixture is constructed with the asserted domain shape.
      const data = response.data as any;
      expect(data).toMatchObject({
        ok: true,
        status: "started",
        pid: targetPid,
        sourcePid,
      });
      expect(data.callId).toBeTruthy();
      expect(data.runId).toBeTruthy();

      await driveProcessUntilIdle(target, 10_000);

      let replyMessage: any = null;
      const deadline = Date.now() + 5_000;
      // SAFETY: test fixture is constructed with the asserted domain shape.
      while (Date.now() < deadline) {
        replyMessage = await runInDurableObject(source, (instance: Process) => {
          // SAFETY: test fixture is constructed with the asserted domain shape.
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

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(source, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
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
      // SAFETY: test fixture is constructed with the asserted domain shape.
      await runInDurableObject(source, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        (instance as any).scheduleTick = async () => {};
      });

      const kernel = await getKernelPtr();
      // SAFETY: test fixture is constructed with the asserted domain shape.
      const response = await runInDurableObject(kernel, (instance: Kernel) =>
        instance.recvFrame(
          sourcePid,
          makeReq("proc.ipc.call", {
            pid: targetPid,
            message: "This call will timeout in the test.",
            timeoutMs: 10_000,
          }),
        ),
      // SAFETY: test fixture is constructed with the asserted domain shape.
      ) as ResponseOkFrame;

      // SAFETY: test fixture is constructed with the asserted domain shape.
      const data = response.data as any;
      expect(data.ok).toBe(true);

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(kernel, async (instance: Kernel) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const k = instance as any;
        const timedOut = k.ipcCalls.timeout(data.callId, data.deadlineAt + 1);
        expect(timedOut).toBeTruthy();
        await k.deliverIpcCall(data.callId);
      });

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(source, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
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

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
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

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
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

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
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

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        process.scheduleTick = async () => {};
        process.currentRun = {
          runId: "active-run",
        };
      });

// SAFETY: test fixture is constructed with the asserted domain shape.

      const response = await stub.recvFrame(makeReq("proc.ipc.deliver", {
        runId: "queued-ipc-run",
        sourcePid: "source-process",
        source: ROOT_IDENTITY,
        message: "Queued IPC work.",
        metadata: { priority: "normal" },
        sentAt: 1_700_000_000_000,
      // SAFETY: test fixture is constructed with the asserted domain shape.
      })) as ResponseOkFrame;

      expect(response.ok).toBe(true);
      expect(response.data).toMatchObject({
        ok: true,
        status: "started",
        pid,
        sourcePid: "source-process",
        runId: "queued-ipc-run",
        queued: true,
      });

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        const store = process.store;
        expect(store.messageCount()).toBe(0);
        expect(store.queueSize()).toBe(1);
        const queued = store.drainQueue();
        expect(queued[0].message).toContain("Queued IPC work.");
        expect(queued[0].message).toContain('"priority": "normal"');
        process.currentRun = null;
      });
    });
  });

  describe("process history", () => {
    it("exports through a tool-calling assistant message with its tool results", async () => {
      const sourcePid = "mech-history-export-tool-boundary";
      const source = await initProcess(sourcePid, ROOT_IDENTITY);
      // SAFETY: test fixture is constructed with the asserted domain shape.
      const assistantId = await runInDurableObject(source, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const store = (instance as any).store;
        store.appendMessage("user", "Inspect the file.");
        const id = store.appendMessage("assistant", "I will inspect it.", {
          toolCalls: JSON.stringify([{
            type: "toolCall",
            id: "call-export-read",
            name: "Read",
            arguments: { path: "/tmp/example.txt" },
          }]),
        });
        store.appendToolResult(
          "call-export-read",
          "fs.read",
          "file contents",
          false,
        );
        store.appendMessage("assistant", "This must not be exported.");
        return id;
      });

// SAFETY: test fixture is constructed with the asserted domain shape.

      const exportResponse = await source.recvFrame(makeReq("proc.history.export", {
        throughMessageId: assistantId,
      // SAFETY: test fixture is constructed with the asserted domain shape.
      })) as ResponseOkFrame;
      // SAFETY: test fixture is constructed with the asserted domain shape.
      const exported = exportResponse.data as any;
      expect(exported).toMatchObject({
        ok: true,
        sourcePid,
        throughMessageId: assistantId,
        includedLiveSuffix: false,
      });

      const targetPid = "mech-history-import-tool-boundary";
      const target = await initProcess(targetPid, ROOT_IDENTITY);
      // SAFETY: test fixture is constructed with the asserted domain shape.
      const importResponse = await target.recvFrame(makeReq("proc.history.import", {
        archivePaths: exported.archivePaths,
      // SAFETY: test fixture is constructed with the asserted domain shape.
      })) as ResponseOkFrame;
      expect(importResponse.data).toMatchObject({
        ok: true,
        pid: targetPid,
        restoredMessages: 3,
      });

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(target, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        expect((instance as any).store.getMessages().map((message: any) => ({
          role: message.role,
          content: message.content,
          toolCallId: message.toolCallId,
        }))).toEqual([
          { role: "user", content: "Inspect the file.", toolCallId: null },
          { role: "assistant", content: "I will inspect it.", toolCallId: null },
          { role: "toolResult", content: "file contents", toolCallId: "call-export-read" },
        ]);
      });

      await env.STORAGE.delete(exported.archivePaths[0].replace(/^\/+/, ""));
    });

    it("resolves a canonical conversation run to its process input boundary", async () => {
      const sourcePid = "mech-history-export-run-boundary";
      const source = await initProcess(sourcePid, ROOT_IDENTITY);
      const runId = "run:canonical-conversation-message";
      // SAFETY: test fixture is constructed with the asserted domain shape.
      const userId = await runInDurableObject(source, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const store = (instance as any).store;
        const id = store.appendMessage("user", "Branch from this conversation message.", {
          runId,
        });
        store.appendMessage("assistant", "This reply must not be exported.", {
          runId,
        });
        return id;
      });

// SAFETY: test fixture is constructed with the asserted domain shape.

      const exportResponse = await source.recvFrame(makeReq("proc.history.export", {
        throughRunId: runId,
      // SAFETY: test fixture is constructed with the asserted domain shape.
      })) as ResponseOkFrame;
      // SAFETY: test fixture is constructed with the asserted domain shape.
      const exported = exportResponse.data as any;
      expect(exported).toMatchObject({
        ok: true,
        sourcePid,
        throughMessageId: userId,
        includedLiveSuffix: false,
      });

      const target = await initProcess("mech-history-import-run-boundary", ROOT_IDENTITY);
      // SAFETY: test fixture is constructed with the asserted domain shape.
      const importResponse = await target.recvFrame(makeReq("proc.history.import", {
        archivePaths: exported.archivePaths,
      // SAFETY: test fixture is constructed with the asserted domain shape.
      })) as ResponseOkFrame;
      expect(importResponse.data).toMatchObject({
        ok: true,
        restoredMessages: 1,
      });
      // SAFETY: test fixture is constructed with the asserted domain shape.
      await runInDurableObject(target, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        expect((instance as any).store.getMessages().map((message: any) => ({
          role: message.role,
          content: message.content,
          runId: message.runId,
        }))).toEqual([{
          role: "user",
          content: "Branch from this conversation message.",
          runId,
        }]);
      });

      await env.STORAGE.delete(exported.archivePaths[0].replace(/^\/+/, ""));
    });

    it("releases the lifecycle transition while writing a fork archive", async () => {
      const stub = await initProcess("mech-history-export-unlocked", ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        const messageId = process.store.appendMessage("user", "Fork this snapshot.");
        let markArchiveStarted!: () => void;
        let releaseArchive!: () => void;
        const archiveStarted = new Promise<void>((resolve) => {
          markArchiveStarted = resolve;
        });
        const archiveBlocked = new Promise<void>((resolve) => {
          releaseArchive = resolve;
        });
        process.archiveForkMessages = vi.fn(async () => {
          markArchiveStarted();
          await archiveBlocked;
          return "/tmp/fork-history.jsonl.gz";
        });

        const exporting = process.handleHistoryExport({ throughMessageId: messageId });
        await archiveStarted;

        let transitionRelease: (() => void) | undefined;
        let transitionAcquired = false;
        const acquiring = process.acquireLifecycleTransition().then((release: () => void) => {
          transitionRelease = release;
          transitionAcquired = true;
        });
        await Promise.resolve();
        await Promise.resolve();
        const acquiredDuringArchive = transitionAcquired;

        releaseArchive();
        await acquiring;
        transitionRelease?.();
        expect(await exporting).toMatchObject({ ok: true });
        expect(acquiredDuringArchive).toBe(true);
      });
    });

    it("compacts a history prefix into an archived segment", async () => {
      const pid = "mech-conversation-compact";
      const stub = await initProcess(pid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      const messageIds = await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        const store = process.store;
        process.__signals = [];
        process.sendSignal = async (signal: string, payload: ProcessTestValue) => {
          process.__signals.push({ signal, payload });
        };
        return [
          store.appendMessage("user", "old user", {}),
          store.appendMessage("assistant", "old assistant", {}),
          store.appendMessage("user", "keep this", {}),
        ];
      });

// SAFETY: test fixture is constructed with the asserted domain shape.

      const compactRes = (await stub.recvFrame(
        makeReq("proc.history.compact", {
          keepLast: 1,
          summary: "The old exchange established the thread context.",
        }),
      // SAFETY: test fixture is constructed with the asserted domain shape.
      )) as ResponseOkFrame;
      // SAFETY: test fixture is constructed with the asserted domain shape.
      const data = compactRes.data as any;

      expect(data).toMatchObject({
        ok: true,
        pid,
        archivedMessages: 2,
        summaryMessageId: messageIds[0],
        segment: {
          generation: 1,
          kind: "compaction",
          fromMessageId: messageIds[0],
          toMessageId: messageIds[1],
          summaryMessageId: messageIds[0],
        },
      });
      expect(data.archivedTo).toMatch(
        new RegExp(`/root/processes/${encodeURIComponent(pid)}/history/.+\\.jsonl\\.gz$`),
      );

      const archiveKey = data.archivedTo.replace(/^\//, "");
      expect(await env.STORAGE.get(archiveKey)).not.toBeNull();

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const store = (instance as any).store;
        const messages = store.getMessages();
        expect(messages).toHaveLength(2);
        expect(messages[0]).toMatchObject({
          id: messageIds[0],
          role: "system",
        });
        expect(messages[0].content).toContain("Process history compacted.");
        expect(messages[0].content).toContain(data.archivedTo);
        expect(messages[0].content).toContain("The old exchange established the thread context.");
        expect(messages[1]).toMatchObject({
          id: messageIds[2],
          role: "user",
          content: "keep this",
        });
        // SAFETY: test fixture is constructed with the asserted domain shape.
        expect((instance as any).__signals).toEqual([
          {
            signal: "proc.changed",
            payload: expect.objectContaining({
              event: "history.compacted",
              pid,
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

// SAFETY: test fixture is constructed with the asserted domain shape.

      const segmentsRes = (await stub.recvFrame(
        makeReq("proc.history.segments", {}),
      // SAFETY: test fixture is constructed with the asserted domain shape.
      )) as ResponseOkFrame;
      // SAFETY: test fixture is constructed with the asserted domain shape.
      expect((segmentsRes.data as any).segments).toEqual([
        expect.objectContaining({
          id: data.segment.id,
          archivePath: data.archivedTo,
          summaryMessageId: messageIds[0],
        }),
      ]);

    });

    it("builds bounded compaction input from complete JSON records", async () => {
      const pid = "mech-conversation-compact-jsonl";
      const stub = await initProcess(pid, ROOT_IDENTITY);
      let transcript = "";

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        const store = process.store;
        for (let index = 0; index < 5; index += 1) {
          store.appendMessage("user", `${index}:${"x".repeat(index === 0 ? 50_000 : 10_000)}`, {
          });
        }
        store.appendMessage("user", "keep", {});
        process.currentRun = {
          runId: "config-source",
          config: terminalTestConfig(pid),
        };
        const checkpointConfig = process.currentRun.config;
        process.currentRun = null;
        process.resolveCheckpointConfig = async () => checkpointConfig;
        // SAFETY: test fixture is constructed with the asserted domain shape.
        process.generation = {
          async generateText(request: any) {
            // SAFETY: test fixture is constructed with the asserted domain shape.
            const content = request.context.messages[0].content as string;
            transcript = content
              .slice("Process history segment JSONL:\n".length)
              .split("\n\nWrite the replacement summary", 1)[0];
            return "Summary.";
          },
        };
      });

// SAFETY: test fixture is constructed with the asserted domain shape.

      const response = await stub.recvFrame(makeReq("proc.history.compact", {
        keepLast: 1,
        generateSummary: true,
      // SAFETY: test fixture is constructed with the asserted domain shape.
      })) as ResponseOkFrame;
      expect(response.data).toMatchObject({ ok: true, archivedMessages: 5 });
      expect(transcript.length).toBeLessThanOrEqual(24_000);
      const records = transcript.split("\n").map((line) => JSON.parse(line));
      expect(records).toEqual(expect.arrayContaining([
        expect.objectContaining({ record_truncated: true }),
        expect.objectContaining({ omitted_messages: expect.any(Number) }),
      ]));

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        (instance as any).currentRun = null;
      });
    });

    it("discards a generated compaction when its history changes", async () => {
      const pid = "mech-conversation-compact-stale";
      const stub = await initProcess(pid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        process.store.appendMessage("user", "old", {});
        process.store.appendMessage("user", "keep", {});
        process.currentRun = {
          runId: "config-source",
          config: terminalTestConfig(pid),
        };
        const checkpointConfig = process.currentRun.config;
        process.currentRun = null;
        process.resolveCheckpointConfig = async () => checkpointConfig;
        process.generation = {
          async generateText() {
            process.store.resetHistory();
            return "Stale summary.";
          },
        };
      });

      const archivePrefix = `root/processes/${encodeURIComponent(pid)}/history/`;
      const archivesBefore = (await env.STORAGE.list({ prefix: archivePrefix }))
        .objects.map((object) => object.key);
      // SAFETY: test fixture is constructed with the asserted domain shape.
      const response = await stub.recvFrame(makeReq("proc.history.compact", {
        keepLast: 1,
        generateSummary: true,
      // SAFETY: test fixture is constructed with the asserted domain shape.
      })) as ResponseOkFrame;
      expect(response.data).toEqual({ ok: false, error: "History changed during compaction" });
      expect((await env.STORAGE.list({ prefix: archivePrefix }))
        .objects.map((object) => object.key)).toEqual(archivesBefore);
      // SAFETY: test fixture is constructed with the asserted domain shape.
      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        expect(process.store.listHistorySegments()).toHaveLength(0);
        process.currentRun = null;
      });
    });

    it("rejects a concurrent compaction after another summary replaces its prefix", async () => {
      const pid = "mech-conversation-compact-concurrent";
      const stub = await initProcess(pid, ROOT_IDENTITY);
      const archivePrefix = `root/processes/${encodeURIComponent(pid)}/history/`;
      const archivesBefore = (await env.STORAGE.list({ prefix: archivePrefix }))
        .objects.map((object) => object.key);
      // SAFETY: test fixture is constructed with the asserted domain shape.
      const result = await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
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
        process.store.appendMessage("user", "old", {});
        process.store.appendMessage("user", "keep", {});
        process.currentRun = {
          runId: "config-source",
          config: terminalTestConfig(pid),
        };
        const checkpointConfig = process.currentRun.config;
        process.currentRun = null;
        process.resolveCheckpointConfig = async () => checkpointConfig;
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

        const first = process.recvFrame(makeReq("proc.history.compact", {
          keepLast: 1,
          generateSummary: true,
        }));
        await firstStarted;
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const second = await process.recvFrame(makeReq("proc.history.compact", {
          keepLast: 1,
          generateSummary: true,
        // SAFETY: test fixture is constructed with the asserted domain shape.
        })) as ResponseOkFrame;
        releaseFirst();
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const stale = await first as ResponseOkFrame;
        const messages = process.store.getMessages();
        const segments = process.store.listHistorySegments();
        process.currentRun = null;
        return { second, stale, messages, segments };
      });

      expect(result.second.data).toMatchObject({ ok: true, archivedMessages: 1 });
      expect(result.stale.data).toEqual({ ok: false, error: "History changed during compaction" });
      expect(result.messages[0].content).toContain("Second summary.");
      expect(result.segments).toHaveLength(1);
      expect((await env.STORAGE.list({ prefix: archivePrefix })).objects
        .filter((object) => !archivesBefore.includes(object.key)))
        .toHaveLength(1);
    });

    it("rolls back the summary when recording its segment fails", async () => {
      const pid = "mech-conversation-compact-transaction";
      const stub = await initProcess(pid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const store = (instance as any).store;
        store.appendMessage("user", "old", {});
        store.appendMessage("user", "keep", {});
        store.recordHistorySegment = () => {
          throw new Error("segment insert failed");
        };
      });

      const archivePrefix = `root/processes/${encodeURIComponent(pid)}/history/`;
      const archivesBefore = (await env.STORAGE.list({ prefix: archivePrefix }))
        .objects.map((object) => object.key);
      // SAFETY: test fixture is constructed with the asserted domain shape.
      const response = await stub.recvFrame(makeReq("proc.history.compact", {
        keepLast: 1,
        summary: "Summary.",
      // SAFETY: test fixture is constructed with the asserted domain shape.
      })) as ResponseFrame;
      expect(response).toMatchObject({
        ok: false,
        error: { message: "segment insert failed" },
      });
      expect((await env.STORAGE.list({ prefix: archivePrefix }))
        .objects.map((object) => object.key)).toEqual(archivesBefore);
      // SAFETY: test fixture is constructed with the asserted domain shape.
      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        expect((instance as any).store.getMessages())
          .toEqual(expect.arrayContaining([
            expect.objectContaining({ role: "user", content: "old" }),
            expect.objectContaining({ role: "user", content: "keep" }),
          ]));
      });
    });

    it("reads compacted segment archives with pagination", async () => {
      const pid = "mech-conversation-segment-read";
      const stub = await initProcess(pid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const store = (instance as any).store;
        store.appendMessage("user", "old user", { createdAt: 10 });
        store.appendMessage("assistant", "old assistant", { createdAt: 20 });
        store.appendToolResult("tool-1", "fs.read", "permission denied", true);
        store.appendMessage("user", "keep this", { createdAt: 30 });
      });

// SAFETY: test fixture is constructed with the asserted domain shape.

      const compactRes = (await stub.recvFrame(
        makeReq("proc.history.compact", {
          keepLast: 1,
          summary: "Earlier context.",
        // SAFETY: test fixture is constructed with the asserted domain shape.
        }),
      // SAFETY: test fixture is constructed with the asserted domain shape.
      )) as ResponseOkFrame;
      // SAFETY: test fixture is constructed with the asserted domain shape.
      const compactData = compactRes.data as any;

      // SAFETY: test fixture is constructed with the asserted domain shape.
      const firstPageRes = (await stub.recvFrame(
        makeReq("proc.history.segment.read", {
          segmentId: compactData.segment.id,
          limit: 1,
        }),
      // SAFETY: test fixture is constructed with the asserted domain shape.
      )) as ResponseOkFrame;
      // SAFETY: test fixture is constructed with the asserted domain shape.
      const firstPage = firstPageRes.data as any;
      expect(firstPage).toMatchObject({
        ok: true,
        pid,
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

// SAFETY: test fixture is constructed with the asserted domain shape.

      const secondPageRes = (await stub.recvFrame(
        makeReq("proc.history.segment.read", {
          segmentId: compactData.segment.id,
          limit: 1,
          offset: 1,
        }),
      // SAFETY: test fixture is constructed with the asserted domain shape.
      )) as ResponseOkFrame;
      // SAFETY: test fixture is constructed with the asserted domain shape.
      expect((secondPageRes.data as any).messages).toEqual([
        {
          id: expect.any(Number),
          role: "assistant",
          content: {
            text: "old assistant",
            thinking: [],
            toolCalls: [],
          // SAFETY: test fixture is constructed with the asserted domain shape.
          },
          timestamp: 20,
        },
      ]);
      // SAFETY: test fixture is constructed with the asserted domain shape.
      expect((secondPageRes.data as any).truncated).toBe(true);

      // SAFETY: test fixture is constructed with the asserted domain shape.
      const toolResultPageRes = (await stub.recvFrame(
        makeReq("proc.history.segment.read", {
          segmentId: compactData.segment.id,
          limit: 1,
          offset: 2,
        }),
      // SAFETY: test fixture is constructed with the asserted domain shape.
      )) as ResponseOkFrame;
      // SAFETY: test fixture is constructed with the asserted domain shape.
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
      // SAFETY: test fixture is constructed with the asserted domain shape.
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
      // SAFETY: test fixture is constructed with the asserted domain shape.
      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const store = (instance as any).store;
        store.appendMessage("assistant", "Here is the result.", {
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
          createdAt: 30,
        });
      });

// SAFETY: test fixture is constructed with the asserted domain shape.

      const compactRes = await stub.recvFrame(makeReq("proc.history.compact", {
        keepLast: 1,
        summary: "Earlier context.",
      // SAFETY: test fixture is constructed with the asserted domain shape.
      })) as ResponseOkFrame;
      // SAFETY: test fixture is constructed with the asserted domain shape.
      const segment = (compactRes.data as any).segment;
      // SAFETY: test fixture is constructed with the asserted domain shape.
      const segmentRes = await stub.recvFrame(makeReq("proc.history.segment.read", {
        segmentId: segment.id,
      // SAFETY: test fixture is constructed with the asserted domain shape.
      })) as ResponseOkFrame;
      // SAFETY: test fixture is constructed with the asserted domain shape.
      const media = (segmentRes.data as any).messages[0].content.media[0];

      // SAFETY: test fixture is constructed with the asserted domain shape.
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

      const archived = await env.STORAGE.get(media.key);
      expect(archived && [...new Uint8Array(await archived.arrayBuffer())]).toEqual([7, 8, 9]);
    });

    it("rejects compaction while the process is active", async () => {
      const pid = "mech-conversation-compact-active";
      const stub = await initProcess(pid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        const store = process.store;
        store.appendMessage("user", "active message");
        process.currentRun = {
          runId: "run-active-compact",
        };
      });

// SAFETY: test fixture is constructed with the asserted domain shape.

      const compactRes = (await stub.recvFrame(
        makeReq("proc.history.compact", {
          keepLast: 0,
          summary: "Should fail.",
        }),
      // SAFETY: test fixture is constructed with the asserted domain shape.
      )) as ResponseOkFrame;
      expect(compactRes.data).toEqual({
        ok: false,
        error: "Process is active",
      });

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        (instance as any).currentRun = null;
      });
    });

    it("cancels manual archive upload by request id", async () => {
      const pid = "mech-conversation-compact-cancel";
      const stub = await initProcess(pid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        let markStarted!: () => void;
        const started = new Promise<void>((resolve) => {
          markStarted = resolve;
        });
        process.store.appendMessage("user", "old", {});
        process.store.appendMessage("user", "keep", {});
        process.archiveMessageRecords = async (
          _key: string,
          _messages: ProcessTestValue[],
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
          call: "proc.history.compact",
          args: { keepLast: 1, summary: "Summary." },
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
        expect(process.store.listHistorySegments()).toHaveLength(0);
      });
    });

    it("gets and sets process history context policy", async () => {
      const pid = "mech-conversation-policy";
      const stub = await initProcess(pid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      const defaultRes = (await stub.recvFrame(
        makeReq("proc.history.policy.get", {}),
      // SAFETY: test fixture is constructed with the asserted domain shape.
      )) as ResponseOkFrame;
      expect(defaultRes.data).toMatchObject({
        ok: true,
        pid,
        policy: {
          overflow: "auto-compact",
          compactAtPressure: 0.9,
          compactToPressure: 0.4,
          updatedAt: 0,
        },
      });

// SAFETY: test fixture is constructed with the asserted domain shape.

      const setRes = (await stub.recvFrame(
        makeReq("proc.history.policy.set", {
          overflow: "auto-compact",
          compactAtPressure: 0.82,
          compactToPressure: 0.35,
        }),
      // SAFETY: test fixture is constructed with the asserted domain shape.
      )) as ResponseOkFrame;
      expect(setRes.data).toMatchObject({
        ok: true,
        pid,
        policy: {
          overflow: "auto-compact",
          compactAtPressure: 0.82,
          compactToPressure: 0.35,
        },
      });

// SAFETY: test fixture is constructed with the asserted domain shape.

      const nextRes = (await stub.recvFrame(
        makeReq("proc.history.policy.get", {}),
      // SAFETY: test fixture is constructed with the asserted domain shape.
      )) as ResponseOkFrame;
      expect(nextRes.data).toMatchObject({
        ok: true,
        pid,
        policy: {
          overflow: "auto-compact",
          compactAtPressure: 0.82,
          compactToPressure: 0.35,
        },
      });
    });

    it("defaults old stored keep-last policies to the pressure target", async () => {
      const pid = "mech-conversation-policy-legacy-keep-last";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: the Durable Object test fixture exposes Process internals for state setup.
        const process = instance as any;
        process.store.setValue("historyPolicy", JSON.stringify({
          overflow: "auto-compact",
          compactAtPressure: 0.9,
          keepLast: 80,
          updatedAt: 123,
        }));
      });

      // SAFETY: this request is a proc.history.policy.get frame with a successful fixture response.
      const response = await stub.recvFrame(
        makeReq("proc.history.policy.get", {}),
      ) as ResponseOkFrame;
      expect(response.data).toMatchObject({
        ok: true,
        pid,
        policy: {
          overflow: "auto-compact",
          compactAtPressure: 0.9,
          compactToPressure: 0.4,
          updatedAt: 123,
        },
      });
    });

    it("auto-compacts once before falling back while the rebuilt context still fits", async () => {
      const pid = "mech-conversation-auto-compact";
      const stub = await initProcess(pid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      const emitted = await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        const emitted: Array<{ signal: string; payload: ProcessTestValue }> = [];
        process.sendSignal = async (signal: string, payload: ProcessTestValue) => {
          emitted.push({ signal, payload });
        };
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
              content: [
                { type: "text", text: "after compaction" },
                messageAction("after compaction", "auto-compaction-message"),
              ],
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
            expect(request.options).toMatchObject({
              maxTokens: 768,
              reasoning: "off",
              timeoutMs: 180000,
            });
            expect(JSON.stringify(request.context)).toContain("old context A");
            return "Auto compact summary.";
          },
        };

        process.store.appendMessage("user", `old context A ${"x".repeat(4000)}`);
        process.store.appendMessage("assistant", `old context B ${"y".repeat(4000)}`);
        process.store.appendMessage("user", "Context that must stay live.", {
          runId: "run-auto-compact",
        });
        process.store.setValue("historyPolicy", JSON.stringify({
          overflow: "auto-compact",
          compactAtPressure: 0.9,
          compactToPressure: 0.4,
          updatedAt: Date.now(),
        }));
        process.currentRun = {
          runId: "run-auto-compact",
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
            generationTimeoutMs: 180000,
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
          segments: process.store.listHistorySegments(),
        };
      });

      expect(emitted.generationCalls).toBe(2);
      expect(emitted.summaryCalls).toBe(1);
      expect(emitted.messages.filter((message: any) => message.role !== "toolResult")
        .map((message: any) => [message.role, message.content])).toEqual([
        ["system", expect.stringContaining("Auto compact summary.")],
        ["user", "Context that must stay live."],
        ["assistant", "after compaction"],
      ]);
      expect(emitted.segments).toHaveLength(1);
      expect(emitted.segments[0]).toMatchObject({
        kind: "compaction",
      });
      // SAFETY: test fixture is constructed with the asserted domain shape.
      const lifecycleEvents = emitted.emitted
        .filter((entry) => entry.signal === "proc.changed")
        // SAFETY: test fixture is constructed with the asserted domain shape.
        .map((entry) => (entry.payload as any).event)
        .filter(Boolean);
      expect(lifecycleEvents).toEqual([
        "history.compacted",
        "history.auto_compacted",
      ]);
    });

    it("compacts a large recent history to the pressure target instead of recompacting only its summary", async () => {
      const pid = "mech-conversation-auto-compact-pressure-target";
      const runId = "run-auto-compact-pressure-target";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      const result = await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: the Durable Object test fixture exposes Process internals for run setup.
        const process = instance as any;
        const generationContexts: Context[] = [];
        process.sendSignal = async () => {};
        process.generation = {
          async generate(request: any) {
            generationContexts.push(request.context);
            return terminalTestResponse([
              { type: "text", text: "done" },
              messageAction("done", "pressure-target-message"),
            ]);
          },
          async generateText() {
            return "Pressure-target summary.";
          },
        };

        process.store.appendMessage("system", [
          "Process history compacted.",
          "",
          "Archived messages: 200",
          "Archive: /home/root/processes/prior.jsonl.gz",
          "",
          "Summary:",
          "Prior compacted history.",
        ].join("\n"));
        for (let index = 0; index < 79; index += 1) {
          process.store.appendMessage(
            index % 2 === 0 ? "user" : "assistant",
            `large recent message ${index} ${"x".repeat(6000)}`,
          );
        }
        process.store.appendMessage("user", "Current input must stay live.", { runId });
        process.store.setValue("historyPolicy", JSON.stringify({
          overflow: "auto-compact",
          compactAtPressure: 0.9,
          compactToPressure: 0.4,
          updatedAt: Date.now(),
        }));
        process.currentRun = {
          runId,
          config: {
            ...terminalTestConfig(pid),
            generationTimeoutMs: 180000,
          },
          tools: [],
          devices: [],
          systemPrompt: "Test system prompt.",
          approvalPolicy: { default: "auto", rules: [] },
        };

        await process.runTick(runId);
        return {
          generationContext: generationContexts[0],
          messages: process.store.getMessages(),
          segments: process.store.listHistorySegments(),
        };
      });

      expect(result.generationContext).toBeDefined();
      if (!result.generationContext) {
        throw new Error("Expected automatic compaction to reach model generation");
      }
      expect(
        estimateContextInputTokens(result.generationContext)
          / (128000 - 8192),
      ).toBeLessThanOrEqual(0.4);
      expect(result.segments).toHaveLength(1);
      expect(result.segments[0]).toMatchObject({
        kind: "compaction",
        fromMessageId: 1,
      });
      expect(result.segments[0]!.toMessageId).toBeGreaterThan(1);
      expect(result.messages.some((message: any) => (
        message.role === "user" && message.content === "Current input must stay live."
      ))).toBe(true);
    });

    it("stops when the retained tail is still too large after auto-compaction", async () => {
      const pid = "mech-conversation-auto-compact-insufficient";
      const stub = await initProcess(pid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      const result = await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        const emitted: Array<{ signal: string; payload: ProcessTestValue }> = [];
        let generated = false;
        process.sendSignal = async (signal: string, payload: ProcessTestValue) => {
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
        process.store.appendMessage("user", `retained ${"x".repeat(4000)}`, {
          runId: "run-auto-compact-insufficient",
        });
        process.store.setValue("historyPolicy", JSON.stringify({
          overflow: "auto-compact",
          compactAtPressure: 0.5,
          compactToPressure: 0.4,
          updatedAt: Date.now(),
        }));
        process.currentRun = {
          runId: "run-auto-compact-insufficient",
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
          segments: process.store.listHistorySegments(),
        };
      });

      expect(result.generated).toBe(false);
      expect(result.currentRun).toBeNull();
      expect(result.segments).toHaveLength(1);
      expect(result.messages.at(-1)?.content).toContain(
        "Auto-compaction could not reduce this process history to its configured context target.",
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

// SAFETY: test fixture is constructed with the asserted domain shape.

      const result = await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        const emitted: Array<{ signal: string; payload: ProcessTestValue }> = [];
        process.sendSignal = async (signal: string, payload: ProcessTestValue) => {
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
        process.store.appendMessage("user", "Context that must stay live.", {
          runId: "run-auto-compact-provider-billing",
        });
        process.store.setValue("historyPolicy", JSON.stringify({
          overflow: "auto-compact",
          compactAtPressure: 0.01,
          compactToPressure: 0.005,
          updatedAt: Date.now(),
        }));
        process.currentRun = {
          runId: "run-auto-compact-provider-billing",
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
          segments: process.store.listHistorySegments(),
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

// SAFETY: test fixture is constructed with the asserted domain shape.

      const result = await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        const emitted: Array<{ signal: string; payload: ProcessTestValue }> = [];
        process.sendSignal = async (signal: string, payload: ProcessTestValue) => {
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
        process.store.appendMessage("user", "Context that must stay live.", {
          runId: "run-auto-compact-abort",
        });
        process.store.setValue("historyPolicy", JSON.stringify({
          overflow: "auto-compact",
          compactAtPressure: 0.01,
          compactToPressure: 0.005,
          updatedAt: Date.now(),
        }));
        process.currentRun = {
          runId: "run-auto-compact-abort",
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
          segments: process.store.listHistorySegments(),
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
      // SAFETY: test fixture is constructed with the asserted domain shape.
      const lifecycleEvents = result.emitted
        .filter((entry) => entry.signal === "proc.changed")
        // SAFETY: test fixture is constructed with the asserted domain shape.
        .map((entry) => (entry.payload as any).event)
        .filter(Boolean);
      expect(lifecycleEvents).toEqual([]);
    });
  });

  describe("proc.abort", () => {
    it("returns aborted=false when no run is active", async () => {
      const pid = "mech-abort-idle";
      const stub = await initProcess(pid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      const res = (await stub.recvFrame(
        makeReq("proc.abort", {}),
      // SAFETY: test fixture is constructed with the asserted domain shape.
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

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        (instance as any).currentRun = { runId: "run-new" };
      });

// SAFETY: test fixture is constructed with the asserted domain shape.

      const res = (await stub.recvFrame(
        makeReq("proc.abort", { runId: "run-old" }),
      // SAFETY: test fixture is constructed with the asserted domain shape.
      )) as ResponseOkFrame;

      expect(res.data).toMatchObject({ ok: true, pid, aborted: false });
      // SAFETY: test fixture is constructed with the asserted domain shape.
      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        expect(process.currentRun).toMatchObject({ runId: "run-new" });
        process.currentRun = null;
      });
    });

    it("promotes a queued successor without waiting for finish delivery", async () => {
      const pid = "mech-finish-claims-successor";
      const stub = await initProcess(pid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        process.emitRunFinished = vi.fn(() => new Promise<void>(() => {}));
        process.sendSignal = vi.fn();
        process.scheduleTick = vi.fn(async () => {});
        process.currentRun = { runId: "run-old" };
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

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        process.sendSignal = vi.fn(async () => {
          throw new Error("kernel unavailable");
        });
        process.schedule = vi.fn(async () => ({ id: "finish-retry" }));

        process.emitRunFinished(
          { runId: "run-finish-outbox" },
          { reason: "turn.complete", status: "ok", resultText: "done" },
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

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        process.store.setValue("pendingRunFinishes", JSON.stringify([{
          pid: process.pid,
          runId: "run-finish-exhausted",
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

        expect(process.sendSignal).toHaveBeenCalledWith(
          "proc.run.finished",
          expect.objectContaining({
            runId: "run-finish-exhausted",
            result: { text: "completed answer" },
            delivery: { kind: "none" },
          }),
        );
        expect(process.schedule).not.toHaveBeenCalled();
        expect(process.store.getValue("pendingRunFinishes")).toBeNull();
        expect(process.store.getMessages()).toContainEqual(expect.objectContaining({
          role: "system",
          runId: "run-finish-exhausted",
          content: expect.stringContaining(
            "Run completion signaling stopped after repeated transport failures",
          ),
        }));
        expect(process.emitProcChanged).toHaveBeenCalledWith(
          ["messages"],
          expect.objectContaining({
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

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
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

// SAFETY: test fixture is constructed with the asserted domain shape.

      const res = (await stub.recvFrame(
        makeReq("proc.abort", {}),
      // SAFETY: test fixture is constructed with the asserted domain shape.
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

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
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
      // SAFETY: test fixture is constructed with the asserted domain shape.
      const cancelSpy = vi
        // SAFETY: test fixture is constructed with the asserted domain shape.
        .spyOn(Kernel.prototype as any, "cancelProcessRequests")
        .mockReturnValue(3);

// SAFETY: test fixture is constructed with the asserted domain shape.

      try {
        await runInDurableObject(stub, (instance: Process) => {
          // SAFETY: test fixture is constructed with the asserted domain shape.
          const process = instance as any;
          process.currentRun = { runId: "run-1" };
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
        // SAFETY: test fixture is constructed with the asserted domain shape.
        await runInDurableObject(stub, (instance: Process) => {
          // SAFETY: test fixture is constructed with the asserted domain shape.
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
      // SAFETY: test fixture is constructed with the asserted domain shape.
      const recvSpy = vi
        // SAFETY: test fixture is constructed with the asserted domain shape.
        .spyOn(Kernel.prototype as any, "recvFrame")
        .mockImplementation(async (_processId: string, frame: RequestFrame) => {
          await requestBlocked;
          return { type: "res", id: frame.id, ok: true, data: {} };
        });
      // SAFETY: test fixture is constructed with the asserted domain shape.
      const cancelSpy = vi
        // SAFETY: test fixture is constructed with the asserted domain shape.
        .spyOn(Kernel.prototype as any, "cancelProcessRequests")
        .mockReturnValue(1);

// SAFETY: test fixture is constructed with the asserted domain shape.

      try {
        const result = await runInDurableObject(stub, async (instance: Process) => {
          // SAFETY: test fixture is constructed with the asserted domain shape.
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
      // SAFETY: test fixture is constructed with the asserted domain shape.
      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        process.currentRun = { runId: "run-1" };
        process.store.register("dispatch-1", "call-1", "run-1", "fs.search", {});
        process.store.markDispatched("dispatch-1");
      });

// SAFETY: test fixture is constructed with the asserted domain shape.

      const cancelSpy = vi
        // SAFETY: test fixture is constructed with the asserted domain shape.
        .spyOn(Kernel.prototype as any, "cancelProcessRequests")
        .mockImplementation(async function (this: Kernel) {
          // SAFETY: test fixture is constructed with the asserted domain shape.
          const kernel = this as any;
          await new Promise<void>((resolve) => {
            kernel.releaseTestCancellation = resolve;
          });
          // SAFETY: test fixture is constructed with the asserted domain shape.
          kernel.testCancellationFinished = true;
          return 1;
        });
      const kernel = await getKernelPtr();

// SAFETY: test fixture is constructed with the asserted domain shape.

      try {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const response = await runInDurableObject(stub, async (instance: Process) => {
          // SAFETY: test fixture is constructed with the asserted domain shape.
          return await (instance as any).recvFrame(makeReq("proc.abort", {}));
        // SAFETY: test fixture is constructed with the asserted domain shape.
        }) as ResponseOkFrame;
        await vi.waitFor(() => expect(cancelSpy).toHaveBeenCalledOnce());
        expect(response.data).toMatchObject({ ok: true, aborted: true, runId: "run-1" });
      } finally {
        cancelSpy.mockRestore();
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const released = await runInDurableObject(kernel, (instance: Kernel) => {
          // SAFETY: test fixture is constructed with the asserted domain shape.
          const release = (instance as any).releaseTestCancellation;
          if (release == null) {
            return false;
          }
          release();
          return true;
        });
        // SAFETY: test fixture is constructed with the asserted domain shape.
        if (released) {
          await vi.waitFor(async () => {
            const finished = await runInDurableObject(kernel, (instance: Kernel) => {
              // SAFETY: test fixture is constructed with the asserted domain shape.
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

// SAFETY: test fixture is constructed with the asserted domain shape.

      const res = await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
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
          // SAFETY: test fixture is constructed with the asserted domain shape.
          }
        }
      // SAFETY: test fixture is constructed with the asserted domain shape.
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
    it("rejects an unoffered approval and advances the remaining registered call", async () => {
      const runId = "run-hil-unoffered-batch";
      const stub = await initProcess("mech-hil-unoffered-batch", ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        process.currentRun = {
          runId,
          tools: offeredTools("Read"),
          offeredToolNames: ["Read"],
          approvalPolicy: { default: "auto", rules: [] },
        };
        process.sendSignal = vi.fn(async () => {});
        process.schedule = vi.fn(async () => {});
        process.scheduleTick = vi.fn(async () => {});
        process.dispatchSyscall = vi.fn(async (
          _runId: string,
          dispatchId: string,
        ) => {
          process.store.resolve(dispatchId, "read completed");
        });
        process.store.register(
          "dispatch-unoffered-shell",
          "unoffered-shell",
          runId,
          "shell.exec",
          { input: "cat /root/secret", target: "gsv" },
        );
        process.store.register(
          "dispatch-offered-read",
          "offered-read",
          runId,
          "fs.read",
          { path: "/root/allowed.txt" },
        );
        process.store.setPendingHil({
          requestId: "approval-unoffered-shell",
          runId,
          toolCallId: "unoffered-shell",
          toolName: "Shell",
          syscall: "shell.exec",
          args: { input: "cat /root/secret", target: "gsv" },
          createdAt: Date.now(),
        });

        await expect(process.handleProcHil({
          requestId: "approval-unoffered-shell",
          decision: "approve",
        })).resolves.toEqual({
          ok: false,
          error: 'Tool "Shell" was not offered for this generation',
        });
        await vi.waitFor(() => {
          expect(process.dispatchSyscall).toHaveBeenCalledOnce();
        });
        expect(process.dispatchSyscall).toHaveBeenCalledWith(
          runId,
          "dispatch-offered-read",
          "fs.read",
          { path: "/root/allowed.txt" },
        );
        expect(process.store.getResults(runId)).toMatchObject([
          {
            id: "unoffered-shell",
            status: "error",
            error: 'Tool "Shell" was not offered for this generation',
          },
          {
            id: "offered-read",
            status: "completed",
          },
        ]);
      });
    });

    it("rejects an unoffered CodeMode approval and advances the remaining registered call", async () => {
      const runId = "run-hil-unoffered-codemode-batch";
      const stub = await initProcess("mech-hil-unoffered-codemode-batch", ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        const resolveApproval = vi.fn();
        process.currentRun = {
          runId,
          tools: offeredTools("Read"),
          offeredToolNames: ["Read"],
          approvalPolicy: { default: "auto", rules: [] },
        };
        process.sendSignal = vi.fn(async () => {});
        process.schedule = vi.fn(async () => {});
        process.scheduleTick = vi.fn(async () => {});
        process.dispatchSyscall = vi.fn(async (
          _runId: string,
          dispatchId: string,
        ) => {
          process.store.resolve(dispatchId, "read completed");
        });
        process.store.register(
          "dispatch-unoffered-codemode",
          "unoffered-codemode",
          runId,
          "codemode.exec",
          { code: "return await fs.read({ path: '/root/secret' });" },
        );
        process.store.markDispatched("dispatch-unoffered-codemode");
        process.store.register(
          "dispatch-offered-read-after-codemode",
          "offered-read-after-codemode",
          runId,
          "fs.read",
          { path: "/root/allowed.txt" },
        );
        process.store.setPendingHil({
          requestId: "approval-unoffered-codemode",
          runId,
          ownerDispatchId: "dispatch-unoffered-codemode",
          toolCallId: "nested-read",
          toolName: "Read",
          syscall: "fs.read",
          args: { path: "/root/secret" },
          createdAt: Date.now(),
        });
        process.codeModeApprovals.set("approval-unoffered-codemode", {
          runId,
          dispatchId: "dispatch-unoffered-codemode",
          resolve: resolveApproval,
          timeoutId: setTimeout(() => {}, 60_000),
        });

        await expect(process.handleProcHil({
          requestId: "approval-unoffered-codemode",
          decision: "approve",
        })).resolves.toEqual({
          ok: false,
          error: 'Tool "CodeMode" was not offered for this generation',
        });
        expect(resolveApproval).toHaveBeenCalledWith(false);
        await vi.waitFor(() => {
          expect(process.dispatchSyscall).toHaveBeenCalledOnce();
        });
        expect(process.dispatchSyscall).toHaveBeenCalledWith(
          runId,
          "dispatch-offered-read-after-codemode",
          "fs.read",
          { path: "/root/allowed.txt" },
        );
        expect(process.store.getResults(runId)).toMatchObject([
          {
            id: "unoffered-codemode",
            status: "error",
            error: 'Tool "CodeMode" was not offered for this generation',
          },
          {
            id: "offered-read-after-codemode",
            status: "completed",
          },
        ]);
      });
    });

    it("pauses a run on ask policy and exposes the pending confirmation in history", async () => {
      const pid = "mech-hil-pause";
      const stub = await initProcess(pid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
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

// SAFETY: test fixture is constructed with the asserted domain shape.

      const history = (await stub.recvFrame(
        makeReq("proc.history", {}),
      // SAFETY: test fixture is constructed with the asserted domain shape.
      )) as ResponseOkFrame;

      expect(history.ok).toBe(true);
      // SAFETY: test fixture is constructed with the asserted domain shape.
      const data = history.data as any;
      expect(data.pendingHil).toMatchObject({
        pid,
        runId: "run-hil-1",
        callId: "call-hil-1",
        toolName: "Read",
        syscall: "fs.read",
        target: "gsv",
      });

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        expect(process.store.getPendingHilForRun("run-hil-1")).not.toBeNull();
        expect(process.store.getPending("call-hil-1")).toBeNull();
      });
    });

    it("pauses a background process instead of converting approval into a tool error", async () => {
      const pid = "mech-hil-background";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        process.store.setValue("interactive", "0");
        process.currentRun = {
          runId: "run-hil-background",
          approvalPolicy: {
            default: "auto",
            rules: [{ match: "shell.exec", action: "ask" }],
          },
        };
        registerToolBlock(process, "run-hil-background", [{
          type: "toolCall",
          id: "call-hil-background",
          name: "Shell",
          arguments: { input: "date" },
        }]);

        await expect(process.processToolCalls("run-hil-background")).resolves.toMatchObject({
          runId: "run-hil-background",
          toolCallId: "call-hil-background",
        });
        expect(process.store.getResults("run-hil-background")).toMatchObject([{
          id: "call-hil-background",
          status: "registered",
        }]);
        expect(process.store.getPendingHilForRun("run-hil-background")).not.toBeNull();
      });
    });

    it("exposes the normalized approval target rather than a legacy alias", async () => {
      const pid = "mech-hil-normalized-target";
      const stub = await initProcess(pid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        process.currentRun = {
          runId: "run-hil-normalized-target",
          approvalPolicy: {
            default: "auto",
            rules: [{ match: "shell.exec", action: "ask" }],
          },
        };
        registerToolBlock(process, "run-hil-normalized-target", [{
          type: "toolCall",
          id: "call-hil-normalized-target",
          name: "Shell",
          arguments: { input: "pwd", target: "gateway" },
        }]);
        await process.processToolCalls("run-hil-normalized-target");
      });

// SAFETY: test fixture is constructed with the asserted domain shape.

      const history = (await stub.recvFrame(
        makeReq("proc.history", {}),
      // SAFETY: test fixture is constructed with the asserted domain shape.
      )) as ResponseOkFrame;

      expect(history.ok).toBe(true);
      // SAFETY: test fixture is constructed with the asserted domain shape.
      expect((history.data as any).pendingHil).toMatchObject({
        pid,
        runId: "run-hil-normalized-target",
        callId: "call-hil-normalized-target",
        syscall: "shell.exec",
        target: "gsv",
        args: { input: "pwd", target: "gateway" },
      });
    });

    it("denies a pending confirmation with a synthetic tool result", async () => {
      const pid = "mech-hil-deny";
      const stub = await initProcess(pid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      const requestId = await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
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
        process.sendSignal = vi.fn(async () => {});
        return process.store.getPendingHilForRun("run-hil-2").requestId;
      });

// SAFETY: test fixture is constructed with the asserted domain shape.

      const res = (await stub.recvFrame(
        makeReq("proc.hil", { requestId, decision: "deny" }),
      // SAFETY: test fixture is constructed with the asserted domain shape.
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

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        expect(process.store.getPendingHil()).toBeNull();
        expect(process.store.getResults("run-hil-2")).toMatchObject([{
          id: "call-hil-2",
          status: "error",
          error: "Tool execution denied by user",
          outcome: "denied",
        }]);
        await process.ingestToolResults("run-hil-2", process.store.getResults("run-hil-2"));
        const toolResult = process.store.getMessages().at(-1);
        expect(toolResult.role).toBe("toolResult");
        expect(JSON.parse(toolResult.toolCalls).outcome).toBe("denied");
        expect(process.sendSignal).toHaveBeenCalledWith(
          "proc.run.started",
          expect.objectContaining({
            pid,
            runId: "run-hil-2",
            reason: "proc.hil.resume",
          }),
        );
      });
    });

    it("requires the exact request id before applying an approval decision", async () => {
      const pid = "mech-hil-exact-request";
      const stub = await initProcess(pid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      const requestId = await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        process.currentRun = {
          runId: "run-hil-exact-request",
          approvalPolicy: {
            default: "auto",
            rules: [{ match: "fs.delete", action: "ask" }],
          },
        };
        registerToolBlock(process, "run-hil-exact-request", [{
          type: "toolCall",
          id: "call-hil-exact-request",
          name: "Delete",
          arguments: { path: "/tmp/exact-request.txt" },
        }]);
        await process.processToolCalls("run-hil-exact-request");
        return process.store.getPendingHilForRun("run-hil-exact-request").requestId;
      });

// SAFETY: test fixture is constructed with the asserted domain shape.

      const stale = (await stub.recvFrame(
        makeReq("proc.hil", { requestId: `${requestId}-stale`, decision: "approve" }),
      // SAFETY: test fixture is constructed with the asserted domain shape.
      )) as ResponseOkFrame;
      expect(stale.ok).toBe(true);
      expect(stale.data).toEqual({
        ok: false,
        error: `Pending tool confirmation not found: ${requestId}-stale`,
      });

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        expect(process.store.getPendingHilForRun("run-hil-exact-request")).toMatchObject({
          requestId,
          runId: "run-hil-exact-request",
          toolCallId: "call-hil-exact-request",
        });
      });

// SAFETY: test fixture is constructed with the asserted domain shape.

      const exact = (await stub.recvFrame(
        makeReq("proc.hil", { requestId, decision: "deny" }),
      // SAFETY: test fixture is constructed with the asserted domain shape.
      )) as ResponseOkFrame;
      expect(exact.ok).toBe(true);
      expect(exact.data).toMatchObject({
        ok: true,
        pid,
        requestId,
        decision: "deny",
      });
    });

    // SAFETY: test fixture is constructed with the asserted domain shape.
    it("classifies a denied CodeMode confirmation as a user-controlled outcome", async () => {
      const stub = await initProcess("mech-hil-codemode-deny", ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        const runId = "run-hil-codemode-deny";
        const requestId = "approval-codemode-deny";
        const resolve = vi.fn();
        process.currentRun = {
          runId,
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
        process.sendSignal = vi.fn(async () => {});

        await expect(process.handleProcHil({ requestId, decision: "deny" })).resolves.toMatchObject({
          ok: true,
          decision: "deny",
          resumed: true,
        });

        expect(resolve).toHaveBeenCalledWith(false);
        expect(process.sendSignal).toHaveBeenCalledWith(
          "proc.run.started",
          expect.objectContaining({
            runId,
            reason: "proc.hil.resume",
          }),
        );
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
        await process.ingestToolResults(runId, process.store.getResults(runId));
        const outcomes = process.store.getMessages()
          .filter((message: any) => message.role === "toolResult")
          .map((message: any) => JSON.parse(message.toolCalls).outcome);
        expect(outcomes).toEqual(["completed", "denied"]);
      });
    });

    it("resumes a sole CodeMode run once after denying its nested approval", async () => {
      const pid = "mech-hil-codemode-sole-deny";
      const stub = await initProcess(pid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        const runId = "run-hil-codemode-sole-deny";
        const requestId = "approval-codemode-sole-deny";
        const resolve = vi.fn();
        process.currentRun = {
          runId,
          approvalPolicy: { default: "auto", rules: [] },
        };
        registerToolBlock(process, runId, [{
          id: "call-codemode-sole",
          name: "CodeMode",
          arguments: { code: "return await fs.read({ path: '/secret' });" },
        }]);
        process.store.markDispatched("dispatch-call-codemode-sole");
        process.store.setPendingHil({
          requestId,
          runId,
          ownerDispatchId: "dispatch-call-codemode-sole",
          toolCallId: "codemode-nested-call",
          toolName: "Read",
          syscall: "fs.read",
          args: { path: "/secret" },
          createdAt: Date.now(),
        });
        process.codeModeApprovals.set(requestId, {
          runId,
          dispatchId: "dispatch-call-codemode-sole",
          resolve,
          timeoutId: setTimeout(() => {}, 60_000),
        });
        process.schedule = vi.fn(async () => ({ id: "resume-codemode-sole" }));
        process.sendSignal = vi.fn(async () => {});

        await process.handleProcHil({ requestId, decision: "deny" });

        expect(resolve).toHaveBeenCalledWith(false);
        expect(process.store.getPendingHil()).toBeNull();
        expect(process.store.getResults(runId)).toMatchObject([{
          id: "call-codemode-sole",
          status: "error",
          outcome: "denied",
        }]);
        expect(process.schedule).toHaveBeenCalledTimes(1);
        expect(process.schedule).toHaveBeenCalledWith(
          expect.any(Date),
          "tick",
          { runId, generation: 0 },
          { idempotent: true },
        );
        expect(process.sendSignal).toHaveBeenCalledWith(
          "proc.run.tool.finished",
          {
            pid,
            runId,
            executionId: "dispatch-call-codemode-sole",
            callId: "call-codemode-sole",
            outcome: "denied",
            timestamp: expect.any(Number),
          },
        );
        process.store.clearPendingToolCalls();
        process.currentRun = null;
      });
    });

    it("does not infer a user denial from a live tool error message", async () => {
      const stub = await initProcess("mech-tool-error-denial-text", ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
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
        await process.ingestToolResults(runId, process.store.getResults(runId));
        const toolResult = process.store.getMessages().at(-1);
        expect(JSON.parse(toolResult.toolCalls).outcome).toBe("failed");
      });
    });

    it("remembers approved tool confirmations for the process", async () => {
      const pid = "mech-hil-remember";
      const stub = await initProcess(pid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      const requestId = await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
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

// SAFETY: test fixture is constructed with the asserted domain shape.

      const res = (await stub.recvFrame(
        makeReq("proc.hil", { requestId, decision: "approve", remember: true }),
      // SAFETY: test fixture is constructed with the asserted domain shape.
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

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
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

    it("keeps one execution identity from approved HIL start through finish", async () => {
      const pid = "mech-hil-approved-execution";
      const stub = await initProcess(pid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        const runId = "run-hil-approved-execution";
        process.currentRun = {
          runId,
          approvalPolicy: {
            default: "auto",
            rules: [{ match: "fs.read", action: "ask" }],
          },
        };
        process.sendSignal = vi.fn(async () => {});
        process.schedule = vi.fn(async () => ({ id: "tool-lifecycle" }));
        process.launchToolDispatch = vi.fn();
        registerToolBlock(process, runId, [{
          type: "toolCall",
          id: "call-hil-approved-execution",
          name: "Read",
          arguments: { path: "/private/input" },
        }]);
        await process.processToolCalls(runId);
        const requestId = process.store.getPendingHilForRun(runId).requestId;

        await process.handleProcHil({ requestId, decision: "approve" });
        await process.resolveStartedTool(
          runId,
          "dispatch-call-hil-approved-execution",
          "private output",
        );

        expect(process.launchToolDispatch).toHaveBeenCalledWith(
          runId,
          "dispatch-call-hil-approved-execution",
          "fs.read",
          { path: "/private/input" },
          process.currentRun.approvalPolicy,
        );
        expect(process.sendSignal).toHaveBeenCalledWith(
          "proc.run.tool.started",
          expect.objectContaining({
            pid,
            runId,
            executionId: "dispatch-call-hil-approved-execution",
            callId: "call-hil-approved-execution",
          }),
        );
        expect(process.sendSignal).toHaveBeenCalledWith(
          "proc.run.tool.finished",
          {
            pid,
            runId,
            executionId: "dispatch-call-hil-approved-execution",
            callId: "call-hil-approved-execution",
            outcome: "completed",
            timestamp: expect.any(Number),
          },
        );
        process.store.clearPendingToolCalls();
        process.currentRun = null;
      });
    });

    it("terminalizes CodeMode approval state whose continuation was lost", async () => {
      const stub = await initProcess("mech-hil-codemode-recovery", ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        const runId = "run-hil-codemode-recovery";
        process.currentRun = {
          runId,
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
          ownerDispatchId: "dispatch-call-codemode-outer",
          toolCallId: "codemode-nested-call",
          toolName: "Read",
          syscall: "fs.read",
          args: { path: "/lost" },
          createdAt: Date.now(),
        });
        process.schedule = vi.fn(async () => ({ id: "recovery-tick" }));
        process.sendSignal = vi.fn(async () => {});

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
        expect(process.schedule).not.toHaveBeenCalled();
        expect(process.sendSignal).toHaveBeenCalledWith(
          "proc.run.started",
          expect.objectContaining({
            runId,
            reason: "proc.hil.resume",
          }),
        );
      });
    });
  });

  describe("proc.history", () => {
    it("respects limit and offset", async () => {
      const pid = "mech-history-2";
      const stub = await initProcess(pid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const store = (instance as any).store;
        for (let i = 0; i < 10; i++) {
          store.appendMessage("user", `msg-${i}`);
        }
      });

// SAFETY: test fixture is constructed with the asserted domain shape.

      const res = (await stub.recvFrame(
        makeReq("proc.history", { limit: 3, offset: 2 }),
      // SAFETY: test fixture is constructed with the asserted domain shape.
      )) as ResponseOkFrame;

      // SAFETY: test fixture is constructed with the asserted domain shape.
      const data = res.data as any;
      expect(data.messages).toHaveLength(3);
      expect(data.messageCount).toBe(10);
      expect(data.truncated).toBe(true);
    });

    it("keeps proc.history paged by default", async () => {
      const pid = "mech-history-default-page";
      const stub = await initProcess(pid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const store = (instance as any).store;
        for (let i = 0; i < 205; i++) {
          store.appendMessage("user", `msg-${i}`);
        }
      });

// SAFETY: test fixture is constructed with the asserted domain shape.

      const res = (await stub.recvFrame(
        makeReq("proc.history", {}),
      // SAFETY: test fixture is constructed with the asserted domain shape.
      )) as ResponseOkFrame;

      // SAFETY: test fixture is constructed with the asserted domain shape.
      const data = res.data as any;
      expect(data.messages).toHaveLength(200);
      expect(data.messageCount).toBe(205);
      expect(data.truncated).toBe(true);
    });

    it("returns runtime status without reading Process activity", async () => {
      const stub = await initProcess("mech-history-status-only", ROOT_IDENTITY);
      // SAFETY: test fixture is constructed with the asserted domain shape.
      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        process.store.appendMessage("user", "private Process activity", {
          runId: "run-status-only",
        });
        process.currentRun = { runId: "run-status-only" };
      });

// SAFETY: test fixture is constructed with the asserted domain shape.

      const response = await stub.recvFrame(makeReq("proc.history", {
        includeMessages: false,
        tail: true,
        limit: 50,
      // SAFETY: test fixture is constructed with the asserted domain shape.
      })) as ResponseOkFrame;
      expect(response.data).toMatchObject({
        ok: true,
        activeRunId: "run-status-only",
        messageCount: 1,
        messages: [],
        hasMoreBefore: false,
        hasMoreAfter: false,
      });
    });

    it("supports tail-first and cursor history pagination", async () => {
      const pid = "mech-history-tail-page";
      const stub = await initProcess(pid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const store = (instance as any).store;
        for (let i = 0; i < 10; i++) {
          store.appendMessage("user", `msg-${i}`);
        }
      });

// SAFETY: test fixture is constructed with the asserted domain shape.

      const tailRes = (await stub.recvFrame(
        makeReq("proc.history", { tail: true, limit: 3 }),
      // SAFETY: test fixture is constructed with the asserted domain shape.
      )) as ResponseOkFrame;
      // SAFETY: test fixture is constructed with the asserted domain shape.
      const tailData = tailRes.data as any;
      expect(tailData.messages.map((message: any) => message.content)).toEqual(["msg-7", "msg-8", "msg-9"]);
      expect(tailData.hasMoreBefore).toBe(true);
      expect(tailData.hasMoreAfter).toBe(false);
      expect(tailData.truncated).toBe(true);

// SAFETY: test fixture is constructed with the asserted domain shape.

      const beforeRes = (await stub.recvFrame(
        makeReq("proc.history", { beforeMessageId: tailData.messages[0].id, limit: 3 }),
      // SAFETY: test fixture is constructed with the asserted domain shape.
      )) as ResponseOkFrame;
      // SAFETY: test fixture is constructed with the asserted domain shape.
      const beforeData = beforeRes.data as any;
      expect(beforeData.messages.map((message: any) => message.content)).toEqual(["msg-4", "msg-5", "msg-6"]);
      expect(beforeData.hasMoreBefore).toBe(true);
      expect(beforeData.hasMoreAfter).toBe(true);

// SAFETY: test fixture is constructed with the asserted domain shape.

      const afterRes = (await stub.recvFrame(
        makeReq("proc.history", { afterMessageId: beforeData.messages[2].id, limit: 2 }),
      // SAFETY: test fixture is constructed with the asserted domain shape.
      )) as ResponseOkFrame;
      // SAFETY: test fixture is constructed with the asserted domain shape.
      const afterData = afterRes.data as any;
      expect(afterData.messages.map((message: any) => message.content)).toEqual(["msg-7", "msg-8"]);
      expect(afterData.hasMoreBefore).toBe(true);
      expect(afterData.hasMoreAfter).toBe(true);
    });

    it("exposes active run metadata for restore-time controls", async () => {
      const pid = "mech-history-active-run";
      const stub = await initProcess(pid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        process.currentRun = {
          runId: "run-history-active",
        };
      });

// SAFETY: test fixture is constructed with the asserted domain shape.

      const res = (await stub.recvFrame(
        makeReq("proc.history", {}),
      // SAFETY: test fixture is constructed with the asserted domain shape.
      )) as ResponseOkFrame;

      expect(res.ok).toBe(true);
      // SAFETY: test fixture is constructed with the asserted domain shape.
      const data = res.data as any;
      expect(data.activeRunId).toBe("run-history-active");
      expect(data).not.toHaveProperty("activeConversationId");
    });

    it("includes full toolResult payload (metadata + output)", async () => {
      const pid = "mech-history-toolresult";
      const stub = await initProcess(pid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const store = (instance as any).store;
        store.appendToolResult(
          "call-1",
          "fs.read",
          "file contents here",
          false,
          "run-history-tool",
          "completed",
        );
      });

// SAFETY: test fixture is constructed with the asserted domain shape.

      const res = (await stub.recvFrame(
        makeReq("proc.history", {}),
      // SAFETY: test fixture is constructed with the asserted domain shape.
      )) as ResponseOkFrame;

      expect(res.ok).toBe(true);
      // SAFETY: test fixture is constructed with the asserted domain shape.
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

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
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

// SAFETY: test fixture is constructed with the asserted domain shape.

      const res = (await stub.recvFrame(
        makeReq("proc.history", {}),
      // SAFETY: test fixture is constructed with the asserted domain shape.
      )) as ResponseOkFrame;

      expect(res.ok).toBe(true);
      // SAFETY: test fixture is constructed with the asserted domain shape.
      const data = res.data as any;
      expect(data.messages.map((message: any) => message.content.outcome)).toEqual([
        "cancelled",
        "denied",
      ]);
    });

    it("includes assistant thinking blocks when present", async () => {
      const pid = "mech-history-thinking";
      const stub = await initProcess(pid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
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

// SAFETY: test fixture is constructed with the asserted domain shape.

      const res = (await stub.recvFrame(
        makeReq("proc.history", {}),
      // SAFETY: test fixture is constructed with the asserted domain shape.
      )) as ResponseOkFrame;

      expect(res.ok).toBe(true);
      // SAFETY: test fixture is constructed with the asserted domain shape.
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
    // SAFETY: test fixture is constructed with the asserted domain shape.
    });
  });

  describe("CodeMode tool calls", () => {
    it("runs codemode from the native shell command", async () => {
      const pid = "mech-codemode-shell";
      await initProcess(pid, ROOT_IDENTITY);
      const kernel = await getKernelPtr();

      // SAFETY: test fixture is constructed with the asserted domain shape.
      const response = await runInDurableObject(kernel, (instance: Kernel) =>
        instance.recvFrame(pid, makeReq("shell.exec", {
          input: "codemode -e 'return { argv, args };' --json --arg mode=check -- alpha",
        // SAFETY: test fixture is constructed with the asserted domain shape.
        })),
      // SAFETY: test fixture is constructed with the asserted domain shape.
      ) as ResponseOkFrame;

      expect(response.ok).toBe(true);
      // SAFETY: test fixture is constructed with the asserted domain shape.
      const data = response.data as any;
      expect(data.status, JSON.stringify(data, null, 2)).toBe("completed");
      expect(data.exitCode).toBe(0);
      expect(JSON.parse(data.stdout)).toEqual({
        status: "completed",
        result: {
          argv: ["alpha"],
          // SAFETY: test fixture is constructed with the asserted domain shape.
          args: { mode: "check" },
        },
      });
    });

    it("runs codemode script files from the native shell command", async () => {
      const pid = "mech-codemode-shell-file";
      await initProcess(pid, ROOT_IDENTITY);
      const kernel = await getKernelPtr();

      // SAFETY: test fixture is constructed with the asserted domain shape.
      const response = await runInDurableObject(kernel, (instance: Kernel) =>
        instance.recvFrame(pid, makeReq("shell.exec", {
          input: [
            "echo '{\"ok\":true}' > test.json",
            "cat > test.js <<'EOF'",
            "const res = await shell(\"pwd\");",
            "const file = await fs.read({ path: \"test.json\" });",
            "return { res, file, argv, args};",
            // SAFETY: test fixture is constructed with the asserted domain shape.
            "EOF",
            "codemode run test.js --json --arg mode=file -- beta",
          ].join("\n"),
        })),
      // SAFETY: test fixture is constructed with the asserted domain shape.
      ) as ResponseOkFrame;

      expect(response.ok).toBe(true);
      // SAFETY: test fixture is constructed with the asserted domain shape.
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

    it("lets process-local codemode read its own /proc history view", async () => {
      const pid = "mech-codemode-self-proc-view";
      // SAFETY: test fixture is constructed with the asserted domain shape.
      const stub = await initProcess(pid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const store = (instance as any).store;
        store.appendMessage("user", "hello from history");
        store.appendMessage("assistant", "hello back");
      });

      // SAFETY: test fixture is constructed with the asserted domain shape.
      const res = (await stub.recvFrame(
        makeReq("codemode.run", {
          code: [
            "const file = await fs.read({ target: \"gsv\", path: \"/proc/self/history\" });",
            "if (!file.ok) throw new Error(file.error);",
            "return file.content;",
          // SAFETY: test fixture is constructed with the asserted domain shape.
          ].join("\n"),
        }),
      // SAFETY: test fixture is constructed with the asserted domain shape.
      )) as ResponseOkFrame;

      expect(res.ok).toBe(true);
      // SAFETY: test fixture is constructed with the asserted domain shape.
      const data = res.data as any;
      // SAFETY: test fixture is constructed with the asserted domain shape.
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

      // SAFETY: test fixture is constructed with the asserted domain shape.
      const response = await runInDurableObject(kernel, (instance: Kernel) =>
        instance.recvFrame(pid, makeReq("shell.exec", {
          input: "codemode -e 'const res = await shell(\"pwd);' --json",
        // SAFETY: test fixture is constructed with the asserted domain shape.
        })),
      // SAFETY: test fixture is constructed with the asserted domain shape.
      ) as ResponseOkFrame;

      expect(response.ok).toBe(true);
      // SAFETY: test fixture is constructed with the asserted domain shape.
      const data = response.data as any;
      // SAFETY: test fixture is constructed with the asserted domain shape.
      expect(data.status, JSON.stringify(data, null, 2)).toBe("failed");
      expect(data.exitCode).toBe(1);
      const result = JSON.parse(data.stdout);
      expect(result.status).toBe("failed");
      expect(result.error).toContain("SyntaxError");
      expect(result.error).toContain("Invalid or unexpected token");
    });

    // SAFETY: test fixture is constructed with the asserted domain shape.
    it("runs codemode.run as a process command", async () => {
      const pid = "mech-codemode-run";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      // SAFETY: test fixture is constructed with the asserted domain shape.
      const res = (await stub.recvFrame(
        makeReq("codemode.run", {
          code: "return { argv, args };",
          // SAFETY: test fixture is constructed with the asserted domain shape.
          argv: ["alpha"],
          args: { mode: "manual" },
        }),
      // SAFETY: test fixture is constructed with the asserted domain shape.
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

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
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
          _context: ProcessTestValue,
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

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
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
          _context: ProcessTestValue,
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

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        const approvals: Array<{ call: string; args: Record<string, ProcessTestValue> }> = [];
        let dispatched = false;

        process.currentRun = {
          runId: "run-codemode-fetch-approval",
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
          args: Record<string, ProcessTestValue>,
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

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        let requestedApproval = false;
        let dispatched = false;
        process.currentRun = {
          runId: "run-codemode-fetch-capability",
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

    it("gates nested CodeMode mail sends through ordinary Process approval", async () => {
      const stub = await initProcess("mech-codemode-mail-approval", ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        const approvals: Array<{
          toolName: string;
          call: string;
          args: Record<string, ProcessTestValue>;
        }> = [];
        let dispatched = false;
        process.currentRun = { runId: "run-codemode-mail-approval" };
        process.waitForCodeModeApproval = async (
          _runId: string,
          _dispatchId: string,
          _toolCallId: string,
          toolName: string,
          call: string,
          args: Record<string, ProcessTestValue>,
        ) => {
          approvals.push({ toolName, call, args });
          return false;
        };
        process.dispatchCodeModeSyscall = async () => {
          dispatched = true;
          throw new Error("unexpected dispatch");
        };

        await expect(process.executeCodeModeSyscall(
          {
            runId: "run-codemode-mail-approval",
            dispatchId: "dispatch-codemode-mail-approval",
            approvalPolicy: DEFAULT_TOOL_APPROVAL_POLICY,
            capabilities: ["mail.send"],
          },
          "mail.send",
          {
            to: "mike@example.com",
            text: "Hello",
            deliveryId: "mail-send:approval:1",
          },
        )).rejects.toThrow("Tool execution was not approved: mail.send");

        expect(approvals).toEqual([{
          toolName: "mail.send",
          call: "mail.send",
          args: {
            to: "mike@example.com",
            text: "Hello",
            deliveryId: "mail-send:approval:1",
          },
        }]);
        expect(dispatched).toBe(false);
      });
    });

    it("ignores a nested CodeMode result after the run stops", async () => {
      const pid = "mech-codemode-fetch-stopped-after-fetch";
      const stub = await initProcess(pid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        let stopChecks = 0;

        process.currentRun = {
          runId: "run-codemode-fetch-stopped-after-fetch",
          config: {
            ...terminalTestConfig(pid),
            capabilities: ["codemode.*", "net.fetch"],
          },
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
      // SAFETY: test fixture is constructed with the asserted domain shape.
      await runInDurableObject(kernel, (instance: Kernel) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const k = instance as any;
        k.caps.grant(3000, "codemode.run");
      });

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
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

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
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

    it("derives nested mail delivery ids from the durable model execution", async () => {
      const pid = "mech-codemode-mail-delivery";
      const stub = await initProcess(pid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        const runId = "run-codemode-mail-delivery";
        const dispatchId = "dispatch-call-codemode-mail-delivery";
        const calls: Array<{ call: string; args: Record<string, ProcessTestValue> }> = [];
        process.currentRun = {
          runId,
          config: {
            ...terminalTestConfig(pid),
            capabilities: ["mail.send"],
          },
          approvalPolicy: { default: "auto", rules: [] },
        };
        process.getCodeModeMcpToolBindings = async () => [];
        process.executeCodeModeSyscall = async (
          _context: ProcessTestValue,
          call: string,
          args: Record<string, ProcessTestValue>,
        ) => {
          calls.push({ call, args });
          return { ok: true, deliveryId: args.deliveryId };
        };
        registerToolBlock(process, runId, [{
          type: "toolCall",
          id: "call-codemode-mail-delivery",
          name: "CodeMode",
          arguments: {
            code: `return await mail.send({ to: "mike@example.com", text: "Hello" });`,
          },
        }]);
        process.store.markDispatched(dispatchId);

        await process.executeCodeModeTool(
          runId,
          dispatchId,
          { code: `return await mail.send({ to: "mike@example.com", text: "Hello" });` },
          process.currentRun.approvalPolicy,
        );

        const deliveryBase = await stableOpaqueId("mail-send", [
          process.installationId,
          pid,
          runId,
          dispatchId,
        ]);
        expect(calls).toEqual([{
          call: "mail.send",
          args: {
            to: "mike@example.com",
            text: "Hello",
            deliveryId: `${deliveryBase}:1`,
          },
        }]);
      });
    });

    it("derives manual CodeMode mail delivery ids from the request frame", async () => {
      const pid = "mech-codemode-run-mail-delivery";
      const stub = await initProcess(pid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        const calls: Array<{ call: string; args: Record<string, ProcessTestValue> }> = [];
        process.getCodeModeMcpToolBindings = async () => [];
        process.executeCodeModeSyscall = async (
          _context: ProcessTestValue,
          call: string,
          args: Record<string, ProcessTestValue>,
        ) => {
          calls.push({ call, args });
          return { ok: true, deliveryId: args.deliveryId };
        };
        const requestId = "codemode-run-mail-request";
        const response = await instance.recvFrame({
          type: "req",
          id: requestId,
          call: "codemode.run",
          args: {
            code: `return await mail.send({ to: "mike@example.com", text: "Hello" });`,
          },
        });

        const deliveryBase = await stableOpaqueId("mail-send", [
          process.installationId,
          pid,
          requestId,
        ]);
        expect(response).toMatchObject({
          ok: true,
          data: { status: "completed" },
        });
        expect(calls).toEqual([{
          call: "mail.send",
          args: {
            to: "mike@example.com",
            text: "Hello",
            deliveryId: `${deliveryBase}:1`,
          },
        }]);
      });
    });

    // SAFETY: test fixture is constructed with the asserted domain shape.
    it("classifies a failed CodeMode result as a genuine tool failure", async () => {
      const stub = await initProcess("mech-codemode-failed-outcome", ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        const runId = "run-codemode-failed-outcome";
        const dispatchId = "dispatch-call-codemode-failed";
        process.currentRun = {
          runId,
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
        await process.ingestToolResults(runId, process.store.getResults(runId));
        const toolResult = process.store.getMessages().at(-1);
        expect(JSON.parse(toolResult.toolCalls)).toMatchObject({
          isError: true,
          outcome: "failed",
        });
      });
    });
  });

  describe("proc.reset", () => {
    it("clears active run state and queued messages", async () => {
      const pid = "mech-reset-runtime";
      const stub = await initProcess(pid, ROOT_IDENTITY);
      const runId = "run-reset-runtime";

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const store = (instance as any).store;
        store.setValue("currentRun", JSON.stringify({ runId }));
        store.register("dispatch-reset-1", "call-reset-1", runId, "fs.read", { path: "/tmp/test.txt" });
        store.enqueue(runId, "queued after reset");
        store.appendMessage("user", "hello before reset");
      });

// SAFETY: test fixture is constructed with the asserted domain shape.

      const resetRes = (await stub.recvFrame(
        makeReq("proc.reset", {}),
      // SAFETY: test fixture is constructed with the asserted domain shape.
      )) as ResponseOkFrame;
      expect(resetRes.ok).toBe(true);

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const store = (instance as any).store;
        expect(store.getValue("currentRun")).toBeNull();
        expect(store.queueSize()).toBe(0);
        expect(store.getResults(runId)).toHaveLength(0);
      });

// SAFETY: test fixture is constructed with the asserted domain shape.

      const sendRes = (await stub.recvFrame(
        makeReq("proc.send", { message: "first after reset" }),
      // SAFETY: test fixture is constructed with the asserted domain shape.
      )) as ResponseOkFrame;
      // SAFETY: test fixture is constructed with the asserted domain shape.
      const sendData = sendRes.data as { queued?: boolean };
      expect(sendData.queued).toBeUndefined();
    });

    it("fences an in-flight generation before archiving reset history", async () => {
      const pid = "mech-reset-fences-generation";
      const stub = await initProcess(pid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
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
        process.archiveHistoryMessages = vi.fn(async () => {
          markArchiveStarted();
          await archiveBlocked;
          return { archivedMessages: 1, archivedTo: "/archive/", archives: [] };
        });
        process.store.appendMessage("user", "reset while generating", {
          runId: "run-reset-fence",
        });
        process.currentRun = {
          runId: "run-reset-fence",
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
    it("deletes only the killed managed installation's process media", async () => {
      const installationId = "inst_managed_kill_media";
      const otherInstallationId = "inst_other_kill_media";
      const pid = "mech-managed-kill-media";
      const logicalKey = `var/media/0/${pid}/pending.png`;
      const ownKey = `${installationStoragePrefix(installationId)}${logicalKey}`;
      const otherKey = `${installationStoragePrefix(otherInstallationId)}${logicalKey}`;
      const stub = env.PROCESS.get(env.PROCESS.idFromName(
        processDurableObjectName(installationId, pid),
      ));
      await stub.recvFrame(makeReq("proc.setidentity", {
        identity: ROOT_IDENTITY,
        profile: DEFAULT_PROFILE,
      }));
      await env.STORAGE.put(ownKey, new Uint8Array([1]));
      await env.STORAGE.put(otherKey, new Uint8Array([2]));

      await expect(stub.recvFrame(makeReq("proc.kill", { archive: false })))
        .resolves.toMatchObject({
          ok: true,
          data: { ok: true, pid, archivedMessages: 0, archives: [] },
        });
      expect(await env.STORAGE.head(ownKey)).toBeNull();
      expect(await env.STORAGE.head(otherKey)).not.toBeNull();
      await env.STORAGE.delete(otherKey);
    });

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
      // SAFETY: test fixture is constructed with the asserted domain shape.
      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
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

      // SAFETY: test fixture is constructed with the asserted domain shape.
      const killed = await stub.recvFrame(makeReq("proc.kill", {})) as ResponseOkFrame;
      // SAFETY: test fixture is constructed with the asserted domain shape.
      const archive = (killed.data as any).archives[0];
      expect(archive).toBeTruthy();
      expect(await env.STORAGE.head(activeKey)).toBeNull();

      const resumedPid = "mech-resume-archive-media";
      const resumed = await getProcessByPid(resumedPid);
      // SAFETY: test fixture is constructed with the asserted domain shape.
      const initialized = await resumed.recvFrame(makeReq("proc.setidentity", {
        identity: ROOT_IDENTITY,
        profile: DEFAULT_PROFILE,
      // SAFETY: test fixture is constructed with the asserted domain shape.
      })) as ResponseOkFrame;
      expect(initialized.ok).toBe(true);
      // SAFETY: test fixture is constructed with the asserted domain shape.
      const imported = await resumed.recvFrame(makeReq("proc.history.import", {
        archivePaths: [archive.path],
      // SAFETY: test fixture is constructed with the asserted domain shape.
      })) as ResponseOkFrame;
      expect(imported.data).toMatchObject({ ok: true, pid: resumedPid, restoredMessages: 1 });

      // SAFETY: test fixture is constructed with the asserted domain shape.
      const history = await resumed.recvFrame(makeReq("proc.history", {})) as ResponseOkFrame;
      // SAFETY: test fixture is constructed with the asserted domain shape.
      const media = (history.data as any).messages[0].content.media[0];
      expect(media).toMatchObject({
        filename: "proof.png",
        key: expect.stringMatching(/^root\/\.gsv\/media\/archived-media:[0-9a-f]{64}$/),
      });
      expect(media.path).toBe(`/${media.key}`);

      const restored = await env.STORAGE.get(media.key);
      expect(restored && [...new Uint8Array(await restored.arrayBuffer())]).toEqual([1, 2, 3]);

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
        makeReq("proc.setidentity", { identity: ROOT_IDENTITY }),
      )).resolves.toMatchObject({
        ok: false,
        error: { code: 410 },
      });
    });

    it("preserves live execution state when history archival fails", async () => {
      const pid = "mech-kill-archive-failure";
      const runId = "run-kill-archive-failure";
      const stub = await initProcess(pid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      const failed = await runInDurableObject(stub, async (instance: Process, state) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        process.currentRun = { runId };
        process.store.appendMessage("user", "survive archive failure", { runId });
        process.store.enqueue("queued-after-archive-failure", "queued work must survive");
        process.store.register(
          "dispatch-archive-failure",
          "call-archive-failure",
          runId,
          "fs.read",
          { path: "/tmp/archive" },
        );
        process.store.setPendingHil({
          requestId: "hil-archive-failure",
          runId,
          toolCallId: "call-archive-failure",
          toolName: "Read",
          syscall: "fs.read",
          args: { path: "/tmp/archive" },
          createdAt: Date.now(),
        });
        process.archiveMessageRecords = vi.fn(async () => {
          throw new Error("injected archive failure");
        });
        process.sendSignal = vi.fn(async () => {});

        const response = await process.recvFrame(makeReq("proc.kill", {}));
        return {
          response,
          killed: process.killed,
          currentRun: process.currentRun,
          tools: process.store.getResults(runId),
          pendingHil: process.store.getPendingHilForRun(runId),
          queueSize: process.store.queueSize(),
          finishCalls: process.sendSignal.mock.calls.length,
          tombstone: state.storage.kv.get("__gsv_process_killed__"),
        };
      });

      expect(failed).toMatchObject({
        response: { ok: false, error: { message: "injected archive failure" } },
        killed: false,
        currentRun: { runId },
        tools: [expect.objectContaining({
          dispatchId: "dispatch-archive-failure",
          status: "registered",
        })],
        pendingHil: { requestId: "hil-archive-failure", runId },
        queueSize: 1,
        finishCalls: 0,
        tombstone: undefined,
      });

      await evictDurableObject(stub);
      // SAFETY: test fixture is constructed with the asserted domain shape.
      await expect(runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        return {
          currentRun: process.currentRun,
          tools: process.store.getResults(runId),
          pendingHil: process.store.getPendingHilForRun(runId),
          queueSize: process.store.queueSize(),
        };
      })).resolves.toMatchObject({
        currentRun: { runId },
        tools: [expect.objectContaining({
          dispatchId: "dispatch-archive-failure",
          status: "registered",
        })],
        pendingHil: { requestId: "hil-archive-failure", runId },
        queueSize: 1,
      });
      await expect(stub.recvFrame(
        makeReq("proc.kill", { archive: false }),
      )).resolves.toMatchObject({ ok: true, data: { ok: true, pid } });
    });

    it("retries the archive when provider output lands during upload", async () => {
      const pid = "mech-kill-stable-archive";
      const runId = "run-kill-stable-archive";
      const stub = await initProcess(pid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      const result = await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        let releaseGeneration!: () => void;
        let markGenerationStarted!: () => void;
        let releaseArchive!: () => void;
        let markArchiveStarted!: () => void;
        let markAssistantAppended!: () => void;
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
        const assistantAppended = new Promise<void>((resolve) => {
          markAssistantAppended = resolve;
        });
        process.generation = {
          async generate() {
            markGenerationStarted();
            await generationBlocked;
            return {
              role: "assistant",
              content: [{ type: "text", text: "provider completed during archive" }],
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
        process.sendSignal = vi.fn(async () => {});
        const appendMessage = process.store.appendMessage.bind(process.store);
        vi.spyOn(process.store, "appendMessage").mockImplementation((...args: any[]) => {
          const messageId = appendMessage(...args);
          if (args[0] === "assistant" && args[1] === "provider completed during archive") {
            markAssistantAppended();
          }
          return messageId;
        });
        const archiveMessageRecords = process.archiveMessageRecords.bind(process);
        let archiveAttempts = 0;
        const archiveSnapshots: any[][] = [];
        process.archiveMessageRecords = vi.fn(async (...args: any[]) => {
          archiveAttempts += 1;
          archiveSnapshots.push(args[1]);
          if (archiveAttempts === 1) {
            markArchiveStarted();
            await archiveBlocked;
            return;
          }
          await archiveMessageRecords(...args);
        });
        const activeMediaKey = `var/media/0/${pid}/stable.png`;
        await process.env.STORAGE.put(activeMediaKey, new Uint8Array([4, 5, 6]), {
          httpMetadata: { contentType: "image/png" },
          customMetadata: {
            uid: "0",
            gid: "0",
            mode: "400",
            processId: pid,
          },
        });
        process.store.appendMessage("user", "answer before kill", {
          runId,
          media: JSON.stringify([{
            type: "image",
            mimeType: "image/png",
            filename: "stable.png",
            size: 3,
            key: activeMediaKey,
            path: `/${activeMediaKey}`,
          }]),
          origin: JSON.stringify({
            kind: "adapter",
            adapter: "telegram",
            accountId: "bot",
            actorId: "telegram:user:1",
            surface: { kind: "dm", id: "chat-1" },
          }),
        });
        process.store.appendMessage("assistant", "checking", {
          runId,
          toolCalls: JSON.stringify({
            toolCalls: [{
              type: "toolCall",
              id: "historical-call",
              name: "Read",
              arguments: { path: "/tmp/stable" },
            }],
          }),
        });
        process.store.appendToolResult(
          "historical-call",
          "fs.read",
          "stable result",
          false,
          runId,
          "completed",
        );
        process.currentRun = {
          runId,
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

        const ticking = process.runTick(runId);
        await generationStarted;
        const killing = process.recvFrame(makeReq("proc.kill", {}));
        await archiveStarted;
        releaseGeneration();
        await assistantAppended;
        expect(process.store.getMessages({ limit: null }).length).toBeGreaterThanOrEqual(4);
        releaseArchive();
        const response = await killing;
        await ticking;
        const archivePath = response.data.archives[0].path;
        const archived = archiveSnapshots.at(-1)!;
        const archivedMedia = await process.env.STORAGE.list({
          prefix: "root/.gsv/media/archived-media:",
        });
        await process.env.STORAGE.delete([
          archivePath.replace(/^\//, ""),
          ...archivedMedia.objects.map((object: any) => object.key),
        ]);
        return {
          response,
          archiveAttempts,
          contents: archived.map((message: any) => message.content),
          origin: JSON.parse(archived[0].origin),
          media: JSON.parse(archived[0].media),
          toolCalls: JSON.parse(archived[1].toolCalls).toolCalls,
        };
      });

      expect(result.response).toMatchObject({
        ok: true,
        data: { ok: true, pid, archivedMessages: 5 },
      });
      expect(result.archiveAttempts).toBe(2);
      expect(result.contents).toEqual([
        "answer before kill",
        "checking",
        "stable result",
        "provider completed during archive",
        expect.stringContaining("This run is not complete"),
      ]);
      expect(result.origin).toMatchObject({
        kind: "adapter",
        adapter: "telegram",
        surface: { kind: "dm", id: "chat-1" },
      });
      expect(result.media).toEqual([
        expect.objectContaining({ key: expect.stringContaining("stable.png") }),
      ]);
      expect(result.toolCalls).toEqual([
        expect.objectContaining({ id: "historical-call", name: "Read" }),
      ]);
    });

    it("serializes concurrent kills behind one terminal archive commit", async () => {
      const pid = "mech-kill-concurrent-commit";
      const stub = await initProcess(pid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      const result = await runInDurableObject(stub, async (instance: Process, state) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        process.store.appendMessage("user", "archive exactly once");
        let releaseArchive!: () => void;
        let markArchiveStarted!: () => void;
        const archiveBlocked = new Promise<void>((resolve) => {
          releaseArchive = resolve;
        });
        const archiveStarted = new Promise<void>((resolve) => {
          markArchiveStarted = resolve;
        });
        process.archiveMessageRecords = vi.fn(async () => {
          markArchiveStarted();
          await archiveBlocked;
        });
        const transactionSync = vi.spyOn(state.storage, "transactionSync");

        const first = process.recvFrame(makeReq("proc.kill", {}));
        await archiveStarted;
        const second = process.recvFrame(makeReq("proc.kill", {}));
        releaseArchive();
        const responses = await Promise.all([first, second]);

        return {
          responses,
          archiveCalls: process.archiveMessageRecords.mock.calls.length,
          terminalCommits: transactionSync.mock.calls.length,
          tombstone: state.storage.kv.get("__gsv_process_killed__"),
        };
      });

      expect(result.archiveCalls).toBe(1);
      expect(result.terminalCommits).toBe(1);
      expect(result.responses[0]).toMatchObject({
        ok: true,
        data: { ok: true, pid, archivedMessages: 1 },
      });
      expect(result.responses[1].data).toEqual(result.responses[0].data);
      expect(result.tombstone).toMatchObject({
        pid,
        cleanup: "completed",
        result: result.responses[0].data,
      });
    });

    it("ignores a provider completion released after the terminal commit", async () => {
      const pid = "mech-kill-late-provider";
      const runId = "run-kill-late-provider";
      const stub = await initProcess(pid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        let releaseGeneration!: () => void;
        let markGenerationStarted!: () => void;
        const generationBlocked = new Promise<void>((resolve) => {
          releaseGeneration = resolve;
        });
        const generationStarted = new Promise<void>((resolve) => {
          markGenerationStarted = resolve;
        });
        process.generation = {
          async generate() {
            markGenerationStarted();
            await generationBlocked;
            return {
              role: "assistant",
              content: [{ type: "text", text: "late provider output" }],
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
        process.sendSignal = vi.fn(async () => {});
        process.store.appendMessage("user", "kill while provider is blocked", { runId });
        process.currentRun = {
          runId,
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

        const ticking = process.runTick(runId);
        await generationStarted;
        await expect(process.recvFrame(
          makeReq("proc.kill", { archive: false }),
        )).resolves.toMatchObject({ ok: true, data: { ok: true, pid } });
        releaseGeneration();
        await expect(ticking).resolves.toBeUndefined();
        await expect(process.recvFrame(makeReq("proc.history", {}))).resolves.toMatchObject({
          ok: false,
          error: { code: 410 },
        });
      });
    });

    it("rejects a queued runtime send released after the terminal commit", async () => {
      const pid = "mech-kill-queued-runtime-send";
      const stub = await initProcess(pid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        const releaseAdmission = await process.acquireQueuedSendAdmission();
        const acquireQueuedSendAdmission = process.acquireQueuedSendAdmission.bind(process);
        let markAdmissionStarted!: () => void;
        const admissionStarted = new Promise<void>((resolve) => {
          markAdmissionStarted = resolve;
        });
        process.acquireQueuedSendAdmission = vi.fn(async () => {
          markAdmissionStarted();
          return await acquireQueuedSendAdmission();
        });

        const sending = process.handleProcSend({
          message: "queued scheduler work",
          origin: { kind: "scheduler", scheduleId: "schedule-after-kill" },
        });
        await admissionStarted;
        await expect(process.recvFrame(
          makeReq("proc.kill", { archive: false }),
        )).resolves.toMatchObject({ ok: true, data: { ok: true, pid } });
        releaseAdmission();
        await expect(sending).resolves.toEqual({
          ok: false,
          error: "Process no longer exists",
        });
      });
    });

    it("ignores context media hydration released after the terminal commit", async () => {
      const pid = "mech-kill-late-context-media";
      const runId = "run-kill-late-context-media";
      const key = `var/media/0/${pid}/context.png`;
      const stub = await initProcess(pid, ROOT_IDENTITY);
      await env.STORAGE.put(key, new Uint8Array([1, 2, 3]), {
        httpMetadata: { contentType: "image/png" },
      });

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        const originalStorage = process.storage;
        let releaseRead!: () => void;
        let markReadStarted!: () => void;
        const readBlocked = new Promise<void>((resolve) => {
          releaseRead = resolve;
        });
        const readStarted = new Promise<void>((resolve) => {
          markReadStarted = resolve;
        });
        process.storage = {
          get: vi.fn(async (requestedKey: string) => {
            const object = await originalStorage.get(requestedKey);
            markReadStarted();
            await readBlocked;
            return object;
          }),
          list: (...args: any[]) => originalStorage.list(...args),
          delete: (...args: any[]) => originalStorage.delete(...args),
        };
        process.sendSignal = vi.fn(async () => {});
        process.store.appendMessage("user", "inspect the image", {
          runId,
          media: JSON.stringify([{
            type: "image",
            mimeType: "image/png",
            key,
            path: `/${key}`,
            size: 3,
          }]),
        });
        process.currentRun = {
          runId,
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

        const ticking = process.runTick(runId);
        await readStarted;
        await expect(process.recvFrame(
          makeReq("proc.kill", { archive: false }),
        )).resolves.toMatchObject({ ok: true, data: { ok: true, pid } });
        releaseRead();
        await expect(ticking).resolves.toBeUndefined();
        process.storage = originalStorage;
      });
    });

    it("ignores tool body materialization released after the terminal commit", async () => {
      const pid = "mech-kill-late-tool-body";
      const runId = "run-kill-late-tool-body";
      const stub = await initProcess(pid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        let releaseBody!: () => void;
        let markBodyStarted!: () => void;
        const bodyBlocked = new Promise<void>((resolve) => {
          releaseBody = resolve;
        });
        const bodyStarted = new Promise<void>((resolve) => {
          markBodyStarted = resolve;
        });
        let cancelled = false;
        process.currentRun = { runId };
        process.store.register(
          "dispatch-kill-late-body",
          "call-kill-late-body",
          runId,
          "fs.read",
          { path: "/tmp/late" },
        );
        process.store.markDispatched("dispatch-kill-late-body");
        process.sendSignal = vi.fn(async () => {});

        const handling = process.handleRes({
          type: "res",
          id: "dispatch-kill-late-body",
          ok: true,
          data: {
            ok: true,
            path: "/tmp/late",
            kind: "text",
            contentType: "text/plain",
            size: 1,
            lines: 1,
          },
          body: {
            stream: new ReadableStream({
              pull() {
                markBodyStarted();
                return bodyBlocked;
              },
              cancel() {
                cancelled = true;
              },
            }),
            length: 1,
          },
        });
        await bodyStarted;
        await expect(process.recvFrame(
          makeReq("proc.kill", { archive: false }),
        )).resolves.toMatchObject({ ok: true, data: { ok: true, pid } });
        releaseBody();
        await expect(handling).resolves.toBeUndefined();
        expect(cancelled).toBe(true);
      });
    });

    it("ignores pending finish delivery released after the terminal commit", async () => {
      const pid = "mech-kill-late-finish-delivery";
      const runId = "run-kill-late-finish-delivery";
      const stub = await initProcess(pid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        let releaseSignal!: () => void;
        let markSignalStarted!: () => void;
        const signalBlocked = new Promise<void>((resolve) => {
          releaseSignal = resolve;
        });
        const signalStarted = new Promise<void>((resolve) => {
          markSignalStarted = resolve;
        });
        process.store.setValue("pendingRunFinishes", JSON.stringify([{
          pid,
          runId,
          status: "ok",
          reason: "turn.complete",
          text: "done",
          queuedCount: 0,
          timestamp: 1,
        }]));
        process.sendSignal = vi.fn(async (signal: string) => {
          if (signal === "proc.run.finished") {
            markSignalStarted();
            await signalBlocked;
          }
        });

        const delivery = process.onRunFinishDelivery(runId);
        await signalStarted;
        await expect(process.recvFrame(
          makeReq("proc.kill", { archive: false }),
        )).resolves.toMatchObject({ ok: true, data: { ok: true, pid } });
        releaseSignal();
        await expect(delivery).resolves.toBeUndefined();
      });
    });

    it("ignores a schedule rejection delivered after the terminal commit", async () => {
      const pid = "mech-kill-late-schedule";
      const stub = await initProcess(pid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        let rejectSchedule!: (error: Error) => void;
        let markScheduleStarted!: () => void;
        const scheduleStarted = new Promise<void>((resolve) => {
          markScheduleStarted = resolve;
        });
        const scheduled = new Promise<void>((_resolve, reject) => {
          rejectSchedule = reject;
        });
        process.scheduleTick = vi.fn(() => {
          markScheduleStarted();
          return scheduled;
        });
        process.sendSignal = vi.fn(async () => {});
        const finishRun = vi.spyOn(process, "finishRun");

        await expect(process.handleProcSend({
          message: "schedule after kill",
          origin: { kind: "client", connectionId: "client-1" },
        })).resolves.toMatchObject({ ok: true, status: "started" });
        await scheduleStarted;
        await expect(process.recvFrame(
          makeReq("proc.kill", { archive: false }),
        )).resolves.toMatchObject({ ok: true, data: { ok: true, pid } });
        rejectSchedule(new Error("late scheduler rejection"));
        await scheduled.catch(() => {});
        await Promise.resolve();
        expect(finishRun).not.toHaveBeenCalled();
      });
    });

    it("stops a requested-id media write whose head resolves after kill", async () => {
      const pid = "mech-kill-late-media-head";
      const mediaId = "requested-after-kill";
      const key = `var/media/0/${pid}/${mediaId}`;
      const stub = await initProcess(pid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        const originalStorage = process.storage;
        let releaseHead!: () => void;
        let markHeadStarted!: () => void;
        const headBlocked = new Promise<void>((resolve) => {
          releaseHead = resolve;
        });
        const headStarted = new Promise<void>((resolve) => {
          markHeadStarted = resolve;
        });
        process.storage = {
          head: vi.fn(async (requestedKey: string) => {
            if (requestedKey === key) {
              markHeadStarted();
              await headBlocked;
              return null;
            }
            return await originalStorage.head(requestedKey);
          }),
          list: (...args: any[]) => originalStorage.list(...args),
          delete: (...args: any[]) => originalStorage.delete(...args),
          put: (...args: any[]) => originalStorage.put(...args),
        };
        const writing = process.storeIncomingResource(
          { type: "image", mimeType: "image/png", mediaId },
          bodyFromBytes(new Uint8Array([1])),
        );
        await headStarted;
        await expect(process.recvFrame(
          makeReq("proc.kill", { archive: false }),
        )).resolves.toMatchObject({ ok: true, data: { ok: true, pid } });
        releaseHead();
        await expect(writing).resolves.toEqual({
          ok: false,
          error: "Process reset during media upload",
        });
        process.storage = originalStorage;
      });
    });

    it("persists cleanup debt and retries it without reviving the process", async () => {
      const pid = "mech-kill-finish-failure";
      const stub = await initProcess(pid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      const killed = await runInDurableObject(stub, async (instance: Process, state) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        const originalStorage = process.storage;
        const mediaDelete = vi.fn(async () => {
          expect(state.storage.kv.get("__gsv_process_killed__")).toMatchObject({
            pid,
            cleanup: "pending",
          });
          throw new Error("media delete unavailable");
        });
        process.storage = {
          list: vi.fn(async () => ({
            objects: [{ key: `var/media/0/${pid}/pending.png` }],
            truncated: false,
          })),
          delete: mediaDelete,
        };
        process.currentRun = { runId: "run-kill-failure" };
        process.sendSignal = vi.fn(async () => {
          expect(state.storage.kv.get("__gsv_process_killed__")).toMatchObject({
            pid,
            cleanup: "pending",
          });
          throw new Error("finish route unavailable");
        });
        await state.storage.setAlarm(Date.now() + 60_000);
        const deleteAlarm = vi.spyOn(state.storage, "deleteAlarm").mockRejectedValue(
          new Error("alarm cleanup unavailable"),
        );

        try {
          const response = await process.recvFrame(makeReq("proc.kill", { archive: false }));
          return {
            response,
            killed: process.killed,
            mediaDeleteCalls: mediaDelete.mock.calls.length,
            finishCalls: process.sendSignal.mock.calls.length,
            tombstone: state.storage.kv.get("__gsv_process_killed__"),
          };
        } finally {
          deleteAlarm.mockRestore();
          process.storage = originalStorage;
        }
      });

      expect(killed).toMatchObject({
        response: {
          ok: false,
          error: { message: "Process was killed but terminal cleanup is pending" },
        },
        killed: true,
        mediaDeleteCalls: 1,
        finishCalls: 1,
        tombstone: {
          version: 1,
          pid,
          uid: 0,
          result: { ok: true, pid, archivedMessages: 0, archives: [] },
          cleanup: "pending",
        },
      });
      await expect(stub.recvFrame(makeReq("proc.history", {}))).resolves.toMatchObject({
        ok: false,
        error: { code: 410, message: "Process no longer exists" },
      });
      await evictDurableObject(stub);
      await expect(stub.recvFrame(makeReq("proc.kill", { pid, archive: false })))
        .resolves.toMatchObject({
          ok: true,
          data: { ok: true, pid, archivedMessages: 0, archives: [] },
        });
      await expect(runInDurableObject(stub, (_instance: Process, state) => (
        state.storage.kv.get("__gsv_process_killed__")
      ))).resolves.toMatchObject({
        pid,
        cleanup: "completed",
      });
    });

    it("coalesces concurrent retries of pending terminal cleanup", async () => {
      const pid = "mech-kill-concurrent-cleanup";
      const stub = await initProcess(pid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      const result = await runInDurableObject(stub, async (instance: Process, state) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        const originalStorage = process.storage;
        let listCalls = 0;
        let markRetryStarted!: () => void;
        let releaseRetry!: () => void;
        const retryStarted = new Promise<void>((resolve) => {
          markRetryStarted = resolve;
        });
        const retryBlocked = new Promise<void>((resolve) => {
          releaseRetry = resolve;
        });
        const list = vi.fn(async () => {
          listCalls += 1;
          if (listCalls === 1) {
            return {
              objects: [{ key: `var/media/0/${pid}/pending.png` }],
              truncated: false,
            };
          }
          markRetryStarted();
          await retryBlocked;
          return { objects: [], truncated: false };
        });
        process.storage = {
          list,
          delete: vi.fn(async () => {
            throw new Error("media delete unavailable");
          }),
        };

        const initial = await process.recvFrame(
          makeReq("proc.kill", { archive: false }),
        );
        const firstRetry = process.recvFrame(makeReq("proc.kill", { archive: false }));
        await retryStarted;
        const secondRetry = process.recvFrame(makeReq("proc.kill", { archive: false }));
        releaseRetry();
        const retries = await Promise.all([firstRetry, secondRetry]);
        const tombstone = state.storage.kv.get("__gsv_process_killed__");
        process.storage = originalStorage;
        return { initial, retries, listCalls, tombstone };
      });

      expect(result.initial).toMatchObject({
        ok: false,
        error: { message: "Process was killed but terminal cleanup is pending" },
      });
      expect(result.listCalls).toBe(2);
      expect(result.retries[0]).toMatchObject({
        ok: true,
        data: { ok: true, pid, archivedMessages: 0, archives: [] },
      });
      expect(result.retries[1].data).toEqual(result.retries[0].data);
      expect(result.tombstone).toMatchObject({
        pid,
        cleanup: "completed",
        pendingCleanup: [],
      });
    });

    it("keeps finish notification best-effort after the terminal commit", async () => {
      const pid = "mech-kill-best-effort-finish";
      const runId = "run-kill-best-effort-finish";
      const stub = await initProcess(pid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      const first = await runInDurableObject(stub, async (instance: Process, state) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        process.currentRun = { runId };
        process.sendSignal = vi.fn(async () => {
          throw new Error("finish transport unavailable");
        });
        const response = await process.recvFrame(
          makeReq("proc.kill", { archive: false }),
        );
        return {
          response,
          finishCalls: process.sendSignal.mock.calls.length,
          tombstone: state.storage.kv.get("__gsv_process_killed__"),
        };
      });

      expect(first).toMatchObject({
        response: {
          ok: true,
          data: { ok: true, pid, archivedMessages: 0, archives: [] },
        },
        finishCalls: 1,
        tombstone: { pid, cleanup: "completed", pendingCleanup: [] },
      });

      await evictDurableObject(stub);
      // SAFETY: test fixture is constructed with the asserted domain shape.
      const replay = await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        process.sendSignal = vi.fn(async () => {});
        const response = await process.recvFrame(
          makeReq("proc.kill", { pid, archive: false }),
        );
        return { response, finishCalls: process.sendSignal.mock.calls.length };
      });
      expect(replay.response.data).toEqual(first.response.data);
      expect(replay.finishCalls).toBe(0);
    });

    it("archives the active run terminal boundary in its context epoch", async () => {
      const pid = "mech-kill-context-epoch-boundary";
      const runId = "run-kill-context-epoch-boundary";
      const epochId = "epoch-kill-boundary";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      const result = await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test exercises Process-owned context epoch archival.
        const process = instance as any;
        process.store.appendMessage("user", "archive the active run", { runId });
        process.store.createContextEpoch({
          id: epochId,
          generation: process.store.getHistoryGeneration(),
          systemPrompt: "Frozen test prompt.",
          r12yRevision: 0,
          r12yCount: 0,
          r12yBaseline: [],
          sourceManifest: { version: 1 },
          observedProjection: {
            version: 1,
            runtime: { date: "2026-08-28", timezone: "UTC" },
            targets: [],
            mcpServers: [],
            skills: { mode: "off", entries: [] },
          },
          now: 100,
        });
        process.currentRun = { runId };
        process.sendSignal = vi.fn(async () => {});
        const epochKey = `${process.historyArchiveDir()}/epochs/${epochId}.json.gz`;

        const response = await process.recvFrame(makeReq("proc.kill", {}));
        const archived = await process.env.STORAGE.get(epochKey);
        if (!archived) throw new Error("Expected killed context epoch archive");
        const manifest = await new Response(
          archived.body.pipeThrough(new DecompressionStream("gzip")),
        ).json();
        return { response, manifest };
      });

      expect(result.response).toMatchObject({
        ok: true,
        data: {
          ok: true,
          pid,
          archivedMessages: 1,
          contextEpochArchives: [
            expect.stringMatching(`/epochs/${epochId}\\.json\\.gz$`),
          ],
        },
      });
      expect(result.manifest).toMatchObject({
        epoch: {
          id: epochId,
          systemPrompt: "Frozen test prompt.",
          processActivity: [expect.objectContaining({
            run_id: runId,
            content: "archive the active run",
          })],
          runBoundaries: [expect.objectContaining({
            pid,
            runId,
            status: "aborted",
            reason: "process.kill",
          })],
        },
      });
    });

    it("delivers persisted output media before deleting live process media", async () => {
      const pid = "mech-kill-finish-media-order";
      const runId = "run-kill-finish-media-order";
      const key = `var/media/0/${pid}/scratch.png`;
      const stub = await initProcess(pid, ROOT_IDENTITY);
      const uploaded = await stub.recvFrame({
        type: "req",
        id: crypto.randomUUID(),
        call: "proc.resource.write",
        args: {
          resourceId: "reply.png",
          mediaType: "image",
          contentType: "image/png",
        },
        body: bodyFromBytes(new Uint8Array([7, 8, 9])),
      } satisfies ProcessResourceWriteRequestFrame);
      if (!uploaded.ok) throw new Error(uploaded.error.message);
      const resource = uploaded.data.resource;
      await env.STORAGE.put(key, new Uint8Array([7, 8, 9]), {
        httpMetadata: { contentType: "image/png" },
      });

// SAFETY: test fixture is constructed with the asserted domain shape.

      const result = await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        const media = [{
          type: "image",
          mimeType: "image/png",
          key: resource.ref.path.replace(/^\/+/, ""),
          path: resource.ref.path,
          size: resource.ref.size,
          revision: resource.ref.revision,
        }];
        let mediaPresentDuringFinish = false;
        let finishPayload: any = null;
        let releaseFinish!: () => void;
        let markFinishStarted!: () => void;
        const finishBlocked = new Promise<void>((resolve) => {
          releaseFinish = resolve;
        });
        const finishStarted = new Promise<void>((resolve) => {
          markFinishStarted = resolve;
        });
        process.currentRun = {
          runId,
          outputMedia: media,
          outputMediaPersisted: true,
        };
        process.sendSignal = vi.fn(async (signal: string, payload: ProcessTestValue) => {
          if (signal === "proc.run.finished") {
            finishPayload = payload;
            mediaPresentDuringFinish = await process.env.STORAGE.head(key) !== null;
            markFinishStarted();
            await finishBlocked;
          }
        });

        const first = process.recvFrame(makeReq("proc.kill", { archive: false }));
        await finishStarted;
        const second = process.recvFrame(makeReq("proc.kill", { archive: false }));
        const mediaPresentDuringRetry = await process.env.STORAGE.head(key) !== null;
        releaseFinish();
        const responses = await Promise.all([first, second]);
        return {
          responses,
          finishPayload,
          mediaPresentDuringFinish,
          mediaPresentDuringRetry,
        };
      });

      expect(result.responses[0]).toMatchObject({ ok: true, data: { ok: true, pid } });
      expect(result.responses[1].data).toEqual(result.responses[0].data);
      expect(result.mediaPresentDuringFinish).toBe(true);
      expect(result.mediaPresentDuringRetry).toBe(true);
      expect(result.finishPayload).toMatchObject({
        pid,
        runId,
        result: {
          media: [{ type: "resource", ref: { path: resource.ref.path } }],
        },
      });
      expect(await env.STORAGE.head(key)).toBeNull();
      expect(await env.STORAGE.head(resource.ref.path.replace(/^\/+/, ""))).not.toBeNull();
    });

    it("finishes the active run and leaves the executor empty and dead", async () => {
      const pid = "mech-kill-runtime";
      const stub = await initProcess(pid, ROOT_IDENTITY);
      const runId = "run-kill-runtime";

// SAFETY: test fixture is constructed with the asserted domain shape.

      const killed = await runInDurableObject(stub, async (instance: Process, state) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        const emitted: Array<{ signal: string; payload: ProcessTestValue }> = [];
        process.sendSignal = vi.fn(async (signal: string, payload: ProcessTestValue) => {
          emitted.push({ signal, payload });
        });
        process.currentRun = { runId };
        process.store.register(
          "dispatch-kill-1",
          "call-kill-1",
          runId,
          "fs.read",
          { path: "/tmp/test.txt" },
        );
        process.store.markDispatched("dispatch-kill-1");
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
      expect(killed.emitted.map(({ signal }) => signal)).toEqual([
        "proc.run.tool.finished",
        "proc.run.finished",
      ]);
      expect(killed.emitted[0]).toEqual({
        signal: "proc.run.tool.finished",
        payload: {
          pid,
          runId,
          executionId: "dispatch-kill-1",
          callId: "call-kill-1",
          outcome: "cancelled",
          timestamp: expect.any(Number),
        },
      });
      expect(killed.alarm).toBeNull();
      expect(killed.keys).toEqual(["__gsv_process_killed__"]);
      expect(killed.tables).not.toEqual(expect.arrayContaining([
        "conversations",
        "messages",
        "process_kv",
      ]));

      const reuse = await stub.recvFrame(
        makeReq("proc.setidentity", { identity: ROOT_IDENTITY }),
      );
      expect(reuse).toMatchObject({
        ok: false,
        error: { code: 410, message: "Process no longer exists" },
      });
    });

    it("keeps a killed pid dead after Durable Object eviction", async () => {
      const pid = "mech-kill-eviction";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      await expect(stub.recvFrame(
        makeReq("proc.kill", { pid, archive: false }),
      )).resolves.toMatchObject({
        ok: true,
        data: { ok: true, pid },
      });

      await evictDurableObject(stub);

      await expect(stub.recvFrame(
        makeReq("proc.kill", { pid, archive: false }),
      )).resolves.toMatchObject({
        ok: true,
        data: { ok: true, pid, archivedMessages: 0, archives: [] },
      });

      await expect(stub.recvFrame(
        makeReq("proc.setidentity", { pid, identity: ROOT_IDENTITY }),
      )).resolves.toMatchObject({
        ok: false,
        error: { code: 410, message: "Process no longer exists" },
      });
      // SAFETY: test fixture is constructed with the asserted domain shape.
      await expect(runInDurableObject(stub, (instance: Process, state) => ({
        // SAFETY: test fixture is constructed with the asserted domain shape.
        killed: (instance as any).killed,
        tombstone: state.storage.kv.get("__gsv_process_killed__"),
        tables: state.storage.sql.exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table'",
        ).toArray().map((row) => row.name),
      }))).resolves.toEqual({
        killed: true,
        tombstone: expect.objectContaining({
          version: 1,
          pid,
          cleanup: "completed",
          result: expect.objectContaining({ ok: true, pid }),
        }),
        tables: expect.not.arrayContaining([
          "conversations",
          "messages",
          "process_kv",
        ]),
      });
    });

    it("rolls back the storage wipe when the terminal commit fails", async () => {
      const pid = "mech-kill-atomic-rollback";
      const runId = "run-kill-atomic-rollback";
      const stub = await initProcess(pid, ROOT_IDENTITY);
      const alarmAt = Date.now() + 60_000;

// SAFETY: test fixture is constructed with the asserted domain shape.

      const failed = await runInDurableObject(stub, async (instance: Process, state) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        process.currentRun = { runId };
        process.store.appendMessage("user", "survive the failed kill", { runId });
        process.store.enqueue("queued-after-failed-kill", "queued work must survive");
        process.store.register(
          "dispatch-terminal-failure",
          "call-terminal-failure",
          runId,
          "fs.read",
          { path: "/tmp/terminal" },
        );
        process.store.setPendingHil({
          requestId: "hil-terminal-failure",
          runId,
          toolCallId: "call-terminal-failure",
          toolName: "Read",
          syscall: "fs.read",
          args: { path: "/tmp/terminal" },
          createdAt: Date.now(),
        });
        process.sendSignal = vi.fn(async () => {});
        state.storage.kv.put("kill-rollback-sentinel", "present");
        await state.storage.setAlarm(alarmAt);

        const realTransactionSync = state.storage.transactionSync.bind(state.storage);
        const transactionSpy = vi.spyOn(state.storage, "transactionSync").mockImplementation(
          (closure) => realTransactionSync(() => {
            closure();
            throw new Error("injected terminal commit failure");
          }),
        );
        let response;
        try {
          response = await process.recvFrame(
            makeReq("proc.kill", { pid, archive: false }),
          );
        } finally {
          transactionSpy.mockRestore();
        }

        return {
          response,
          killed: process.killed,
          alarm: await state.storage.getAlarm(),
          sentinel: state.storage.kv.get("kill-rollback-sentinel"),
          tombstone: state.storage.kv.get("__gsv_process_killed__"),
          queueSize: process.store.queueSize(),
          currentRun: process.currentRun,
          tools: process.store.getResults(runId),
          pendingHil: process.store.getPendingHilForRun(runId),
          finishCalls: process.sendSignal.mock.calls.length,
          tables: state.storage.sql.exec<{ name: string }>(
            "SELECT name FROM sqlite_master WHERE type = 'table'",
          ).toArray().map((row) => row.name),
        };
      });

      expect(failed).toMatchObject({
        response: {
          ok: false,
          error: { message: "injected terminal commit failure" },
        },
        killed: false,
        alarm: alarmAt,
        sentinel: "present",
        tombstone: undefined,
        queueSize: 1,
        currentRun: { runId },
        tools: [expect.objectContaining({
          dispatchId: "dispatch-terminal-failure",
          status: "registered",
        })],
        pendingHil: { requestId: "hil-terminal-failure", runId },
        finishCalls: 0,
        tables: expect.arrayContaining(["messages", "process_kv"]),
      });

      await evictDurableObject(stub);
      // SAFETY: test fixture is constructed with the asserted domain shape.
      const recovered = await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        return {
          messages: process.store.getMessages(),
          queueSize: process.store.queueSize(),
          currentRun: process.currentRun,
          tools: process.store.getResults(runId),
          pendingHil: process.store.getPendingHilForRun(runId),
        };
      });
      expect(recovered.messages).toEqual([
        expect.objectContaining({ content: "survive the failed kill" }),
      ]);
      expect(recovered.queueSize).toBe(1);
      expect(recovered.currentRun).toMatchObject({ runId });
      expect(recovered.tools).toEqual([
        expect.objectContaining({
          dispatchId: "dispatch-terminal-failure",
          status: "registered",
        }),
      ]);
      expect(recovered.pendingHil).toMatchObject({
        requestId: "hil-terminal-failure",
        runId,
      });

      await expect(stub.recvFrame(
        makeReq("proc.kill", { pid, archive: false }),
      )).resolves.toMatchObject({
        ok: true,
        data: { ok: true, pid },
      });
      await evictDurableObject(stub);
      await expect(stub.recvFrame(
        makeReq("proc.setidentity", { pid, identity: ROOT_IDENTITY }),
      )).resolves.toMatchObject({
        ok: false,
        error: { code: 410, message: "Process no longer exists" },
      });
    });

  });

  describe("schema upgrades", () => {
    it("terminalizes provider HIL calls without inventing nested CodeMode results", async () => {
      const stub = await initProcess("mech-upgrade-v3-hil", ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
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

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const sql = (instance as any).ctx.storage.sql as SqlStorage;
        sql.exec("ALTER TABLE pending_tool_calls DROP COLUMN outcome");
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const rows = [
          ["completed", JSON.stringify({ status: "completed" }), null, "completed"],
          ["failed-envelope", JSON.stringify({ status: "failed" }), null, "completed"],
          ["denied", null, "Tool execution denied by user", "error"],
          ["failed-error", null, "provider failure", "error"],
        // SAFETY: test fixture is constructed with the asserted domain shape.
        ] as const;
        rows.forEach(([id, result, error, status], index) => {
          sql.exec(
            `INSERT INTO pending_tool_calls (
              dispatch_id, id, run_id, call, args_json,
              result_json, error, status, created_at
            ) VALUES (?, ?, 'run-upgrade-outcomes', 'fs.read', '{}', ?, ?, ?, ?)`,
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

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
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
            dispatch_id, id, run_id, call, args_json,
            status, created_at
          ) VALUES (?, ?, ?, ?, '{}', ?, ?)`,
          dispatchId,
          id,
          runId,
          call,
          status,
          createdAt,
        );
        const insertHil = (requestId: string, runId: string, toolCallId: string) => sql.exec(
          `INSERT INTO pending_hil (
            request_id, run_id, tool_call_id, tool_name,
            syscall, args_json, created_at
          ) VALUES (?, ?, ?, 'Read', 'fs.read', '{}', 1)`,
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

    it("preserves legacy user work and restores queued runtime event roles when upgrading from v8", async () => {
      const stub = await initProcess("mech-upgrade-v8-queue", ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const sql = (instance as any).ctx.storage.sql as SqlStorage;
        sql.exec("ALTER TABLE message_queue DROP COLUMN provenance_json");
        sql.exec("ALTER TABLE message_queue DROP COLUMN kind");
        sql.exec("ALTER TABLE message_queue DROP COLUMN role");
        sql.exec(
          `INSERT INTO message_queue (
            run_id, generation, message, origin_json, created_at
          ) VALUES (?, 1, ?, ?, 1)`,
          "run-user",
          "ordinary queued work",
          JSON.stringify({ kind: "process", sourcePid: "child" }),
        );
        sql.exec(
          `INSERT INTO message_queue (
            run_id, generation, message, origin_json, created_at
          ) VALUES (?, 1, ?, ?, 2)`,
          "run-schedule",
          "scheduled work",
          JSON.stringify({ kind: "scheduler", scheduleId: "sched-1" }),
        );
        sql.exec(
          `INSERT INTO message_queue (
            run_id, generation, message, created_at
          ) VALUES (?, 1, ?, 3)`,
          "run-wake",
          "A runtime event arrived while you were busy. Review the process event above and continue.",
        );

        for (const statement of PROCESS_V009_TYPED_MESSAGE_QUEUE.statements) {
          sql.exec(statement);
        }

        const rows = sql.exec<{
          run_id: string;
          role: string;
          kind: string;
          provenance_json: string | null;
        }>(
          `SELECT run_id, role, kind, provenance_json
             FROM message_queue
            ORDER BY created_at ASC`,
        ).toArray();
        expect(rows[0]).toEqual({
          run_id: "run-user",
          role: "user",
          kind: "message",
          provenance_json: null,
        });
        expect(rows[1]).toMatchObject({
          run_id: "run-schedule",
          role: "system",
          kind: "schedule.event",
        });
        expect(JSON.parse(rows[1]!.provenance_json!)).toEqual({
          source: "kernel",
          eventId: "run-schedule",
          eventType: "schedule.event",
        });
        expect(rows[2]).toMatchObject({
          run_id: "run-wake",
          role: "system",
          kind: "runtime.wake",
        });
        expect(JSON.parse(rows[2]!.provenance_json!)).toEqual({
          source: "process",
          eventType: "runtime.wake",
        });
      });
    });
  });

  describe("unknown command", () => {
    it("returns error for unknown call", async () => {
      const pid = "mech-unknown";
      const stub = await initProcess(pid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      const res = (await stub.recvFrame(
        makeReq("proc.bogus", {}),
      // SAFETY: test fixture is constructed with the asserted domain shape.
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

// SAFETY: test fixture is constructed with the asserted domain shape.

      await stub.recvFrame({
        type: "sig",
        signal: "identity.changed",
        payload: { identity: newIdentity },
      // SAFETY: test fixture is constructed with the asserted domain shape.
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

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        process.sendSignal = vi.fn(async () => {});
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
        process.currentRun = { runId: "run-timeout" };

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
        const finishes = process.sendSignal.mock.calls
          .filter(([signal]: [string]) => signal === "proc.run.tool.finished");
        expect(finishes).toEqual([[
          "proc.run.tool.finished",
          {
            pid,
            runId: "run-timeout",
            executionId: "dispatch-timeout",
            callId: "call-timeout",
            outcome: "failed",
            timestamp: expect.any(Number),
          },
        ]]);
        expect(JSON.stringify(finishes[0][1])).not.toContain("timed out");
        process.store.clearPendingToolCalls();
        process.currentRun = null;
      });
    });

    it("emits one sanitized terminal signal for a started execution", async () => {
      const pid = "mech-res-tool-terminal-signal";
      const stub = await initProcess(pid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        process.sendSignal = vi.fn(async () => {});
        process.scheduleTick = vi.fn(async () => {});
        process.store.register(
          "dispatch-terminal",
          "provider-call",
          "run-terminal",
          "fs.read",
          { path: "/private/input" },
        );
        process.store.markDispatched("dispatch-terminal");
        process.currentRun = { runId: "run-terminal" };

        await process.handleRes({
          type: "res",
          id: "dispatch-terminal",
          ok: true,
          data: { path: "/private/input", content: "private output" },
        });
        await process.handleRes({
          type: "res",
          id: "dispatch-terminal",
          ok: false,
          error: { code: 500, message: "late private failure" },
        });

        const finishes = process.sendSignal.mock.calls
          .filter(([signal]: [string]) => signal === "proc.run.tool.finished");
        expect(finishes).toHaveLength(1);
        expect(finishes[0][1]).toEqual({
          pid,
          runId: "run-terminal",
          executionId: "dispatch-terminal",
          callId: "provider-call",
          outcome: "completed",
          timestamp: expect.any(Number),
        });
        expect(JSON.stringify(finishes[0][1])).not.toContain("private");
        process.store.clearPendingToolCalls();
        process.currentRun = null;
      });
    });

    it("emits a failed terminal signal for a transport error", async () => {
      const pid = "mech-res-tool-transport-error";
      const stub = await initProcess(pid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        process.sendSignal = vi.fn(async () => {});
        process.scheduleTick = vi.fn(async () => {});
        process.store.register(
          "dispatch-transport-error",
          "call-transport-error",
          "run-transport-error",
          "fs.read",
          { path: "/private/input" },
        );
        process.store.markDispatched("dispatch-transport-error");
        process.currentRun = { runId: "run-transport-error" };

        await process.handleRes({
          type: "res",
          id: "dispatch-transport-error",
          ok: false,
          error: { code: 503, message: "private transport failure" },
        });

        expect(process.sendSignal).toHaveBeenCalledWith(
          "proc.run.tool.finished",
          {
            pid,
            runId: "run-transport-error",
            executionId: "dispatch-transport-error",
            callId: "call-transport-error",
            outcome: "failed",
            timestamp: expect.any(Number),
          },
        );
        const finish = process.sendSignal.mock.calls.find(
          ([signal]: [string]) => signal === "proc.run.tool.finished",
        );
        expect(JSON.stringify(finish?.[1])).not.toContain("private");
        process.store.clearPendingToolCalls();
        process.currentRun = null;
      });
    });

    it("emits cancelled finish only for dispatched tools during interruption", async () => {
      const pid = "mech-res-tool-cancelled-signal";
      const stub = await initProcess(pid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        process.sendSignal = vi.fn(async () => {});
        process.currentRun = { runId: "run-cancelled" };
        process.store.register(
          "dispatch-started",
          "call-started",
          "run-cancelled",
          "fs.read",
          {},
        );
        process.store.markDispatched("dispatch-started");
        process.store.register(
          "dispatch-registered",
          "call-registered",
          "run-cancelled",
          "fs.read",
          {},
        );

        await process.ingestToolResults(
          "run-cancelled",
          process.store.getResults("run-cancelled"),
          { interruptPending: "private cancellation reason" },
        );

        const finishes = process.sendSignal.mock.calls
          .filter(([signal]: [string]) => signal === "proc.run.tool.finished");
        expect(finishes).toHaveLength(1);
        expect(finishes[0][1]).toMatchObject({
          pid,
          runId: "run-cancelled",
          executionId: "dispatch-started",
          callId: "call-started",
          outcome: "cancelled",
        });
        expect(JSON.stringify(finishes[0][1])).not.toContain("private");
        process.currentRun = null;
      });
    });

    it("fails a run whose media preparation watchdog expires", async () => {
      const pid = "mech-res-media-timeout";
      const stub = await initProcess(pid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        process.sendSignal = vi.fn();
        const messageId = process.store.appendMessage("user", "slow attachment", {
          runId: "run-media-timeout",
        });
        process.currentRun = {
          runId: "run-media-timeout",
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

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        process.schedule = vi.fn();
        process.currentRun = { runId: "run-timeouts" };
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

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        process.sendSignal = vi.fn();
        process.schedule = vi.fn(async () => {
          throw new Error("scheduler unavailable");
        });
        process.dispatchSyscall = vi.fn();
        process.currentRun = {
          runId: "run-timeout-schedule-failure",
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
      // SAFETY: test fixture is constructed with the asserted domain shape.
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
            // SAFETY: test fixture is constructed with the asserted domain shape.
            return {
              type: "res",
              id: frame.id,
              ok: true,
              data: { status: "running", output: "", sessionId: "sh_late" },
            // SAFETY: test fixture is constructed with the asserted domain shape.
            } as ResponseFrame;
          }
          return originalRecvFrame.call(this, processId, frame);
        },
      );

// SAFETY: test fixture is constructed with the asserted domain shape.

      try {
        await runInDurableObject(stub, async (instance: Process) => {
          // SAFETY: test fixture is constructed with the asserted domain shape.
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
            config: {
              executor: { kind: "process", pid },
              profile: "task",
              provider: "test",
              model: "test",
              apiKey: "",
              reasoning: "off",
              maxTokens: 8192,
              // SAFETY: test fixture is constructed with the asserted domain shape.
              contextWindowTokens: 128000,
              contextWindowSource: "config",
              maxContextBytes: 32768,
              generationStreaming: "off",
            },
            tools: offeredTools("Shell"),
            devices: [],
            mcpServers: [],
            systemPrompt: "Test system prompt.",
            approvalPolicy: { default: "auto", rules: [] },
          };

          const ticking = process.tick({ runId: "run-direct-old", generation: 0 });
          await requestStarted;
          // SAFETY: test fixture is constructed with the asserted domain shape.
          const response = await Promise.race([
            instance.recvFrame(makeReq("proc.send", {
              message: "stop waiting",
              origin: { kind: "client", connectionId: "client-1" },
            })),
            new Promise<never>((_resolve, reject) => {
              setTimeout(() => reject(new Error("proc.send was blocked by the shell syscall")), 250);
            // SAFETY: test fixture is constructed with the asserted domain shape.
            }),
          // SAFETY: test fixture is constructed with the asserted domain shape.
          ]) as ResponseOkFrame;
          // SAFETY: test fixture is constructed with the asserted domain shape.
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
      // SAFETY: test fixture is constructed with the asserted domain shape.
      const recvSpy = vi.spyOn(Kernel.prototype as any, "recvFrame").mockImplementation(
        async function (this: Kernel, processId: string, frame: any) {
          if (frame?.type === "req" && frame.id === "codemode-direct-old") {
            markRequestStarted();
            await responseBlocked;
            // SAFETY: test fixture is constructed with the asserted domain shape.
            return {
              type: "res",
              id: frame.id,
              ok: true,
              data: { status: "running", output: "", sessionId: "sh_codemode_late" },
            // SAFETY: test fixture is constructed with the asserted domain shape.
            } as ResponseFrame;
          }
          return originalRecvFrame.call(this, processId, frame);
        },
      );

// SAFETY: test fixture is constructed with the asserted domain shape.

      try {
        await runInDurableObject(stub, async (instance: Process) => {
          // SAFETY: test fixture is constructed with the asserted domain shape.
          const process = instance as any;
          process.sendSignal = vi.fn();
          process.scheduleTick = vi.fn(async () => {});
          process.currentRun = { runId: "run-codemode-old" };

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

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
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

// SAFETY: test fixture is constructed with the asserted domain shape.

      await stub.recvFrame({
        type: "res",
        // SAFETY: test fixture is constructed with the asserted domain shape.
        id: "nonexistent-call-id",
        ok: true,
        data: { content: "hello" },
      // SAFETY: test fixture is constructed with the asserted domain shape.
      } as any);
    });

    it("adds line numbers to agent filesystem results", async () => {
      const pid = "mech-res-sync-body";
      const stub = await initProcess(pid, ROOT_IDENTITY);
      const originalRecvFrame = Kernel.prototype.recvFrame;
      let forwardedArgs: ProcessTestValue;
      // SAFETY: test fixture is constructed with the asserted domain shape.
      const recvSpy = vi.spyOn(Kernel.prototype as any, "recvFrame").mockImplementation(
        async function (this: Kernel, processId: string, frame: any) {
          if (frame?.type === "req" && frame.id === "dispatch-sync-body") {
            forwardedArgs = frame.args;
            // SAFETY: test fixture is constructed with the asserted domain shape.
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
                truncated: true,
                nextOffset: 2,
              },
              body: bodyFromText("hello"),
            // SAFETY: test fixture is constructed with the asserted domain shape.
            } as ResponseFrame;
          }
          return originalRecvFrame.call(this, processId, frame);
        },
      );

// SAFETY: test fixture is constructed with the asserted domain shape.

      try {
        await runInDurableObject(stub, async (instance: Process) => {
          // SAFETY: test fixture is constructed with the asserted domain shape.
          const process = instance as any;
          process.currentRun = { runId: "run-sync-body" };
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
            result: {
              content: "     2\thello\n\n[Read truncated. Continue with Read using offset 2.]",
            },
          }]);
          expect(forwardedArgs).toEqual({
            path: "/tmp/note.txt",
            offset: 1,
            limit: 2_000,
            maxBytes: 65_536,
            representation: "resource",
          });
          process.currentRun = null;
        });
      } finally {
        recvSpy.mockRestore();
      }
    });

    it("rejects an oversized text response from a device that ignores Read bounds", async () => {
      const pid = "mech-res-read-hard-cap";
      const stub = await initProcess(pid, ROOT_IDENTITY);

      await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: this test exercises private Process tool response ownership.
        const process = instance as any;
        process.currentRun = { runId: "run-read-hard-cap" };
        process.sendSignal = vi.fn(async () => {});
        process.scheduleTick = vi.fn(async () => {});
        process.store.register(
          "dispatch-read-hard-cap",
          "call-read-hard-cap",
          "run-read-hard-cap",
          "fs.read",
          { path: "/tmp/huge.txt" },
        );
        process.store.markDispatched("dispatch-read-hard-cap");

        await process.handleRes({
          type: "res",
          id: "dispatch-read-hard-cap",
          ok: true,
          data: {
            ok: true,
            path: "/tmp/huge.txt",
            kind: "text",
            contentType: "text/plain",
            size: 65_537,
            lines: 1,
          },
          body: bodyFromText("x".repeat(65_537)),
        });

        expect(process.store.getResults("run-read-hard-cap")).toMatchObject([{
          status: "error",
          error: "Body exceeds limit (65537 bytes, max 65536)",
        }]);
        process.currentRun = null;
      });
    });

    it("stops response body materialization when its run is aborted", async () => {
      const pid = "mech-res-body-abort";
      const stub = await initProcess(pid, ROOT_IDENTITY);

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        process.currentRun = { runId: "run-body-abort" };
        process.store.register(
          "dispatch-body-abort",
          "call-body-abort",
          "run-body-abort",
          "fs.read",
          { path: "/tmp/note.txt" },
        );
        process.store.markDispatched("dispatch-body-abort");
        let cancelled: ProcessTestValue;
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

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
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

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const process = instance as any;
        const dispatched: ProcessTestValue[] = [];
        process.sendSignal = async () => {};
        process.scheduleTick = async () => {};
        process.dispatchSyscall = async (
          _runId: string,
          _id: string,
          _call: string,
          args: ProcessTestValue,
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

// SAFETY: test fixture is constructed with the asserted domain shape.

      await runInDurableObject(stub, async (instance: Process) => {
        // SAFETY: test fixture is constructed with the asserted domain shape.
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
          tools: offeredTools("Shell"),
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
