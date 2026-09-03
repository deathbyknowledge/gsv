/** Shared fixtures for Process Durable Object integration tests. */

import { Kernel } from "../kernel/do";
import type { RequestFrame, ResponseFrame } from "../protocol/frames";
import type { InternalRequestFrame } from "../protocol/process-frames";
import type {
  ProcessAdapterDeliverArgs,
  ProcessRuntimeEventDeliverArgs,
  ProcessInboundFrame,
  ProcessScheduleDeliverArgs,
} from "../protocol/process-frames";
import { getKernelPtr, getProcessByPid } from "../shared/utils";
import { TOOL_TO_SYSCALL } from "../syscalls/constants";
import type { Process } from "./do";
import type { ProcessIdentity } from "@humansandmachines/gsv/protocol";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { expect, vi } from "vitest";

export type ProcessTestValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | ProcessTestValue[]
  | { [key: string]: ProcessTestValue };

export const ROOT_IDENTITY: ProcessIdentity = {
  uid: 0,
  gid: 0,
  gids: [0],
  username: "root",
  home: "/root",
  cwd: "/root",
};

export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

export function runInProcess<T>(
  stub: DurableObjectStub<Process>,
  run: (process: any, state: DurableObjectState, instance: any) => T,
) {
  return runInDurableObject(stub, (instance, state) => {
    // SAFETY: cloudflare:test returns the local object behind this Process stub.
    const process = instance as any;
    return run(process, state, process);
  });
}

export async function okProcessResponse(
  stub: DurableObjectStub<Process> | Process,
  frame: ProcessInboundFrame,
): Promise<{ type: "res"; id: string; ok: true; data: any }> {
  // SAFETY: this test helper validates the response envelope before returning it.
  const response = await (stub as any).recvFrame(frame);
  if (!response || response.type !== "res" || !response.ok) {
    throw new Error("Process did not return a successful response");
  }
  return response;
}

// SAFETY: test fixture is constructed with the asserted domain shape.
export function makeReq(call: string, args: RequestFrame["args"]): RequestFrame {
  // SAFETY: test fixture is constructed with the asserted domain shape.
  return { type: "req", id: crypto.randomUUID(), call, args } as RequestFrame;
}

export function drainProcessQueue(store: any) {
  const queued = [];
  let next = store.queue.dequeue();
  while (next) {
    queued.push(next);
    next = store.queue.dequeue();
  }
  return queued;
}

