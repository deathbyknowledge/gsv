import { Kernel } from "../kernel/do";
import type { RequestFrame, ResponseOkFrame } from "../protocol/frames";
import { getKernelPtr } from "../shared/utils";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  deferred, okProcessResponse, runInProcess, ROOT_IDENTITY, initProcess, makeReq,
} from "./do-test-harness";

describe("proc.abort", () => {
  it("returns aborted=false when no run is active", async () => {
    const pid = "mech-abort-idle";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    const res = await okProcessResponse(stub, makeReq("proc.abort", {}));

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

    await runInProcess(stub, (process) => {
      process.runs.active = { runId: "run-new" };
    });

    const res = await okProcessResponse(stub, makeReq("proc.abort", { runId: "run-old" }));

    expect(res.data).toMatchObject({ ok: true, pid, aborted: false });
    await runInProcess(stub, (process) => {
      expect(process.runs.active).toMatchObject({ runId: "run-new" });
      process.runs.active = null;
    });
  });

  it("promotes a queued successor without waiting for finish delivery", async () => {
    const pid = "mech-finish-claims-successor";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    await runInProcess(stub, async (process) => {
      process.finishDelivery.deliver = vi.fn(() => new Promise<void>(() => {}));
      process.sendSignal = vi.fn();
      process.run.scheduleTick = vi.fn(async () => {});
      process.runs.active = { runId: "run-old" };
      process.store.queue.enqueue("run-next", "next message");

      await process.run.finishRun("run-old", {
        reason: "turn.complete",
        status: "ok",
      });
      expect(process.runs.active).toMatchObject({ runId: "run-next" });
      expect(process.store.queue.queueSize()).toBe(0);
      expect(process.run.scheduleTick).toHaveBeenCalledWith("run-next");

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
      process.runs.active = null;
    });
  });

  it("keeps failed run-finish delivery in the durable outbox", async () => {
    const stub = await initProcess("mech-finish-outbox", ROOT_IDENTITY);

    await runInProcess(stub, async (process) => {
      process.sendSignal = vi.fn(async () => {
        throw new Error("kernel unavailable");
      });
      process.run.schedule = vi.fn(async () => ({ id: "finish-retry" }));

      process.run.completeRunFinish(
        process.run.recordRunFinish(
          { runId: "run-finish-outbox" },
          { reason: "turn.complete", status: "ok", resultText: "done" },
        ),
      );
      await vi.waitFor(() =>
        expect(process.run.schedule).toHaveBeenCalledWith(
          5,
          "onRunFinishDelivery",
          "run-finish-outbox",
          {
            idempotent: false,
            retry: { maxAttempts: 10, baseDelayMs: 1_000, maxDelayMs: 30_000 },
          },
        ),
      );
      expect(JSON.parse(process.store.state.getValue("pendingRunFinishes"))).toHaveLength(1);

      process.sendSignal = vi.fn(async () => {});
      await process.finishDelivery.deliver("run-finish-outbox");
      expect(process.store.state.getValue("pendingRunFinishes")).toBeNull();
    });
  });

  it("stops terminal delivery after ten attempts and records an inspectable history note", async () => {
    const stub = await initProcess("mech-finish-outbox-exhausted", ROOT_IDENTITY);

    await runInProcess(stub, async (process) => {
      process.store.state.setValue(
        "pendingRunFinishes",
        JSON.stringify([
          {
            pid: process.pid,
            runId: "run-finish-exhausted",
            status: "ok",
            reason: "turn.complete",
            text: "completed answer",
            queuedCount: 0,
            timestamp: 1,
            deliveryAttempts: 9,
          },
        ]),
      );
      process.sendSignal = vi.fn(async () => {
        throw new Error("adapter transport remains unavailable");
      });
      process.run.schedule = vi.fn(async () => ({ id: "must-not-retry" }));
      process.signals.changed = vi.fn(async () => {});
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      await process.finishDelivery.deliver("run-finish-exhausted");

      expect(process.sendSignal).toHaveBeenCalledWith(
        "proc.run.finished",
        expect.objectContaining({
          runId: "run-finish-exhausted",
          result: { text: "completed answer" },
          delivery: { kind: "none" },
        }),
      );
      expect(process.run.schedule).not.toHaveBeenCalled();
      expect(process.store.state.getValue("pendingRunFinishes")).toBeNull();
      expect(process.store.messages.getMessages()).toContainEqual(
        expect.objectContaining({
          role: "system",
          runId: "run-finish-exhausted",
          content: expect.stringContaining(
            "Run completion signaling stopped after repeated transport failures",
          ),
        }),
      );
      expect(process.signals.changed).toHaveBeenCalledWith(
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

    await runInProcess(stub, (process) => {
      process.store.messages.appendMessage("assistant", "", {
        runId: "run-1",
        toolCalls: JSON.stringify([
          { type: "toolCall", id: "call-1", name: "Read", arguments: { path: "/root/test.txt" } },
          {
            type: "toolCall",
            id: "call-2",
            name: "Read",
            arguments: { path: "/root/other.txt" },
          },
        ]),
      });
      process.store.tools.register("dispatch-1", "call-1", "run-1", "fs.read", {
        path: "/root/test.txt",
      });
      process.store.tools.markDispatched("dispatch-1");
      process.store.tools.register("dispatch-2", "call-2", "run-1", "fs.read", {
        path: "/root/other.txt",
      });
      process.store.queue.enqueue("run-2", "follow-up after abort");
      process.runs.active = { runId: "run-1" };
    });

    const res = await okProcessResponse(stub, makeReq("proc.abort", {}));

    expect(res.ok).toBe(true);
    expect(res.data).toMatchObject({
      ok: true,
      pid,
      aborted: true,
      runId: "run-1",
      interruptedToolCalls: 2,
      continuedQueuedRunId: "run-2",
    });

    await runInProcess(stub, (process) => {
      const store = process.store;
      const messages = store.messages.getMessages();
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
      expect(store.queue.queueSize()).toBe(0);
      expect(process.runs.active).toMatchObject({ runId: "run-2" });
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

    try {
      await runInProcess(stub, (process) => {
        process.runs.active = { runId: "run-1" };
        process.store.tools.register("dispatch-1", "call-1", "run-1", "fs.search", {
          query: "needle",
        });
        process.store.tools.markDispatched("dispatch-1");
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

      await vi.waitFor(() =>
        expect(cancelSpy).toHaveBeenCalledWith(
          pid,
          expect.arrayContaining(["dispatch-1", "nested-1"]),
          "User interrupted tool execution",
        ),
      );
      await runInProcess(stub, (process) => {
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
    const { promise: requestBlocked, resolve: releaseRequest } = deferred();
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

    try {
      const result = await runInProcess(stub, async (process) => {
        const controller = new AbortController();
        const request = process.kernel.kernelRpc("ai.text.generate", {}, controller.signal);
        controller.abort(new Error("User interrupted generation"));
        try {
          await request;
          return "resolved";
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      });

      expect(result).toBe("User interrupted generation");
      await vi.waitFor(() =>
        expect(cancelSpy).toHaveBeenCalledWith(
          pid,
          [expect.any(String)],
          "User interrupted generation",
        ),
      );
    } finally {
      releaseRequest();
      recvSpy.mockRestore();
      cancelSpy.mockRestore();
    }
  });

  it("returns without waiting for request cancellation cleanup", async () => {
    const pid = "mech-abort-nonblocking-request-cancel";
    const stub = await initProcess(pid, ROOT_IDENTITY);
    await runInProcess(stub, (process) => {
      process.runs.active = { runId: "run-1" };
      process.store.tools.register("dispatch-1", "call-1", "run-1", "fs.search", {});
      process.store.tools.markDispatched("dispatch-1");
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
        kernel.testCancellationFinished = true;
        return 1;
      });
    const kernel = await getKernelPtr();

    // SAFETY: test fixture is constructed with the asserted domain shape.

    try {
      // SAFETY: test fixture is constructed with the asserted domain shape.
      const response = (await runInProcess(stub, async (process) => {
        return await process.recvFrame(makeReq("proc.abort", {}));
        // SAFETY: test fixture is constructed with the asserted domain shape.
      })) as ResponseOkFrame;
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

    const res = (await runInProcess(stub, async (process) => {
      process.runs.active = { runId: "run-1" };
      const { promise: signalDispatchBlocked, resolve: releaseSignalDispatch } = deferred();
      const delivery = vi.fn(async () => {
        await signalDispatchBlocked;
      });
      process.finishDelivery.deliver = delivery;

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
    })) as ResponseOkFrame;

    expect(res.ok).toBe(true);
    expect(res.data).toMatchObject({
      ok: true,
      pid,
      aborted: true,
      runId: "run-1",
    });
  });
});
