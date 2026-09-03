import { Kernel } from "../kernel/do";
import type { ResponseFrame, ResponseOkFrame } from "../protocol/frames";
import { bodyFromText } from "@humansandmachines/gsv/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  generationRun, approvedRun, processTestConfig, assistantResponse, deferred, runInProcess,
  ROOT_IDENTITY, initProcess, makeReq, offeredTools, registerToolBlock, testUsage,
  type ProcessTestValue,
} from "./do-test-harness";

describe("response handling", () => {
  it("fails a dispatched tool when its durable deadline expires", async () => {
    const pid = "mech-res-tool-timeout";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    await runInProcess(stub, async (process) => {
      process.sendSignal = vi.fn(async () => {});
      process.run.scheduleTick = vi.fn(async () => {});
      process.store.tools.register(
        "dispatch-timeout",
        "call-timeout",
        "run-timeout",
        "fs.read",
        { path: "/slow" },
        "default",
      );
      process.store.tools.markDispatched("dispatch-timeout");
      process.runs.active = { runId: "run-timeout" };

      await process.run.onToolDispatchTimeout({
        runId: "run-timeout",
        dispatchId: "dispatch-timeout",
      });

      expect(process.store.tools.getResults("run-timeout")).toMatchObject([
        {
          id: "call-timeout",
          status: "error",
          error: expect.stringContaining("Tool execution timed out"),
        },
      ]);
      expect(process.run.scheduleTick).toHaveBeenCalledWith("run-timeout");
      const finishes = process.sendSignal.mock.calls.filter(
        ([signal]: [string]) => signal === "proc.run.tool.finished",
      );
      expect(finishes).toEqual([
        [
          "proc.run.tool.finished",
          {
            pid,
            runId: "run-timeout",
            executionId: "dispatch-timeout",
            callId: "call-timeout",
            outcome: "failed",
            timestamp: expect.any(Number),
          },
        ],
      ]);
      expect(JSON.stringify(finishes[0][1])).not.toContain("timed out");
      process.store.tools.clearPendingToolCalls();
      process.runs.active = null;
    });
  });

  it("emits one sanitized terminal signal for a started execution", async () => {
    const pid = "mech-res-tool-terminal-signal";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    await runInProcess(stub, async (process) => {
      process.sendSignal = vi.fn(async () => {});
      process.run.scheduleTick = vi.fn(async () => {});
      process.store.tools.register(
        "dispatch-terminal",
        "provider-call",
        "run-terminal",
        "fs.read",
        { path: "/private/input" },
      );
      process.store.tools.markDispatched("dispatch-terminal");
      process.runs.active = { runId: "run-terminal" };

      await process.controller.handleRes({
        type: "res",
        id: "dispatch-terminal",
        ok: true,
        data: { path: "/private/input", content: "private output" },
      });
      await process.controller.handleRes({
        type: "res",
        id: "dispatch-terminal",
        ok: false,
        error: { code: 500, message: "late private failure" },
      });

      const finishes = process.sendSignal.mock.calls.filter(
        ([signal]: [string]) => signal === "proc.run.tool.finished",
      );
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
      process.store.tools.clearPendingToolCalls();
      process.runs.active = null;
    });
  });

  it("emits a failed terminal signal for a transport error", async () => {
    const pid = "mech-res-tool-transport-error";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    await runInProcess(stub, async (process) => {
      process.sendSignal = vi.fn(async () => {});
      process.run.scheduleTick = vi.fn(async () => {});
      process.store.tools.register(
        "dispatch-transport-error",
        "call-transport-error",
        "run-transport-error",
        "fs.read",
        { path: "/private/input" },
      );
      process.store.tools.markDispatched("dispatch-transport-error");
      process.runs.active = { runId: "run-transport-error" };

      await process.controller.handleRes({
        type: "res",
        id: "dispatch-transport-error",
        ok: false,
        error: { code: 503, message: "private transport failure" },
      });

      expect(process.sendSignal).toHaveBeenCalledWith("proc.run.tool.finished", {
        pid,
        runId: "run-transport-error",
        executionId: "dispatch-transport-error",
        callId: "call-transport-error",
        outcome: "failed",
        timestamp: expect.any(Number),
      });
      const finish = process.sendSignal.mock.calls.find(
        ([signal]: [string]) => signal === "proc.run.tool.finished",
      );
      expect(JSON.stringify(finish?.[1])).not.toContain("private");
      process.store.tools.clearPendingToolCalls();
      process.runs.active = null;
    });
  });

  it("emits cancelled finish only for dispatched tools during interruption", async () => {
    const pid = "mech-res-tool-cancelled-signal";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    await runInProcess(stub, async (process) => {
      process.sendSignal = vi.fn(async () => {});
      process.runs.active = { runId: "run-cancelled" };
      process.store.tools.register(
        "dispatch-started",
        "call-started",
        "run-cancelled",
        "fs.read",
        {},
      );
      process.store.tools.markDispatched("dispatch-started");
      process.store.tools.register(
        "dispatch-registered",
        "call-registered",
        "run-cancelled",
        "fs.read",
        {},
      );

      await process.tools.ingestToolResults(
        "run-cancelled",
        process.store.tools.getResults("run-cancelled"),
        { interruptPending: "private cancellation reason" },
      );

      const finishes = process.sendSignal.mock.calls.filter(
        ([signal]: [string]) => signal === "proc.run.tool.finished",
      );
      expect(finishes).toHaveLength(1);
      expect(finishes[0][1]).toMatchObject({
        pid,
        runId: "run-cancelled",
        executionId: "dispatch-started",
        callId: "call-started",
        outcome: "cancelled",
      });
      expect(JSON.stringify(finishes[0][1])).not.toContain("private");
      process.runs.active = null;
    });
  });

  it("fails a run whose media preparation watchdog expires", async () => {
    const pid = "mech-res-media-timeout";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    await runInProcess(stub, async (process) => {
      process.sendSignal = vi.fn();
      const messageId = process.store.messages.appendMessage("user", "slow attachment", {
        runId: "run-media-timeout",
      });
      process.runs.active = {
        runId: "run-media-timeout",
        pendingMediaMessageId: messageId,
      };
      const signal = process.run.runAbortSignal("run-media-timeout");

      await process.run.onMediaPreparationTimeout("run-media-timeout");

      expect(signal.aborted).toBe(true);
      expect(process.runs.active).toBeNull();
      expect(process.store.messages.getMessages()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: "system",
            runId: "run-media-timeout",
            content: expect.stringContaining("media preparation timed out"),
          }),
        ]),
      );
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

    await runInProcess(stub, async (process) => {
      process.run.schedule = vi.fn();
      process.runs.active = { runId: "run-timeouts" };
      for (const dispatchId of ["dispatch-a", "dispatch-b"]) {
        process.store.tools.register(dispatchId, dispatchId, "run-timeouts", "fs.read", {});
        process.store.tools.markDispatched(dispatchId);
      }

      await Promise.all([
        process.run.onToolDispatchTimeout({
          runId: "run-timeouts",
          dispatchId: "dispatch-a",
        }),
        process.run.onToolDispatchTimeout({
          runId: "run-timeouts",
          dispatchId: "dispatch-b",
        }),
      ]);

      expect(
        process.store.tools.getResults("run-timeouts").map((result: any) => result.status),
      ).toEqual(["error", "error"]);
      expect(process.run.schedule).toHaveBeenCalledTimes(1);
      expect(process.run.schedule).toHaveBeenCalledWith(
        expect.any(Date),
        "tick",
        { runId: "run-timeouts", generation: 0 },
        { idempotent: true },
      );
      process.store.tools.clearPendingToolCalls();
      process.runs.active = null;
    });
  });

  it("fails a tool without dispatching when its watchdog cannot be scheduled", async () => {
    const pid = "mech-res-tool-timeout-schedule-failure";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    await runInProcess(stub, async (process) => {
      process.sendSignal = vi.fn();
      process.run.schedule = vi.fn(async () => {
        throw new Error("scheduler unavailable");
      });
      process.kernel.dispatchSyscall = vi.fn();
      process.runs.active = approvedRun("run-timeout-schedule-failure");
      registerToolBlock(process, "run-timeout-schedule-failure", [
        { id: "call-timeout-schedule-failure", name: "Read", arguments: { path: "/slow" } },
      ]);

      await process.tools.processToolCalls("run-timeout-schedule-failure");

      expect(process.kernel.dispatchSyscall).not.toHaveBeenCalled();
      expect(process.store.tools.getResults("run-timeout-schedule-failure")).toMatchObject([
        {
          id: "call-timeout-schedule-failure",
          status: "error",
          error: "Failed to schedule tool timeout: scheduler unavailable",
        },
      ]);
      process.store.tools.clearPendingToolCalls();
      process.runs.active = null;
    });
  });

  it("admits public user takeover while a shell syscall is still running", async () => {
    const pid = "mech-res-direct-after-takeover";
    const stub = await initProcess(pid, ROOT_IDENTITY);
    const originalRecvFrame = Kernel.prototype.recvFrame;
    let oldDispatchId = "";
    const responseGate = deferred();
    const responseBlocked = responseGate.promise;
    let releaseResponse: (() => void) | undefined = responseGate.resolve;
    const { promise: requestStarted, resolve: markRequestStarted } = deferred();
    // SAFETY: test fixture is constructed with the asserted domain shape.
    const recvSpy = vi
      .spyOn(Kernel.prototype as any, "recvFrame")
      .mockImplementation(async function (this: Kernel, processId: string, frame: any) {
        if (
          frame?.type === "req" &&
          frame.call === "shell.exec" &&
          frame.args?.input === "sleep 300"
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
      });

    // SAFETY: test fixture is constructed with the asserted domain shape.

    try {
      await runInProcess(stub, async (process, _state, instance) => {
        process.sendSignal = vi.fn();
        process.generation = {
          async generate() {
            return assistantResponse([
                {
                    type: "toolCall",
                    id: "call-direct-old",
                    name: "Shell",
                    arguments: { input: "sleep 300", target: "gsv" },
                },
            ], {
                usage: testUsage(),
                stopReason: "toolUse"
            });
          },
          async generateText() {
            return "";
          },
        };
        process.store.messages.appendMessage("user", "run the long command", {
          runId: "run-direct-old",
        });
        process.runs.active = {
          runId: "run-direct-old",
          config: {
            executor: { kind: "process", pid },
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

        const ticking = process.run.tick({ runId: "run-direct-old", generation: 0 });
        await requestStarted;
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const response = (await Promise.race([
          instance.recvFrame(
            makeReq("proc.send", {
              message: "stop waiting",
              origin: { kind: "client", connectionId: "client-1" },
            }),
          ),
          new Promise<never>((_resolve, reject) => {
            setTimeout(
              () => reject(new Error("proc.send was blocked by the shell syscall")),
              250,
            );
            // SAFETY: test fixture is constructed with the asserted domain shape.
          }),
          // SAFETY: test fixture is constructed with the asserted domain shape.
        ])) as ResponseOkFrame;
        // SAFETY: test fixture is constructed with the asserted domain shape.
        const takeoverRunId = (response.data as any).runId;
        expect(process.runs.active).toMatchObject({ runId: takeoverRunId });
        const { promise: successorStarted, resolve: markSuccessorStarted } = deferred();
        process.run.runTick = vi.fn(async (runId: string) => {
          if (runId === takeoverRunId) {
            markSuccessorStarted();
          }
        });
        await process.run.tick({ runId: takeoverRunId, generation: 0 });
        await Promise.race([
          successorStarted,
          new Promise<never>((_resolve, reject) => {
            setTimeout(
              () => reject(new Error("successor tick was blocked by the shell syscall")),
              250,
            );
          }),
        ]);

        releaseResponse?.();
        releaseResponse = undefined;
        await ticking;

        expect(oldDispatchId).not.toBe("");
        expect(process.store.tools.getResults("run-direct-old")).toEqual([]);
        expect(process.store.state.getValue("shellSessionTarget:sh_late")).toBeNull();
        expect(process.runs.active).toMatchObject({ runId: takeoverRunId });
        process.runs.active = null;
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
    const { promise: responseBlocked, resolve: releaseResponse } = deferred();
    const { promise: requestStarted, resolve: markRequestStarted } = deferred();
    // SAFETY: test fixture is constructed with the asserted domain shape.
    const recvSpy = vi
      .spyOn(Kernel.prototype as any, "recvFrame")
      .mockImplementation(async function (this: Kernel, processId: string, frame: any) {
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
      });

    try {
      await runInProcess(stub, async (process) => {
        process.sendSignal = vi.fn();
        process.run.scheduleTick = vi.fn(async () => {});
        process.runs.active = { runId: "run-codemode-old" };

        const dispatching = process.tools.dispatchCodeModeSyscall(
          "run-codemode-old",
          "codemode-direct-old",
          "shell.exec",
          { input: "sleep 300", target: "gsv" },
        );
        await requestStarted;

        const takeover = await process.controller.handleProcSend({
          message: "stop waiting",
          origin: { kind: "client", connectionId: "client-1" },
        });
        releaseResponse();

        await expect(dispatching).rejects.toThrow("Run stopped before shell.exec completed");
        expect(process.store.state.getValue("shellSessionTarget:sh_codemode_late")).toBeNull();
        expect(process.runs.active).toMatchObject({ runId: takeover.runId });
        process.runs.active = null;
      });
    } finally {
      releaseResponse();
      recvSpy.mockRestore();
    }
  });

  it("claims a recovered tool once while the original dispatcher unwinds", async () => {
    const pid = "mech-res-tool-recovery-claim";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    await runInProcess(stub, async (process) => {
      const { promise: firstBlocked, resolve: releaseFirst } = deferred();
      const { promise: firstStarted, resolve: markFirstStarted } = deferred();
      const dispatches: string[] = [];
      process.sendSignal = vi.fn();
      process.run.schedule = vi.fn();
      process.kernel.dispatchSyscall = vi.fn(async (_runId: string, dispatchId: string) => {
        dispatches.push(dispatchId);
        if (dispatchId === "dispatch-call-1") {
          markFirstStarted();
          await firstBlocked;
        }
      });
      process.runs.active = approvedRun("run-recovery-claim");
      registerToolBlock(process, "run-recovery-claim", [
        { id: "call-1", name: "Read", arguments: { path: "/one" } },
        { id: "call-2", name: "Read", arguments: { path: "/two" } },
      ]);

      const original = process.tools.processToolCalls("run-recovery-claim");
      await firstStarted;
      await original;
      expect(dispatches).toEqual(["dispatch-call-1", "dispatch-call-2"]);
      process.store.tools.fail("dispatch-call-1", "simulated lost dispatch");
      await process.run.runTick("run-recovery-claim");
      expect(dispatches).toEqual(["dispatch-call-1", "dispatch-call-2"]);

      releaseFirst();
      expect(dispatches).toEqual(["dispatch-call-1", "dispatch-call-2"]);
      process.store.tools.clearPendingToolCalls();
      process.runs.active = null;
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
    const recvSpy = vi
      .spyOn(Kernel.prototype as any, "recvFrame")
      .mockImplementation(async function (this: Kernel, processId: string, frame: any) {
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
      });

    try {
      await runInProcess(stub, async (process) => {
        process.runs.active = { runId: "run-sync-body" };
        process.store.tools.register(
          "dispatch-sync-body",
          "call-sync-body",
          "run-sync-body",
          "fs.read",
          { path: "/tmp/note.txt", offset: 1 },
        );

        await process.kernel.dispatchSyscall("run-sync-body", "dispatch-sync-body", "fs.read", {
          path: "/tmp/note.txt",
          offset: 1,
        });

        expect(process.store.tools.getResults("run-sync-body")).toMatchObject([
          {
            status: "completed",
            result: {
              content: "     2\thello\n\n[Read truncated. Continue with Read using offset 2.]",
            },
          },
        ]);
        expect(forwardedArgs).toEqual({
          path: "/tmp/note.txt",
          offset: 1,
          limit: 2_000,
          maxBytes: 65_536,
          representation: "resource",
        });
        process.runs.active = null;
      });
    } finally {
      recvSpy.mockRestore();
    }
  });

  it("rejects an oversized text response from a device that ignores Read bounds", async () => {
    const pid = "mech-res-read-hard-cap";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    await runInProcess(stub, async (process) => {
      process.runs.active = { runId: "run-read-hard-cap" };
      process.sendSignal = vi.fn(async () => {});
      process.run.scheduleTick = vi.fn(async () => {});
      process.store.tools.register(
        "dispatch-read-hard-cap",
        "call-read-hard-cap",
        "run-read-hard-cap",
        "fs.read",
        { path: "/tmp/huge.txt" },
      );
      process.store.tools.markDispatched("dispatch-read-hard-cap");

      await process.controller.handleRes({
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

      expect(process.store.tools.getResults("run-read-hard-cap")).toMatchObject([
        {
          status: "error",
          error: "Body exceeds limit (65537 bytes, max 65536)",
        },
      ]);
      process.runs.active = null;
    });
  });

  it("stops response body materialization when its run is aborted", async () => {
    const pid = "mech-res-body-abort";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    await runInProcess(stub, async (process) => {
      process.runs.active = { runId: "run-body-abort" };
      process.store.tools.register(
        "dispatch-body-abort",
        "call-body-abort",
        "run-body-abort",
        "fs.read",
        { path: "/tmp/note.txt" },
      );
      process.store.tools.markDispatched("dispatch-body-abort");
      let cancelled: ProcessTestValue;
      const response = process.controller.handleRes({
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

      await process.controller.handleProcAbort({});
      await response;

      expect(cancelled).toEqual(new Error("User interrupted tool execution"));
      expect(process.runAbortControllers.size).toBe(0);
    });
  });

  it("does not continue the run until all tool calls in a batch are dispatched", async () => {
    const pid = "mech-res-multi-tool-batch";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    await runInProcess(stub, async (process) => {
      const continuedRunIds: string[] = [];
      const scheduledRunIds: string[] = [];
      let dispatched = 0;
      const { promise: allDispatched, resolve: markAllDispatched } = deferred();

      process.runs.active = approvedRun("run-multi-tool-batch");

      process.sendSignal = async () => {};
      process.run.tick = async (runId: string) => {
        continuedRunIds.push(runId);
      };
      process.run.scheduleTick = async (runId: string) => {
        scheduledRunIds.push(runId);
      };
      process.kernel.dispatchSyscall = async (_dispatchRunId: string, dispatchId: string) => {
        if (dispatchId === "dispatch-call-1") {
          await process.controller.handleRes({
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
      await process.tools.processToolCalls("run-multi-tool-batch");
      await allDispatched;
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(continuedRunIds).toEqual([]);
      expect(scheduledRunIds).toEqual([]);
      expect(process.store.tools.getResults("run-multi-tool-batch")).toEqual([
        expect.objectContaining({
          id: "call-1",
          status: "completed",
        }),
        expect.objectContaining({
          id: "call-2",
          status: "pending",
        }),
      ]);

      await process.controller.handleRes({
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

    await runInProcess(stub, async (process) => {
      const dispatched: ProcessTestValue[] = [];
      process.sendSignal = async () => {};
      process.run.scheduleTick = async () => {};
      process.kernel.dispatchSyscall = async (
        _runId: string,
        _id: string,
        _call: string,
        args: ProcessTestValue,
      ) => {
        dispatched.push(args);
      };

      process.store.tools.register(
        "dispatch-shell-start",
        "call-shell-start",
        "run-shell-start",
        "shell.exec",
        { input: "npm test", target: "macbook" },
      );
      await process.controller.handleRes({
        type: "res",
        id: "dispatch-shell-start",
        ok: true,
        data: { status: "running", output: "", sessionId: "sh_macbook" },
      });

      expect(process.store.state.getValue("shellSessionTarget:sh_macbook")).toBe("macbook");

      process.runs.active = {
        runId: "run-shell-continuation",
        approvalPolicy: {
          default: "auto",
          rules: [{ match: "shell.exec", target: "macbook", action: "deny" }],
        },
      };

      registerToolBlock(process, "run-shell-continuation", [
        {
          type: "toolCall",
          id: "call-shell-poll",
          name: "Shell",
          arguments: { input: "", sessionId: "sh_macbook" },
        },
      ]);
      await process.tools.processToolCalls("run-shell-continuation");

      expect(dispatched).toEqual([]);
      expect(process.store.tools.getResults("run-shell-continuation")).toMatchObject([
        {
          id: "call-shell-poll",
          status: "error",
          error: "Tool execution denied by policy",
        },
      ]);
    });
  });

  it("fails shell continuations when the session device is unknown", async () => {
    const pid = "mech-res-shell-session-unknown-target";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    await runInProcess(stub, async (process) => {
      process.sendSignal = vi.fn();
      process.run.scheduleTick = vi.fn(async () => {});
      process.kernel.dispatchSyscall = vi.fn();
      process.generation = {
        async generate() {
          return assistantResponse([
              {
                  type: "toolCall",
                  id: "call-shell-unknown-poll",
                  name: "Shell",
                  arguments: { input: "", sessionId: "sh_unknown" },
              },
          ], {
              usage: testUsage(),
              stopReason: "toolUse"
          });
        },
        async generateText() {
          return "";
        },
      };
      process.store.messages.appendMessage("user", "poll an unknown shell", {
        runId: "run-shell-unknown-continuation",
      });
      process.runs.active = generationRun("run-shell-unknown-continuation", processTestConfig(pid, {
        generationStreaming: "off"
      }), {
        tools: offeredTools("Shell"),
        systemPrompt: "Test system prompt.",
        approvalPolicy: {
          default: "auto",
          rules: [{ match: "shell.exec", target: "macbook", action: "deny" }],
        }
      });

      await process.run.runTick("run-shell-unknown-continuation");

      expect(process.kernel.dispatchSyscall).not.toHaveBeenCalled();
      expect(process.store.tools.getResults("run-shell-unknown-continuation")).toMatchObject([
        {
          id: "call-shell-unknown-poll",
          status: "error",
          error: expect.stringContaining(
            "Shell session continuation requires an explicit target",
          ),
        },
      ]);
      process.store.tools.clearPendingToolCalls();
      process.runs.active = null;
    });
  });
});