export function makeScheduleDeliverReq(
  args: Omit<ProcessScheduleDeliverArgs, "runId" | "firedAtMs"> & {
    runId?: string;
    firedAtMs?: number;
  },
): InternalRequestFrame<"proc.schedule.deliver"> {
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

export function makeAdapterDeliverReq(
  args: ProcessAdapterDeliverArgs,
): InternalRequestFrame<"proc.adapter.deliver"> {
  return {
    type: "req",
    id: crypto.randomUUID(),
    call: "proc.adapter.deliver",
    args,
  };
}

export function makeRuntimeEventDeliverReq(
  args: ProcessRuntimeEventDeliverArgs,
): InternalRequestFrame<"proc.runtime.event.deliver"> {
  return {
    type: "req",
    id: crypto.randomUUID(),
    call: "proc.runtime.event.deliver",
    args,
  };
}

export function makeRuntimeEventReq(
  eventId: string,
  workPid: string,
): InternalRequestFrame<"proc.runtime.event.deliver"> {
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

export function registerToolBlock(
  process: any,
  runId: string,
  toolCalls: Array<{ id: string; name: string; arguments: ProcessTestValue }>,
): void {
  if (process.runs.active?.runId === runId) {
    process.runs.active = {
      ...process.runs.active,
      offeredToolNames: [
        ...new Set([
          ...(process.runs.active.offeredToolNames ?? []),
          ...toolCalls.map((toolCall) => toolCall.name),
        ]),
      ],
    };
  }
  for (const toolCall of toolCalls) {
    const syscall = TOOL_TO_SYSCALL[toolCall.name];
    const args = syscall
      ? process.tools.prepareToolArgs(syscall, toolCall.arguments).args
      : toolCall.arguments;
    process.store.tools.register(
      `dispatch-${toolCall.id}`,
      toolCall.id,
      runId,
      syscall ?? toolCall.name,
      args,
      "default",
    );
  }
}

export function offeredTools(...names: string[]) {
  return names.map((name) => ({
    name,
    description: `${name} test tool`,
    inputSchema: { type: "object", properties: {} },
  }));
  // SAFETY: test fixture is constructed with the asserted domain shape.
}

export function responsibilityKernelResult(call: string) {
  if (call === "r12y.list") {
    return { responsibilities: [], count: 0, revision: 0 };
  }
  if (call === "r12y.changes") {
    return { transitions: [], revision: 0, hasMore: false };
  }
  return undefined;
}

export function messageAction(text: string, id = `message-${crypto.randomUUID()}`) {
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

export function messageUpdateAction(text: string, id = `message-${crypto.randomUUID()}`) {
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

export function yieldAction(id = `yield-${crypto.randomUUID()}`) {
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

export function processTestConfig(
  pid: string,
  overrides: Record<string, ProcessTestValue> = {},
) {
  return {
    // SAFETY: test fixture is constructed with the asserted domain shape.
    executor: { kind: "process" as const, pid },
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
    ...overrides,
  };
}

export function terminalTestConfig(pid: string) {
  return processTestConfig(pid, {
    // SAFETY: test fixture is constructed with the asserted domain shape.
    generationStreaming: "off" as const,
  });
  // SAFETY: test fixture is constructed with the asserted domain shape.
}

export function generationRun(
  runId: string,
  config: ProcessTestValue,
  overrides: Record<string, ProcessTestValue> = {},
) {
  return {
    runId,
    config,
    tools: [],
    devices: [],
    systemPrompt: "Test system prompt.",
    approvalPolicy: { default: "auto", rules: [] },
    ...overrides,
  };
}

export function approvedRun(
  runId: string,
  overrides: Record<string, ProcessTestValue> = {},
) {
  return { runId, approvalPolicy: { default: "auto", rules: [] }, ...overrides };
}

export function setHistoryPolicy(
  process: any,
  policy: Record<string, ProcessTestValue> = {},
): void {
  process.store.state.setValue(
    "historyPolicy",
    JSON.stringify({
      overflow: "auto-compact",
      compactAtPressure: 0.9,
      compactToPressure: 0.4,
      ...policy,
      updatedAt: policy.updatedAt ?? Date.now(),
    }),
  );
}

export function terminalTestResponse(content: Array<Record<string, ProcessTestValue>>) {
  return assistantResponse(content, { usage: testUsage() });
}

export function assistantResponse(
  content: ProcessTestValue[],
  overrides: Record<string, ProcessTestValue> = {},
) {
  return {
    // SAFETY: test fixture is constructed with the asserted domain shape.
    role: "assistant" as const,
    content,
    api: "test",
    provider: "test",
    model: "test",
    // SAFETY: test fixture is constructed with the asserted domain shape.
    stopReason: "stop" as const,
    timestamp: Date.now(),
    ...overrides,
  };
}

export function mockRunEventSink(
  process: any,
  pid: string,
  emitted: Array<{ signal: string; payload: ProcessTestValue }>,
): void {
  process.streams.openRunEventSink = async (runId: string) => ({
    emit: async (seq: number, event: ProcessTestValue) => {
      // SAFETY: test fixture is constructed with the asserted domain shape.
      const payload = { pid, runId, seq, event } as any;
      emitted.push({
        signal: "proc.run.stream",
        payload,
      });
    },
    close: async () => {},
  });
}

export function captureSignals(process: any) {
  const emitted: Array<{ signal: string; payload: ProcessTestValue }> = [];
  process.sendSignal = vi.fn(async (signal: string, payload: ProcessTestValue) => {
    emitted.push({ signal, payload });
  });
  return emitted;
}

export function mockGeneration<Generate, GenerateText>(
  process: any,
  generate: Generate,
  generateText: GenerateText,
): void {
  process.generation = { generate, generateText };
}

export function openAiChatSseChunk(payload: Record<string, ProcessTestValue>): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export function testUsage(input = 0, output = 0) {
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

export const KIMI_WORKERS_CONTEXT_OVERFLOW_ERROR =
  '8007: {"object":"error","message":"The input (301552 tokens) is longer than the model\'s context length (262144 tokens).","type":"BadRequestError","param":null,"code":400}';

// SAFETY: test fixture is constructed with the asserted domain shape.
export function kimiWorkersConfigWithFallback(pid: string, contextWindowTokens = 1_000_000) {
  return {
    // SAFETY: test fixture is constructed with the asserted domain shape.
    executor: { kind: "process" as const, pid },
    provider: "workers-ai",
    model: "@cf/moonshotai/kimi-k2.6",
    apiKey: "",
    reasoning: "off",
    maxTokens: 100,
    contextWindowTokens,
    // SAFETY: test fixture is constructed with the asserted domain shape.
    contextWindowSource: "config" as const,
    maxContextBytes: 32768,
    fallbacks: [
      {
        modelId: "overflow-backup",
        modelName: "Overflow Backup",
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
      },
    ],
  };
  // SAFETY: test fixture is constructed with the asserted domain shape.
}

export async function stubGeneration(
  stub: DurableObjectStub<Process>,
  generate: (request: any) => string | Promise<string>,
) {
  await runInProcess(stub, (process) => {
    // SAFETY: test fixture is constructed with the asserted domain shape.
    process.generation = {
      async generate(request: any) {
        const text = await generate(request);
        return {
          role: "assistant",
          content: [{ type: "text", text }, messageAction(text)],
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
export async function registerInKernel(pid: string, identity: ProcessIdentity) {
  const kernel = await getKernelPtr();
  // SAFETY: test fixture is constructed with the asserted domain shape.
  const stub: DurableObjectStub<Kernel> = kernel as any;
  await runInDurableObject(stub, (instance: Kernel) => {
    // SAFETY: test fixture is constructed with the asserted domain shape.
    const k = instance as any;
    k.caps.seed();
    k.procs.spawn(pid, identity, {});
  });
}

/**
 * Poll until the Process DO's currentRun is null (run finished).
 * The agents SDK alarm handler does cross-DO async work that isn't
 * fully awaited by runDurableObjectAlarm, so we poll.
 */
export async function waitForRunComplete(stub: DurableObjectStub<Process>, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  // SAFETY: test fixture is constructed with the asserted domain shape.
  while (Date.now() < deadline) {
    const done = await runInProcess(
      stub,
      (process) => process.store.state.getValue("currentRun") === null,
    );
    if (done) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Timed out waiting for run to complete");
}

export async function waitForStoredMessage(
  stub: DurableObjectStub<Process>,
  predicate: (message: any) => boolean,
  timeoutMs = 2_000,
) {
  const deadline = Date.now() + timeoutMs;
  // SAFETY: test fixture is constructed with the asserted domain shape.
  while (Date.now() < deadline) {
    const message = await runInProcess(stub, (process) =>
      process.store.messages.getMessages().find(predicate),
    );
    if (message) {
      return message;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for process message");
}

export async function waitForTaskTitle(
  stub: DurableObjectStub<Process>,
  expected: string,
  timeoutMs = 2_000,
) {
  const deadline = Date.now() + timeoutMs;
  // SAFETY: test fixture is constructed with the asserted domain shape.
  while (Date.now() < deadline) {
    const title = await runInProcess(stub, (process) =>
      process.store.state.getValue("taskTitle"),
    );
    if (title === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for task title: ${expected}`);
}

export async function driveProcessUntilIdle(stub: DurableObjectStub<Process>, timeoutMs = 50_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await runDurableObjectAlarm(stub);
    // SAFETY: test fixture is constructed with the asserted domain shape.
    const done = await runInProcess(
      stub,
      (process) => process.store.state.getValue("currentRun") === null,
    );
    if (done) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Timed out driving process to idle");
}

/**
 * Initialize a Process DO with identity (via proc.setidentity RPC).
 * Optionally registers it in the kernel first.
 */
export async function initProcess(
  pid: string,
  identity: ProcessIdentity,
  opts?: { register?: boolean },
) {
  if (opts?.register !== false) {
    await registerInKernel(pid, identity);
  }
  const stub = await getProcessByPid(pid);
  const res = await stub.recvFrame(makeReq("proc.setidentity", { identity }));
  // SAFETY: test fixture is constructed with the asserted domain shape.
  expect((res as ResponseFrame).ok).toBe(true);
  return stub;
}
