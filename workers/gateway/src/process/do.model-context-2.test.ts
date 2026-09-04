import { Kernel } from "../kernel/do";
import type { ProcessRuntimeEventDeliverArgs } from "../protocol/process-frames";
import { getKernelPtr } from "../shared/utils";
import type { ProcAbortResult } from "@humansandmachines/gsv/protocol";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  captureSignals, mockGeneration, processTestConfig, generationRun, assistantResponse, deferred,
  runInProcess, ROOT_IDENTITY, initProcess, makeRuntimeEventDeliverReq, messageAction,
  messageUpdateAction, offeredTools, terminalTestConfig, terminalTestResponse, testUsage,
  yieldAction,
} from "./do-test-harness";

describe("model context", () => {
  it("continues on the next turn when a responsibility arrives during yield verification", async () => {
    const pid = "mech-r12y-yield-verification-race";
    const runId = "run-r12y-yield-verification-race";
    const firstId = "r12y:00000000-0000-4000-8000-000000000041";
    const secondId = "r12y:00000000-0000-4000-8000-000000000042";
    const stub = await initProcess(pid, ROOT_IDENTITY);
    const secondBatch: ProcessRuntimeEventDeliverArgs = {
      eventId: "r12y.ready:batch:00000000-0000-4000-8000-000000000043",
      event: {
        type: "r12y.ready",
        batchId: "batch:00000000-0000-4000-8000-000000000043",
        ledgerRevision: 2,
        responsibilityIds: [secondId],
      },
    };

    await runInProcess(stub, async (process, _state, instance) => {
      const { promise: firstReadBlocked, resolve: releaseFirstRead } = deferred();
      const { promise: firstReadStarted, resolve: markFirstReadStarted } = deferred();
      const responsibility = {
        id: firstId,
        ownerUid: ROOT_IDENTITY.uid,
        title: `Responsibility ${firstId}`,
        source: { kind: "system", component: "test" },
        assignee: { kind: "ship" },
        state: "resolved",
        priority: "normal",
        revision: 1,
        createdAtMs: 100,
        updatedAtMs: 100,
      };
      let reads = 0;
      process.kernel.kernelRpc = vi.fn(async (call: string, args: { ids?: string[] }) => {
        expect(call).toBe("r12y.list");
        reads += 1;
        expect(args.ids).toEqual([firstId]);
        markFirstReadStarted();
        await firstReadBlocked;
        return {
          responsibilities: [responsibility],
          count: 1,
          revision: 1,
        };
      });
      process.streams.emitProjection = vi.fn(async () => {});
      process.run.scheduleTick = vi.fn(async () => {});
      process.runs.active = {
        runId,
        responsibilityBatches: [
          {
            batchId: "batch:00000000-0000-4000-8000-000000000044",
            responsibilityIds: [firstId],
          },
        ],
      };

      const yielding = process.run.executeRunControlAction(
        runId,
        "yield-verification-race",
        { ok: true, command: { action: "yield" } },
        [],
      );
      await firstReadStarted;
      await instance.recvFrame(makeRuntimeEventDeliverReq(secondBatch));
      releaseFirstRead();

      const result = await yielding;
      expect(result).toMatchObject({
        ok: true,
        action: "yield",
        finish: true,
      });
      expect(reads).toBe(1);

      await process.run.finishRun(
        runId,
        { reason: "run.yielded", status: "ok", resultText: null },
        result.responsibilityAdmissionKey,
      );

      expect(process.run.scheduleTick).toHaveBeenCalledWith(runId);
      expect(process.runs.active).toMatchObject({
        runId,
        responsibilityBatches: expect.arrayContaining([
          expect.objectContaining({ responsibilityIds: [secondId] }),
        ]),
      });
    });
  });

  it("continues when a responsibility revision arrives after yield verification", async () => {
    const pid = "mech-r12y-yield-finalization-race";
    const runId = "run-r12y-yield-finalization-race";
    const responsibilityId = "r12y:00000000-0000-4000-8000-000000000051";
    const batchId = "batch:00000000-0000-4000-8000-000000000052";
    const stub = await initProcess(pid, ROOT_IDENTITY);
    const revisedBatch: ProcessRuntimeEventDeliverArgs = {
      eventId: "r12y.ready:batch:00000000-0000-4000-8000-000000000053",
      event: {
        type: "r12y.ready",
        batchId,
        ledgerRevision: 2,
        responsibilityIds: [responsibilityId],
      },
    };

    await runInProcess(stub, async (process, _state, instance) => {
      const { promise: streamCleanupBlocked, resolve: releaseStreamCleanup } = deferred();
      const { promise: streamCleanupStarted, resolve: markStreamCleanupStarted } = deferred();
      process.kernel.kernelRpc = vi.fn(async () => ({
        responsibilities: [
          {
            id: responsibilityId,
            ownerUid: ROOT_IDENTITY.uid,
            title: "Already handled responsibility",
            source: { kind: "system", component: "test" },
            assignee: { kind: "ship" },
            state: "resolved",
            priority: "normal",
            revision: 1,
            createdAtMs: 100,
            updatedAtMs: 100,
          },
        ],
        count: 1,
        revision: 1,
      }));
      process.streams.emitProjection = vi.fn(async () => {
        markStreamCleanupStarted();
        await streamCleanupBlocked;
      });
      process.run.scheduleTick = vi.fn(async () => {});
      process.runs.active = {
        runId,
        responsibilityBatches: [
          {
            batchId,
            ledgerRevision: 1,
            responsibilityIds: [responsibilityId],
          },
        ],
      };

      const yielding = process.run.executeRunControlAction(
        runId,
        "yield-finalization-race",
        { ok: true, command: { action: "yield" } },
        [],
      );
      await streamCleanupStarted;
      await instance.recvFrame(makeRuntimeEventDeliverReq(revisedBatch));
      releaseStreamCleanup();
      const result = await yielding;

      expect(result).toMatchObject({
        ok: true,
        finish: true,
        responsibilityAdmissionKey: expect.any(String),
      });
      await process.run.finishRun(
        runId,
        { reason: "run.yielded", status: "ok", resultText: null },
        result.responsibilityAdmissionKey,
      );

      expect(process.run.scheduleTick).toHaveBeenCalledOnce();
      expect(process.run.scheduleTick).toHaveBeenCalledWith(runId);
      expect(process.runs.active).toMatchObject({
        runId,
        responsibilityBatches: [
          {
            batchId,
            ledgerRevision: 2,
            responsibilityIds: [responsibilityId],
          },
        ],
      });
      process.runs.active = null;
    });
  });

  it("records an unknown-only tool response as a terminal failure and continues", async () => {
    const pid = "mech-unoffered-unknown-only";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    await runInProcess(stub, async (process) => {
      const emitted = captureSignals(process);
      let generationCalls = 0;
      process.run.scheduleTick = vi.fn(async () => {});
      process.kernel.dispatchSyscall = vi.fn(async () => {});
      process.tools.executeCodeModeTool = vi.fn(async () => {});
      process.generation = {
        async generate() {
          generationCalls += 1;
          return generationCalls === 1
            ? assistantResponse([
                {
                    type: "toolCall",
                    id: "forged-unknown",
                    name: "RootAccess",
                    arguments: { command: "read secrets" },
                },
            ], {
                usage: testUsage(),
                stopReason: "toolUse"
            })
            : assistantResponse([
                { type: "text", text: "Recovered from the invalid tool call." },
                messageAction("Recovered from the invalid tool call.", "recovery-message"),
            ], {
                usage: testUsage()
            });
        },
        async generateText() {
          return "unused";
        },
      };
      process.store.messages.appendMessage("user", "Answer without tools.", {
        runId: "run-unoffered-unknown-only",
      });
      process.runs.active = generationRun("run-unoffered-unknown-only", processTestConfig(pid, {
        generationStreaming: "off"
      }), {
        mcpServers: []
      });

      await process.run.runTick("run-unoffered-unknown-only");
      await process.run.runTick("run-unoffered-unknown-only");

      const messages = process.store.messages.getMessages();
      expect(messages.find((message: any) => message.role === "assistant")?.toolCalls).toContain(
        "RootAccess",
      );
      expect(messages.find((message: any) => message.role === "toolResult")).toMatchObject({
        content: 'Tool "RootAccess" was not offered for this generation',
        toolCallId: "forged-unknown",
      });
      expect(process.store.tools.getResults("run-unoffered-unknown-only")).toEqual([]);
      expect(process.kernel.dispatchSyscall).not.toHaveBeenCalled();
      expect(process.tools.executeCodeModeTool).not.toHaveBeenCalled();
      expect(emitted.some((entry) => entry.signal === "proc.run.hil.requested")).toBe(false);
      expect(
        emitted.findLast((entry) => entry.signal === "proc.run.finished")?.payload,
      ).toMatchObject({
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

    await runInProcess(stub, async (process) => {
      const emitted = captureSignals(process);
      let generationCalls = 0;
      process.run.schedule = vi.fn(async () => {});
      process.run.scheduleTick = vi.fn(async () => {});
      process.tools.executeCodeModeTool = vi.fn(async () => {});
      process.kernel.dispatchSyscall = vi.fn(async (_runId: string, dispatchId: string) => {
        process.store.tools.resolve(dispatchId, "read completed");
      });
      process.generation = {
        async generate(request: any) {
          generationCalls += 1;
          expect(request.context.tools.map((tool: any) => tool.name)).toEqual(["Read", "Shell"]);
          return generationCalls === 1
            ? assistantResponse([
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
            ], {
                usage: testUsage(),
                stopReason: "toolUse"
            })
            : assistantResponse([
                { type: "text", text: "Recovered from the rejected call." },
                messageAction("Recovered from the rejected call.", "mixed-message"),
            ], {
                usage: testUsage()
            });
        },
        async generateText() {
          return "unused";
        },
      };
      process.store.messages.appendMessage("user", "Read the allowed file.", { runId });
      process.runs.active = generationRun(runId, processTestConfig(pid, {
        generationStreaming: "off"
      }), {
        tools: offeredTools("Read"),
        mcpServers: [],
        systemPrompt: "Test system prompt."
      });

      await process.run.runTick(runId);
      await vi.waitFor(() => {
        expect(process.kernel.dispatchSyscall).toHaveBeenCalledOnce();
      });
      await process.run.runTick(runId);

      expect(process.kernel.dispatchSyscall).toHaveBeenCalledWith(
        runId,
        expect.any(String),
        "fs.read",
        { path: "/root/allowed.txt" },
      );
      expect(process.tools.executeCodeModeTool).not.toHaveBeenCalled();
      expect(process.store.tools.getResults(runId)).toEqual([]);
      expect(
        process.store.messages
          .getMessages()
          .filter((message: any) => message.role === "toolResult")
          .map((message: any) => [message.toolCallId, message.content]),
      ).toEqual([
        ["forged-shell-mixed", 'Tool "Shell" was not offered for this generation'],
        ["offered-read", "read completed"],
        ["mixed-message", "Message committed and run yielded"],
      ]);
      expect(emitted.some((entry) => entry.signal === "proc.run.hil.requested")).toBe(false);
      expect(
        emitted.findLast((entry) => entry.signal === "proc.run.finished")?.payload,
      ).toMatchObject({
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

    await runInProcess(stub, async (process) => {
      process.sendSignal = vi.fn(async () => {});
      process.run.scheduleTick = vi.fn(async () => {});
      process.kernel.dispatchSyscall = vi.fn(async () => {});
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
      process.store.messages.appendMessage("user", "Read before answering.", { runId });
      process.runs.active = generationRun(runId, terminalTestConfig(pid), {
        tools: offeredTools("Read"),
        systemPrompt: "Test system prompt."
      });

      await process.run.runTick(runId);

      expect(process.kernel.dispatchSyscall).not.toHaveBeenCalled();
      expect(process.store.tools.getResults(runId)).toEqual([]);
      expect(
        process.store.messages
          .getMessages()
          .filter((message: any) => message.role === "toolResult")
          .map((message: any) => [message.toolCallId, message.content]),
      ).toEqual([
        [
          "combined-read",
          "message send and yield must be issued separately from other tool actions",
        ],
        [
          "combined-message",
          "message send and yield must be issued separately from other tool actions",
        ],
      ]);
      expect(process.run.scheduleTick).toHaveBeenCalledOnce();
    });
  });

  it("continues after sending an update and finishes only when yielded", async () => {
    const pid = "mech-message-then-yield";
    const runId = "run-message-then-yield";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    await runInProcess(stub, async (process) => {
      const emitted = captureSignals(process);
      let generationCalls = 0;
      process.run.scheduleTick = vi.fn(async () => {});
      mockGeneration(process, async () => {
        generationCalls += 1;
        return terminalTestResponse(generationCalls === 1
          ? [messageUpdateAction("I found the issue and I am fixing it.", "progress-send")]
          : [messageAction("Fixed.", "final-send")]);
      }, async () => {
        return "unused";
      });
      process.store.messages.appendMessage("user", "Fix it and keep me posted.", { runId });
      process.runs.active = generationRun(runId, terminalTestConfig(pid));

      await process.run.runTick(runId);

      expect(process.runs.active).toMatchObject({ runId });
      expect(process.run.scheduleTick).toHaveBeenCalledOnce();
      expect(emitted.some((entry) => entry.signal === "proc.run.finished")).toBe(false);
      expect(
        process.store.messages
          .getMessages()
          .find((message: any) => message.toolCallId === "progress-send"),
      ).toMatchObject({ content: "Message committed; run remains active" });

      await process.run.runTick(runId);

      expect(process.runs.active).toBeNull();
      expect(
        process.store.messages
          .getMessages()
          .find((message: any) => message.toolCallId === "final-send"),
      ).toMatchObject({ content: "Message committed and run yielded" });
      expect(
        emitted.findLast((entry) => entry.signal === "proc.run.finished")?.payload,
      ).toMatchObject({
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
    const { promise: commitBlocked, resolve: releaseCommit } = deferred();
    const { promise: commitStarted, resolve: markCommitStarted } = deferred();

    await runInDurableObject(kernel, (instance: Kernel) => {
      // SAFETY: test fixture delays the internal canonical commit boundary.
      const k = instance as any;
      originalCommitProcessMessage = k.processOutput.commitProcessMessage;
      k.processOutput.commitProcessMessage = vi.fn(async (processId: string, args: any) => {
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
      await runInProcess(stub, async (process) => {
        process.runs.active = { runId };
        process.streams.complete = vi.fn(async () => {});
        const committing = process.run.executeRunControlAction(
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
        const aborting = process.controller
          .handleProcAbort({ runId })
          .then((result: ProcAbortResult) => {
            abortFinished = true;
            return result;
          });
        await new Promise((resolve) => setTimeout(resolve, 10));

        expect(abortFinished).toBe(false);
        expect(process.runs.active).toMatchObject({ runId });

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
        expect(process.runs.active).toBeNull();
      });
    } finally {
      await runInDurableObject(kernel, (instance: Kernel) => {
        // SAFETY: restore the test-only internal Kernel override.
        (instance as any).processOutput.commitProcessMessage = originalCommitProcessMessage;
      });
    }
  });

  it("requires an explicit yield and bounds the correction", async () => {
    const pid = "mech-terminal-action-required";
    const runId = "run-terminal-action-required";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    const result = await runInProcess(stub, async (process) => {
      const emitted = captureSignals(process);
      process.run.scheduleTick = vi.fn(async () => {});
      mockGeneration(process, async () => {
        return terminalTestResponse([{ type: "text", text: "This is only a draft." }]);
      }, async () => {
        return "unused";
      });
      process.store.messages.appendMessage("user", "Answer me.", { runId });
      process.runs.active = generationRun(runId, terminalTestConfig(pid));

      await process.run.runTick(runId);
      expect(process.run.scheduleTick).toHaveBeenCalledOnce();
      const correction = process.store.messages
        .getMessages()
        .find((message: any) => message.role === "system" && message.runId === runId);
      expect(correction?.content).toContain("Run `yield` now");
      expect(
        (await process.history.buildContextMessages("default")).find((message: any) =>
          message.content.includes("Run `yield` now"),
        )?.content,
      ).toContain("[GSV EVENT]");

      await process.run.runTick(runId);
      return { emitted, messages: process.store.messages.getMessages() };
    });

    expect(result.messages.filter((message: any) => message.role === "assistant")).toHaveLength(
      2,
    );
    expect(
      result.emitted.findLast((entry) => entry.signal === "proc.run.finished")?.payload,
    ).toMatchObject({
      status: "error",
      reason: "message.action.missing",
      error: "The model did not yield after correction",
    });
  });

  it("does not resurrect a superseded run after yield correction awaits", async () => {
    const pid = "mech-yield-correction-superseded";
    const runId = "run-yield-correction-superseded";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    await runInProcess(stub, async (process) => {
      const { promise: streamCleanupBlocked, resolve: releaseStreamCleanup } = deferred();
      const { promise: streamCleanupStarted, resolve: markStreamCleanupStarted } = deferred();
      process.streams.abortRun = vi.fn(async () => {
        markStreamCleanupStarted();
        await streamCleanupBlocked;
      });
      process.run.scheduleTick = vi.fn(async () => {});
      process.sendSignal = vi.fn(async () => {});
      mockGeneration(process, async () => {
        return terminalTestResponse([
          {
            type: "text",
            text: "Draft that must not revive its run.",
          },
        ]);
      }, async () => {
        return "unused";
      });
      process.store.messages.appendMessage("user", "Start the old run.", { runId });
      process.runs.active = generationRun(runId, terminalTestConfig(pid), {
        mcpServers: []
      });

      const ticking = process.run.runTick(runId);
      await streamCleanupStarted;
      const takeover = await process.controller.handleProcSend({
        message: "Replace the old run.",
        origin: { kind: "client", connectionId: "client-1" },
      });
      expect(process.runs.active).toMatchObject({ runId: takeover.runId });

      releaseStreamCleanup();
      await ticking;

      expect(process.runs.active).toMatchObject({ runId: takeover.runId });
      expect(
        process.store.messages
          .getMessages()
          .some(
            (message: any) =>
              message.runId === runId &&
              message.role === "system" &&
              message.content.includes("This run is not complete"),
          ),
      ).toBe(false);
      process.runs.active = null;
    });
  });

  it("keeps a superseded run-control assistant turn provider-valid", async () => {
    const pid = "mech-run-control-superseded";
    const runId = "run-run-control-superseded";
    const actionId = "superseded-yield-action";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    await runInProcess(stub, async (process) => {
      const { promise: actionBlocked, resolve: releaseAction } = deferred();
      const { promise: actionStarted, resolve: markActionStarted } = deferred();
      process.sendSignal = vi.fn(async () => {});
      process.run.scheduleTick = vi.fn(async () => {});
      process.run.executeRunControlAction = vi.fn(async () => {
        markActionStarted();
        await actionBlocked;
        return {
          ok: true,
          action: "yield",
          finish: true,
          text: "",
          delivery: { kind: "none" },
        };
      });
      mockGeneration(process, async () => {
        return terminalTestResponse([yieldAction(actionId)]);
      }, async () => {
        return "unused";
      });
      process.store.messages.appendMessage("user", "Begin the superseded run.", { runId });
      process.runs.active = generationRun(runId, terminalTestConfig(pid), {
        mcpServers: []
      });

      const ticking = process.run.runTick(runId);
      await actionStarted;
      const takeover = await process.controller.handleProcSend({
        message: "Replace the run while it is yielding.",
        origin: { kind: "client", connectionId: "client-1" },
      });
      releaseAction();
      await ticking;

      expect(process.runs.active).toMatchObject({ runId: takeover.runId });
      const cancellation = process.store.messages
        .getMessages()
        .find((message: any) => message.role === "toolResult" && message.toolCallId === actionId);
      expect(cancellation).toMatchObject({
        content: expect.stringContaining("newer user message arrived"),
      });
      expect(cancellation?.toolCalls).toContain('"isError":true');
      expect(process.store.tools.getResults(runId)).toEqual([]);
      process.runs.active = null;
    });
  });

  it("recovers an interrupted run-control registration without redispatching it", async () => {
    const pid = "mech-run-control-recovery";
    const runId = "run-control-recovery";
    const actionId = "interrupted-yield-action";
    const dispatchId = "interrupted-yield-dispatch";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    await runInProcess(stub, async (process) => {
      process.signals.changed = vi.fn(async () => {});
      process.kernel.dispatchSyscall = vi.fn(async () => {});
      process.runs.active = { runId };
      process.store.messages.appendMessage("assistant", "", {
        runId,
        toolCalls: JSON.stringify({
          toolCalls: [yieldAction(actionId)],
        }),
      });
      process.store.tools.register(dispatchId, actionId, runId, "Shell", { input: "yield" });

      await expect(process.run.settleRunTickTools(runId)).resolves.toMatchObject({ runId });

      expect(process.kernel.dispatchSyscall).not.toHaveBeenCalled();
      expect(process.store.tools.getResults(runId)).toEqual([]);
      expect(
        process.store.messages
          .getMessages()
          .find(
            (message: any) => message.role === "toolResult" && message.toolCallId === actionId,
          ),
      ).toMatchObject({
        content: expect.stringContaining("external effect may already have completed"),
        toolCalls: expect.stringContaining('"toolName":"Shell"'),
      });
      process.runs.active = null;
    });
  });

  it("gives rejected message commands an independent five-attempt budget", async () => {
    const pid = "mech-terminal-command-recovery";
    const runId = "run-terminal-command-recovery";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    await runInProcess(stub, async (process) => {
      const emitted = captureSignals(process);
      let generationCalls = 0;
      process.run.scheduleTick = vi.fn(async () => {});
      process.generation = {
        async generate() {
          generationCalls += 1;
          return terminalTestResponse([
            {
              type: "toolCall",
              id: `invalid-terminal-${generationCalls}`,
              name: "Shell",
              arguments: {
                input: "message send --to here --message hello",
              },
            },
          ]);
        },
        async generateText() {
          return "unused";
        },
      };
      process.store.messages.appendMessage("user", "Say hello.", { runId });
      process.runs.active = generationRun(runId, terminalTestConfig(pid));

      for (let attempt = 1; attempt < 5; attempt += 1) {
        await process.run.runTick(runId);
        expect(process.runs.active).toMatchObject({
          terminalCommandFailures: attempt,
        });
        expect(process.runs.active.terminalCorrectionRounds).toBeUndefined();
        expect(process.runs.active.terminalDeliveryFailures).toBeUndefined();
      }
      expect(process.run.scheduleTick).toHaveBeenCalledTimes(4);
      expect(
        process.store.messages
          .getMessages()
          .find((message: any) => message.toolCallId === "invalid-terminal-1")?.content,
      ).toContain("Run-control command rejected (attempt 1 of 5)");

      await process.run.runTick(runId);

      expect(
        emitted.findLast((entry) => entry.signal === "proc.run.finished")?.payload,
      ).toMatchObject({
        status: "error",
        reason: "message.command.failed",
        error: expect.stringContaining(
          "message send does not accept --to for the current conversation",
        ),
      });
    });
  });

  it("counts terminal delivery failures separately from command correction", async () => {
    const pid = "mech-terminal-delivery-recovery";
    const runId = "run-terminal-delivery-recovery";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    await runInProcess(stub, async (process) => {
      const emitted = captureSignals(process);
      let generationCalls = 0;
      process.run.scheduleTick = vi.fn(async () => {});
      process.run.executeRunControlAction = vi.fn(async () => ({
        ok: false,
        action: "message",
        text: "hello",
        delivery: { kind: "none" },
        failureKind: "delivery",
        error: "temporary commit failure",
      }));
      mockGeneration(process, async () => {
        generationCalls += 1;
        return terminalTestResponse([
          messageAction("hello", `delivery-terminal-${generationCalls}`),
        ]);
      }, async () => {
        return "unused";
      });
      process.store.messages.appendMessage("user", "Say hello.", { runId });
      process.runs.active = generationRun(runId, terminalTestConfig(pid));

      await process.run.runTick(runId);
      await process.run.runTick(runId);
      expect(process.runs.active).toMatchObject({
        terminalDeliveryFailures: 2,
      });
      expect(process.runs.active.terminalCommandFailures).toBeUndefined();
      expect(process.runs.active.terminalCorrectionRounds).toBeUndefined();
      expect(
        process.store.messages
          .getMessages()
          .find((message: any) => message.toolCallId === "delivery-terminal-1")?.content,
      ).toContain("Message delivery failed (attempt 1 of 3)");

      await process.run.runTick(runId);

      expect(
        emitted.findLast((entry) => entry.signal === "proc.run.finished")?.payload,
      ).toMatchObject({
        status: "error",
        reason: "message.delivery.failed",
        error: "temporary commit failure",
      });
    });
  });

  it("rejects assistant text before finishing silently without a canonical message", async () => {
    const pid = "mech-terminal-silence";
    const runId = "run-terminal-silence";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    const result = await runInProcess(stub, async (process) => {
      const emitted = captureSignals(process);
      let generationCalls = 0;
      process.streams.emitProjection = vi.fn(async () => {});
      process.run.scheduleTick = vi.fn(async () => {});
      process.kernel.dispatchSyscall = vi.fn(async () => {});
      mockGeneration(process, async () => {
        generationCalls += 1;
        return terminalTestResponse(generationCalls === 1
          ? [
              { type: "text", text: "This reply should be delivered." },
              yieldAction("text-yield-action"),
            ]
          : [
              { type: "text", text: "" },
              { type: "thinking", thinking: "No interruption is useful." },
              yieldAction("yield-action"),
            ]);
      }, async () => {
        return "unused";
      });
      process.store.messages.appendMessage("user", "No reply needed.", { runId });
      process.runs.active = generationRun(runId, terminalTestConfig(pid), {
        conversationId: "conv:home",
        systemPrompt: "Test system prompt.",
        approvalPolicy: {
          default: "auto",
          rules: [{ match: "shell.exec", action: "ask" }],
        }
      });

      await process.run.runTick(runId);
      expect(process.runs.active).toMatchObject({
        runId,
        terminalCommandFailures: 1,
      });
      expect(process.run.scheduleTick).toHaveBeenCalledOnce();
      const rejectedYield = process.store.messages
        .getMessages()
        .find((message: any) => message.toolCallId === "text-yield-action");
      expect(rejectedYield).toMatchObject({
        content: expect.stringContaining("yield cannot accompany non-empty assistant text"),
      });
      expect(JSON.parse(rejectedYield.toolCalls)).toMatchObject({ isError: true });
      expect(emitted.some((entry) => entry.signal === "proc.run.finished")).toBe(false);

      await process.run.runTick(runId);
      return {
        emitted,
        streamCalls: process.streams.emitProjection.mock.calls,
        messages: process.store.messages.getMessages(),
        dispatchCalls: process.kernel.dispatchSyscall.mock.calls,
      };
    });

    expect(result.streamCalls).toEqual([
      [runId, expect.objectContaining({ id: `draft:${runId}:yield-action` }), "silenced"],
    ]);
    expect(
      result.messages.find((message: any) => message.toolCallId === "yield-action"),
    ).toMatchObject({ content: "Run yielded" });
    expect(result.dispatchCalls).toEqual([]);
    expect(
      result.emitted.findLast((entry) => entry.signal === "proc.run.finished")?.payload,
    ).toMatchObject({
      status: "ok",
      reason: "run.yielded",
      result: { text: null },
      delivery: { kind: "none" },
    });
  });
});
