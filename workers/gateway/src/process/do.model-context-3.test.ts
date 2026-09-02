import type { Context } from "@earendil-works/pi-ai";
import type { AiConfigResult } from "@humansandmachines/gsv/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  captureSignals, mockGeneration, processTestConfig, generationRun, assistantResponse,
  okProcessResponse, runInProcess, ROOT_IDENTITY, drainProcessQueue, initProcess, makeReq,
  makeScheduleDeliverReq, messageAction, setHistoryPolicy, terminalTestConfig, terminalTestResponse,
  yieldAction,
} from "./do-test-harness";

describe("model context", () => {
  it("returns ordinary IPC output to its caller without human run control", async () => {
    const pid = "mech-terminal-ipc-message";
    const runId = "run-terminal-ipc-message";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    const result = await runInProcess(stub, async (process) => {
      const emitted = captureSignals(process);
      process.streams.complete = vi.fn(async () => {});
      mockGeneration(process, async (request: any) => {
        expect(request.context.systemPrompt).toContain("This run is a delegated Process call");
        expect(request.context.tools).toBeUndefined();
        return terminalTestResponse([{ type: "text", text: "Private worker result." }]);
      }, async () => {
        return "unused";
      });
      process.store.messages.appendMessage("user", "Return to the caller.", { runId });
      process.runs.active = generationRun(runId, terminalTestConfig(pid), {
        returnToCaller: true
      });

      await process.run.runTick(runId);
      return { emitted, streamCalls: process.streams.complete.mock.calls };
    });

    expect(result.streamCalls).toEqual([]);
    expect(
      result.emitted.findLast((entry) => entry.signal === "proc.run.finished")?.payload,
    ).toMatchObject({
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

    await runInProcess(stub, async (process) => {
      const emitted = captureSignals(process);
      mockGeneration(process, async () => {
        return terminalTestResponse([
          { type: "text", text: "Useful private result." },
          yieldAction("ipc-yield"),
        ]);
      }, async () => {
        return "unused";
      });
      process.store.messages.appendMessage("user", "Return privately.", { runId });
      process.runs.active = generationRun(runId, terminalTestConfig(pid), {
        returnToCaller: true
      });

      await process.run.runTick(runId);

      expect(
        emitted.findLast((entry) => entry.signal === "proc.run.finished")?.payload,
      ).toMatchObject({
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

    const calls = await runInProcess(stub, async (process) => {
      process.runs.active = { runId };
      process.streams.emitProjection = vi.fn(async () => {});
      await process.streams.complete(runId, "message-1", "Hello");
      await process.streams.complete(runId, "message-1", "Goodbye");
      return process.streams.emitProjection.mock.calls;
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

    const result = await runInProcess(stub, async (process, _state, instance) => {
      const emitted = captureSignals(process);

      const request = makeScheduleDeliverReq({
        scheduleId: "sched-1",
        scheduleName: "nightly",
        message: "run the nightly check",
        scheduledAtMs: 1_000,
        firedAtMs: 2_000,
      });
      const response = await instance.recvFrame(request);
      expect(response).toMatchObject({ type: "res", id: request.id, ok: true });

      const messages = process.store.messages.getMessages();
      const contextMessages = await process.history.buildContextMessages("default");
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
    expect(result.contextMessages[0].content).toContain("[Directed endpoint: this GSV process.]");
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
    const activeState = await runInProcess(stub, (process) => {
      return {
        messages: process.store.messages.getMessages(),
        queueSize: process.store.queue.queueSize(),
        currentRunId: process.runs.active?.runId ?? null,
      };
    });

    await runInProcess(stub, (process) => {
      process.runs.active = null;
    });
    const recordedRepeatRequest = makeScheduleDeliverReq(args);
    const recordedRepeat = await stub.recvFrame(recordedRepeatRequest);
    const recordedState = await runInProcess(stub, (process) => {
      return {
        messages: process.store.messages.getMessages(),
        queueSize: process.store.queue.queueSize(),
        currentRunId: process.runs.active?.runId ?? null,
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

    await runInProcess(stub, (process) => {
      process.runs.active = {
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
    await runInProcess(stub, (process) => {
      expect(process.runs.active).toMatchObject({ runId: "run-busy" });
      expect(process.store.messages.getMessages()).toEqual([]);
      expect(process.store.queue.queueSize()).toBe(1);
      expect(drainProcessQueue(process.store)).toEqual([
        expect.objectContaining({
          runId: args.runId,
          role: "system",
          kind: "schedule.event",
          message: expect.stringContaining(args.message),
        }),
      ]);
    });
  });

  it("rejects a scheduled runtime event after teardown commits", async () => {
    const stub = await initProcess("mech-schedule-teardown-race", ROOT_IDENTITY);

    const result = await runInProcess(stub, async (process, _state, instance) => {
      const request = makeScheduleDeliverReq({
        scheduleId: "sched-teardown-race",
        message: "do not run",
      });
      process.store.state.deleteValue("identity");
      const response = await instance.recvFrame(request);
      return {
        requestId: request.id,
        response,
        messages: process.store.messages.getMessages(),
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

    await runInProcess(stub, async (process, _state, instance) => {
      process.sendSignal = vi.fn(async () => {});
      process.run.scheduleTick = vi.fn(async () => {});
      process.runs.active = { runId: "run-busy" };

      await instance.recvFrame(
        makeScheduleDeliverReq({
          scheduleId: "sched-busy",
          message: "check now",
        }),
      );
      expect(process.runs.active).toMatchObject({
        runId: "run-busy",
        pendingRuntimeEvents: 1,
      });
      const contextMessages = await process.history.buildContextMessages("default");
      expect(contextMessages).toHaveLength(1);
      expect(contextMessages[0].content).toContain("[From: schedule sched-busy]");
      expect(contextMessages[0].content).not.toContain("[Directed endpoint:");

      await process.run.finishRun("run-busy", { status: "ok", resultText: "done" });
      expect(process.runs.active).not.toBeNull();
      expect(process.runs.active.runId).not.toBe("run-busy");
    });
  });

  it("keeps a scheduled adapter reply as a distinct queued run with chronological delivery context", async () => {
    const stub = await initProcess("mech-schedule-adapter-reply", ROOT_IDENTITY);

    await runInProcess(stub, async (process, _state, instance) => {
      process.sendSignal = vi.fn(async () => {});
      process.run.scheduleTick = vi.fn(async () => {});
      process.runs.active = { runId: "run-busy" };
      mockGeneration(process, async (request: any) => {
        expect(request.context.systemPrompt).toBe("Test system prompt.");
        const input = JSON.stringify(request.context.messages);
        expect(input).toContain("[From: schedule sched-adapter-reply]");
        expect(input).toContain("[Directed endpoint: this Telegram direct message.]");
        expect(input).not.toContain("message send");
        expect(input).not.toContain("--also");
        expect(input).not.toContain("telegram-user-1");
        expect(input).not.toContain("telegram-chat-1");
        return assistantResponse([{ type: "text", text: "scheduled reply" }]);
      }, async () => {
        return "scheduled reply";
      });

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
      expect(process.runs.active).toMatchObject({ runId: "run-busy" });
      expect(process.store.queue.queueSize()).toBe(1);

      process.runs.active = null;
      expect(process.controller.claimNextQueuedRun()).toMatchObject({
        runId: "run-scheduled-reply",
      });
      expect(process.runs.active).toMatchObject({ runId: "run-scheduled-reply" });
      process.runs.active = {
        ...process.runs.active,
        config: {
          executor: { kind: "process", pid: process.pid },
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
      await process.run.runTick("run-scheduled-reply");
    });
  });

  it("terminalizes a scheduled runtime event when its first tick cannot be scheduled", async () => {
    const stub = await initProcess("mech-schedule-failure", ROOT_IDENTITY);

    await runInProcess(stub, async (process, _state, instance) => {
      process.sendSignal = vi.fn(async () => {});
      process.run.scheduleTick = vi.fn(async () => {
        throw new Error("scheduler unavailable");
      });

      await instance.recvFrame(
        makeScheduleDeliverReq({
          scheduleId: "sched-failure",
          message: "check now",
        }),
      );
      await vi.waitFor(() => {
        expect(process.runs.active).toBeNull();
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

    const emitted = await runInProcess(stub, async (process) => {
      const emitted = captureSignals(process);
      mockGeneration(process, async () => {
        return assistantResponse([{ type: "text", text: "done" }], {
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
          }
        });
      }, async () => {
        return "done";
      });

      process.store.messages.appendMessage("user", "measure context");
      process.runs.active = generationRun("run-context-pressure", processTestConfig(pid, {
        provider: "workers-ai",
        model: "@cf/nvidia/nemotron-3-120b-a12b",
        contextWindowTokens: 256000
      }));
      await process.run.runTick("run-context-pressure");
      return emitted;
    });

    const history = await okProcessResponse(stub, makeReq("proc.history", {}));
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
      .filter(
        (entry) =>
          entry.signal === "proc.changed" &&
          Array.isArray((entry.payload as { changes?: unknown[] }).changes) &&
          ((entry.payload as { changes?: unknown[] }).changes ?? []).includes("context"),
      );
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

    const result = await runInProcess(stub, async (process) => {
      const emitted = captureSignals(process);
      const generationContexts: string[] = [];
      const inputBudgetTokens = 1_000_000;
      let remainingInputTokens = 164_001;
      let revision = 0;
      process.history.updateContextState = vi.fn(async (runId: string) => {
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
      mockGeneration(process, async (request: any) => {
        generationContexts.push(JSON.stringify(request.context));
        return terminalTestResponse([{ type: "text", text: "done" }, messageAction("done")]);
      }, async () => {
        return "done";
      });

      const run = async (runId: string, message: string) => {
        process.store.messages.appendMessage("user", message, { runId });
        process.runs.active = generationRun(runId, {
          ...terminalTestConfig(pid),
          contextWindowTokens: 1008192,
        });
        await process.run.runTick(runId);
      };

      await run("run-before-runway-alert", "not quite yet");
      remainingInputTokens = 164_000;
      await run("run-at-runway-alert", "cross the threshold");
      remainingInputTokens = 150_000;
      await run("run-after-runway-alert", "keep going");
      const runwayEventsBeforeCompaction = emitted.filter((entry) => {
        // SAFETY: emitted Process test payloads use the asserted optional lifecycle-event shape.
        return (
          entry.signal === "proc.changed" &&
          (entry.payload as { event?: string }).event === "context.runway"
        );
      }).length;

      await expect(
        process.history.handleHistoryCompact({
          keepLast: 1,
          summary: "Checkpoint summary.",
        }),
      ).resolves.toMatchObject({ ok: true });
      remainingInputTokens = 164_000;
      await run("run-rearmed-runway-alert", "new context epoch");

      return {
        emitted,
        generationContexts,
        messages: process.store.messages.getMessages(),
        segments: process.store.history.listHistorySegments(),
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
    expect(result.generationContexts[2].match(/Context runway is getting low\./gu)).toHaveLength(
      1,
    );
    expect(result.generationContexts[3].match(/Context runway is getting low\./gu)).toHaveLength(
      1,
    );
    expect(
      result.messages.filter(
        (message: any) =>
          message.role === "system" && message.content.includes("Context runway is getting low."),
      ),
    ).toHaveLength(1);
    expect(result.segments).toHaveLength(1);
    expect(result.runwayEventsBeforeCompaction).toBe(1);

    const runwayEvents = result.emitted.filter((entry) => {
      // SAFETY: emitted Process test payloads use the asserted optional lifecycle-event shape.
      return (
        entry.signal === "proc.changed" &&
        (entry.payload as { event?: string }).event === "context.runway"
      );
    });
    expect(runwayEvents).toHaveLength(2);
    expect(
      new Set(
        runwayEvents.map(
          (entry) =>
            // SAFETY: context.runway lifecycle payloads always carry their context epoch id.
            (entry.payload as { epochId: string }).epochId,
        ),
      ).size,
    ).toBe(2);
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

    const result = await runInProcess(stub, async (process) => {
      const generationContexts: string[] = [];
      const inputBudgetTokens = 1_000_000;
      let revision = 0;
      process.sendSignal = async () => {};
      setHistoryPolicy(process, { overflow: "fail" });
      process.history.updateContextState = vi.fn(
        async (runId: string, _config: AiConfigResult, context: Context) => {
          const includesRunwayAlert = JSON.stringify(context).includes(
            "Context runway is getting low.",
          );
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
        },
      );
      mockGeneration(process, async (request: any) => {
        generationContexts.push(JSON.stringify(request.context));
        return terminalTestResponse([{ type: "text", text: "done" }, messageAction("done")]);
      }, async () => {
        return "done";
      });

      process.store.messages.appendMessage("user", "Preserve the warning for this turn.", {
        runId: "run-context-runway-alert-headroom",
      });
      process.runs.active = generationRun("run-context-runway-alert-headroom", {
        ...terminalTestConfig(pid),
        contextWindowTokens: 1008192,
      });
      await process.run.runTick("run-context-runway-alert-headroom");

      return {
        generationContexts,
        messages: process.store.messages.getMessages(),
      };
    });

    expect(result.generationContexts).toHaveLength(1);
    expect(result.generationContexts[0]).toContain("Context runway is getting low.");
    expect(
      result.messages.some(
        (message: any) =>
          message.role === "system" &&
          message.content.includes("Context limit policy stopped this run."),
      ),
    ).toBe(false);
  });

  it("includes interaction origin in model context without rewriting stored content", async () => {
    const pid = "mech-origin-context";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    await runInProcess(stub, async (process) => {
      process.sendSignal = async () => {};
      mockGeneration(process, async (request: any) => {
        expect(request.context.systemPrompt).toBe("Test system prompt.");
        const first = request.context.messages[0];
        const second = request.context.messages[1];
        const third = request.context.messages[2];
        const fourth = request.context.messages[3];
        expect(first.role).toBe("user");
        expect(first.content).toContain("[From: Telegram direct message]");
        expect(first.content).toContain("[Directed endpoint: this Telegram direct message.]");
        expect(first.content).not.toContain("Steve James");
        expect(first.content).toContain("hello from telegram");
        expect(second.role).toBe("user");
        expect(second.content).toContain("[From: WhatsApp group GSV Dev from @sam]");
        expect(second.content).toContain("[Directed endpoint: this WhatsApp group.]");
        expect(second.content).toContain("check this from the group");
        expect(third.role).toBe("user");
        expect(third.content).toBe("same source follow-up");
        expect(fourth.role).toBe("user");
        expect(fourth.content).toContain("[From: GSV Web Desktop]");
        expect(fourth.content).toContain("[Directed endpoint: this GSV client.]");
        expect(fourth.content).toContain("now from chat");
        return assistantResponse([{ type: "text", text: "noted" }, messageAction("noted", "origin-message")]);
      }, async () => {
        return "noted";
      });

      process.store.messages.appendMessage("user", "hello from telegram", {
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
      process.store.messages.appendMessage("user", "check this from the group", {
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
      process.store.messages.appendMessage("user", "same source follow-up", {
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
      process.store.messages.appendMessage("user", "now from chat", {
        runId: "run-web",
        origin: JSON.stringify({
          kind: "client",
          connectionId: "conn-1",
          clientId: "gsv-ui",
          platform: "browser",
        }),
      });
      process.runs.active = generationRun("run-origin-context", processTestConfig(pid, {
        provider: "workers-ai",
        model: "@cf/nvidia/nemotron-3-120b-a12b",
        contextWindowTokens: 256000
      }));
      await process.run.runTick("run-origin-context");

      const messages = process.store.messages.getMessages();
      expect(
        messages
          .filter((message: any) => message.role !== "toolResult")
          .map((message: any) => message.content),
      ).toEqual([
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

    await runInProcess(stub, async (process) => {
      process.store.messages.appendMessage("user", "start in the web client", {
        runId: "run-client",
        origin: JSON.stringify({
          kind: "client",
          connectionId: "conn-1",
          clientId: "gsv-ui",
          platform: "browser",
        }),
      });
      const clientContext = await process.history.buildContextMessages("default");
      expect(clientContext[0].content).toContain("[Directed endpoint: this GSV client.]");

      process.store.messages.appendMessage("assistant", "client response", {
        runId: "run-client",
      });
      process.store.messages.appendMessage("user", "continue from my phone", {
        runId: "run-device",
        origin: JSON.stringify({ kind: "device", deviceId: "phone" }),
      });
      const deviceContext = await process.history.buildContextMessages("default");
      expect(deviceContext.slice(0, clientContext.length)).toEqual(clientContext);
      expect(deviceContext[2].content).toContain("[Directed endpoint: this GSV device client.]");

      process.store.messages.appendMessage("assistant", "device response", {
        runId: "run-device",
      });
      process.store.messages.appendMessage("user", "delegated request", {
        runId: "run-process",
        origin: JSON.stringify({ kind: "process", sourcePid: "child" }),
      });
      const processContext = await process.history.buildContextMessages("default");
      expect(processContext.slice(0, deviceContext.length)).toEqual(deviceContext);
      expect(processContext[4].content).toContain(
        "[Directed endpoint: the calling GSV process.]",
      );

      process.store.messages.appendMessage("assistant", "process response", {
        runId: "run-process",
      });
      process.store.messages.appendMessage("user", "route-less work", { runId: "run-local" });
      const localContext = await process.history.buildContextMessages("default");
      expect(localContext.slice(0, processContext.length)).toEqual(processContext);
      expect(localContext[6].content).toContain("[Directed endpoint: this GSV process.]");
    });
  });

  it("does not let a same-run system record change the reply destination", async () => {
    const stub = await initProcess("mech-reply-context-same-run", ROOT_IDENTITY);

    await runInProcess(stub, async (process) => {
      process.store.messages.appendMessage("user", "hello from telegram", {
        runId: "run-adapter",
        origin: JSON.stringify({
          kind: "adapter",
          adapter: "telegram",
          accountId: "primary",
          surface: { kind: "dm", id: "telegram-chat-1" },
          actorId: "telegram-user-1",
        }),
      });
      process.store.messages.appendMessage("system", "Temporary provider error.", {
        runId: "run-adapter",
      });

      const context = await process.history.buildContextMessages("default");
      expect(context[0].content).toContain("[Directed endpoint: this Telegram direct message.]");
      expect(context[1].content).toContain("[GSV EVENT]");
      expect(context[1].content).not.toContain("[Directed endpoint:");
    });
  });

  it("includes assistant thinking blocks in live proc.run.output signals", async () => {
    const pid = "mech-chat-text-thinking";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    const emitted = await runInProcess(stub, async (process) => {
      const emitted = captureSignals(process);
      mockGeneration(process, async () => {
        return assistantResponse([
          { type: "thinking", thinking: "Need to preserve this reasoning." },
          { type: "text", text: "done" },
        ]);
      }, async () => {
        return "done";
      });

      process.store.messages.appendMessage("user", "include reasoning");
      process.runs.active = generationRun("run-chat-text-thinking", processTestConfig(pid, {
        provider: "workers-ai",
        model: "@cf/nvidia/nemotron-3-120b-a12b",
        reasoning: "high",
        contextWindowTokens: 256000
      }));
      await process.run.runTick("run-chat-text-thinking");
      return emitted;
    });

    // SAFETY: test fixture is constructed with the asserted domain shape.
    const textSignal = (emitted as Array<{ signal: string; payload: any }>).find(
      (entry) => entry.signal === "proc.run.output",
    );
    expect(textSignal?.payload).toMatchObject({
      text: "done",
      pid,
      runId: "run-chat-text-thinking",
      thinking: [{ type: "thinking", thinking: "Need to preserve this reasoning." }],
    });
  });
});
