import { getProcessByPid } from "../shared/utils";
import { describe, expect, it, vi } from "vitest";
import {
  captureSignals, deferred, okProcessResponse, runInProcess, ROOT_IDENTITY, initProcess, makeReq,
  registerInKernel, waitForTaskTitle, type ProcessTestValue,
} from "./do-test-harness";

describe("automatic task titles", () => {
  it("generates one title from the first admitted message", async () => {
    const pid = "mech-auto-task-title";
    await registerInKernel(pid, ROOT_IDENTITY);
    const stub = await getProcessByPid(pid);
    await stub.recvFrame(
      makeReq("proc.setidentity", {
        identity: ROOT_IDENTITY,
        autoTitle: true,
      }),
    );

    const kernelCalls: Array<{ call: string; args: any }> = [];
    const emitted: Array<{ signal: string; payload: any }> = [];
    await runInProcess(stub, (process) => {
      process.run.scheduleTick = async () => {};
      process.kernel.kernelRpc = async (call: string, args: any) => {
        kernelCalls.push({ call, args });
        if (call !== "ai.text.generate") {
          throw new Error(`unexpected kernel syscall: ${call}`);
        }
        return { text: '  "Plan Database Migration."\nsecond line' };
      };
      process.sendSignal = async (signal: string, payload: any) => {
        emitted.push({ signal, payload });
      };
    });

    const first = await okProcessResponse(
      stub,
      makeReq("proc.send", {
        message: "Please plan a careful database migration.",
        // SAFETY: test fixture is constructed with the asserted domain shape.
      }),
    );
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
    expect(
      emitted
        .filter(
          (entry) => entry.signal === "proc.changed" && entry.payload.changes?.includes("title"),
        )
        .map((entry) => entry.payload.title),
    ).toEqual(["Please plan a careful database migration", "Plan Database Migration"]);

    await stub.recvFrame(makeReq("proc.send", { message: "Add rollback steps too." }));
    expect(kernelCalls).toHaveLength(1);
  });

  it("starts title generation after admitting the first IPC message", async () => {
    const pid = "mech-auto-task-title-ipc";
    await registerInKernel(pid, ROOT_IDENTITY);
    const stub = await getProcessByPid(pid);
    await stub.recvFrame(
      makeReq("proc.setidentity", {
        identity: ROOT_IDENTITY,
        autoTitle: true,
      }),
    );

    await runInProcess(stub, (process) => {
      process.run.scheduleTick = async () => {};
      process.kernel.kernelRpc = async (call: string) => {
        if (call !== "ai.text.generate") {
          throw new Error(`unexpected kernel syscall: ${call}`);
        }
        return { text: "Review delegated build" };
      };
    });

    const response = await okProcessResponse(
      stub,
      makeReq("proc.ipc.deliver", {
        runId: "run-auto-task-title-ipc",
        sourcePid: "source-process",
        source: ROOT_IDENTITY,
        message: "Review the delegated build.",
        sentAt: Date.now(),
      }),
    );

    expect(response.data).toMatchObject({ ok: true, status: "started", pid });
    await waitForTaskTitle(stub, "Review delegated build");
  });

  it("keeps the bounded first-message fallback when generation fails", async () => {
    const pid = "mech-auto-task-title-fallback";
    await registerInKernel(pid, ROOT_IDENTITY);
    const stub = await getProcessByPid(pid);
    await stub.recvFrame(
      makeReq("proc.setidentity", {
        identity: ROOT_IDENTITY,
        autoTitle: true,
      }),
    );

    const emitted: Array<{ signal: string; payload: any }> = [];
    await runInProcess(stub, (process) => {
      process.run.scheduleTick = async () => {};
      process.kernel.kernelRpc = async () => {
        throw new Error("title generation unavailable");
      };
      process.sendSignal = async (signal: string, payload: any) => {
        emitted.push({ signal, payload });
      };
    });

    await stub.recvFrame(
      makeReq("proc.send", {
        message: "Investigate flaky checkout tests.",
      }),
    );
    await waitForTaskTitle(stub, "Investigate flaky checkout tests");
    await vi.waitFor(() =>
      expect(
        emitted.some(
          (entry) =>
            entry.signal === "proc.changed" &&
            entry.payload.title === "Investigate flaky checkout tests",
        ),
      ).toBe(true),
    );
  });

  it("cancels title generation and ignores a late result after process reset", async () => {
    const pid = "mech-auto-task-title-reset";
    await registerInKernel(pid, ROOT_IDENTITY);
    const stub = await getProcessByPid(pid);
    await stub.recvFrame(
      makeReq("proc.setidentity", {
        identity: ROOT_IDENTITY,
        autoTitle: true,
      }),
    );

    await runInProcess(stub, async (process) => {
      let generationSignal: AbortSignal | undefined;
      const { promise: generationBlocked, resolve: releaseGeneration } = deferred();
      const { promise: generationStarted, resolve: markGenerationStarted } = deferred();
      const { promise: generationCompleted, resolve: markGenerationCompleted } = deferred();
      const emitted = captureSignals(process);
      process.run.scheduleTick = async () => {};
      const generateTaskTitle = process.settings.generateTitle.bind(process.settings);
      process.settings.generateTitle = async (...args: ProcessTestValue[]) => {
        try {
          return await generateTaskTitle(...args);
        } finally {
          markGenerationCompleted();
        }
      };
      process.kernel.kernelRpc = async (
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

      const send = await okProcessResponse(
        process,
        makeReq("proc.send", {
          message: "Investigate flaky checkout tests.",
          // SAFETY: test fixture is constructed with the asserted domain shape.
        }),
      );
      expect(send.data).toMatchObject({ ok: true, status: "started" });
      await generationStarted;
      expect(generationSignal?.aborted).toBe(false);
      expect(process.store.state.getValue("taskTitle")).toBe("Investigate flaky checkout tests");

      const reset = await okProcessResponse(process, makeReq("proc.reset", {}));
      expect(reset.data).toMatchObject({ ok: true, pid });
      expect(generationSignal?.aborted).toBe(true);
      expect(generationSignal?.reason).toEqual(
        new Error("Process execution was reset: process.reset"),
      );

      releaseGeneration();
      await generationCompleted;

      expect(process.store.state.getHistoryGeneration()).toBe(2);
      expect(process.store.state.getValue("taskTitle")).toBe("Investigate flaky checkout tests");
      expect(process.store.messages.messageCount()).toBe(0);
      expect(
        emitted
          .filter(
            (entry) =>
              entry.signal === "proc.changed" && entry.payload.changes?.includes("title"),
          )
          .map((entry) => entry.payload.title),
      ).toEqual(["Investigate flaky checkout tests"]);
    });
  });

  it("aborts owned title work when the process is killed", async () => {
    const pid = "mech-auto-task-title-kill";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    await runInProcess(stub, async (process) => {
      const controller = new AbortController();
      process.settings.titleAbortController = controller;
      process.sendSignal = vi.fn(async () => {});

      const killed = await okProcessResponse(
        process,
        makeReq("proc.kill", {
          archive: false,
          // SAFETY: test fixture is constructed with the asserted domain shape.
        }),
      );

      expect(killed.data).toMatchObject({ ok: true, pid });
      expect(controller.signal.aborted).toBe(true);
      expect(controller.signal.reason).toEqual(
        new Error("Process execution was reset: process.kill"),
      );
      expect(process.settings.titleAbortController).toBeNull();
    });
  });
});
