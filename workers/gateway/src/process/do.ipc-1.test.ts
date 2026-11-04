import { Kernel } from "../kernel/do";
import type { ResponseOkFrame } from "../protocol/frames";
import { getKernelPtr } from "../shared/utils";
import type { ProcHistoryRecord, ProcessIdentity } from "@humansandmachines/gsv/protocol";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  mockGeneration, generationRun, assistantResponse, deferred, runInProcess,
  ROOT_IDENTITY, drainProcessQueue, driveProcessUntilIdle, initProcess, ipcAnswer, ipcMessage, makeReq, messageAction,
  registerInKernel, stubGeneration, terminalTestConfig, waitForStoredMessage, sendMessage,
} from "./do-test-harness";

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
    await runInProcess(target, (process) => {
      process.runs.active = {
        runId: "existing-target-run",
      };
    });

    const kernel = await getKernelPtr("inst_test");
    // SAFETY: test fixture is constructed with the asserted domain shape.
    const response = (await runInDurableObject(
      kernel,
      (instance: Kernel) =>
        instance.recvFrame(
          sourcePid,
          makeReq("proc.ipc.send", {
            pid: targetPid,
            message: "Please summarize the current build status.",
            metadata: { kind: "delegation" },
          }),
        ),
      // SAFETY: test fixture is constructed with the asserted domain shape.
    )) as ResponseOkFrame;

    expect(response.ok).toBe(true);
    expect(response.data).toMatchObject({
      ok: true,
      status: "started",
      pid: targetPid,
      sourcePid,
      queued: true,
    });

    await runInProcess(target, (process) => {
      const store = process.store;
      const messages = store.messages.getMessages();
      expect(messages).toHaveLength(0);
      expect(store.queue.queueSize()).toBe(1);
      const queued = drainProcessQueue(store);
      expect(queued[0].message).toContain(`Message from sam (${sourcePid}).`);
      expect(queued[0].message).toContain("Please summarize the current build status.");
      expect(queued[0].message).toContain('"kind": "delegation"');
      expect(process.runs.active).toMatchObject({});
      process.runs.active = null;
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

    const kernel = await getKernelPtr("inst_test");
    // SAFETY: test fixture is constructed with the asserted domain shape.
    const response = (await runInDurableObject(
      kernel,
      (instance: Kernel) =>
        instance.recvFrame(
          sourcePid,
          makeReq("proc.ipc.send", {
            pid: targetPid,
            message: "This should not cross uid boundaries.",
          }),
        ),
      // SAFETY: test fixture is constructed with the asserted domain shape.
    )) as ResponseOkFrame;

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
    await runInProcess(source, (process) => {
      process.run.scheduleTick = async () => {};
    });
    await runInProcess(target, (process) => {
      process.runs.active = {
        runId: "existing-target-run",
      };
    });

    const kernel = await getKernelPtr("inst_test");
    // SAFETY: test fixture is constructed with the asserted domain shape.
    const response = (await runInDurableObject(
      kernel,
      (instance: Kernel) =>
        instance.recvFrame(
          sourcePid,
          makeReq("proc.ipc.call", {
            pid: targetPid,
            message: "Please reply with the status.",
            timeoutMs: 30_000,
          }),
        ),
      // SAFETY: test fixture is constructed with the asserted domain shape.
    )) as ResponseOkFrame;

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

    await runInProcess(target, (process) => {
      const store = process.store;
      const queued = drainProcessQueue(store);
      expect(queued).toHaveLength(1);
      expect(queued[0].message).toContain(`Delegated task from sam (${sourcePid}).`);
      expect(queued[0].message).toContain("Please complete this task before");
      expect(queued[0].message).toContain(
        "Your final answer will be returned to the caller automatically.",
      );
      expect(queued[0].message).not.toContain("Call id:");
      expect(queued[0].message).not.toContain("Reply target:");
      store.queue.enqueue(data.runId, queued[0].message, { origin: "mail" });
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

    await waitForStoredMessage(source, (message) =>
      message.content.includes(`Process \`${targetPid}\` finished task \`${data.callId}\`.`),
    );

    await runInProcess(source, (process) => {
      const store = process.store;
      const messages = store.messages.getMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe("system");
      expect(messages[0].content).toContain(
        `Process \`${targetPid}\` finished task \`${data.callId}\`.`,
      );
      expect(messages[0].content).not.toContain("Task id:");
      expect(messages[0].content).toContain("status is green");
      expect(process.runs.active).toMatchObject({});
      process.runs.active = null;
    });
  });

  // SAFETY: test fixture is constructed with the asserted domain shape.
  it("returns aborted target runs to IPC callers as errors", async () => {
    const sourcePid = "mech-ipc-abort-source";
    const targetPid = "mech-ipc-abort-target";
    const source = await initProcess(sourcePid, ROOT_IDENTITY);
    await initProcess(targetPid, ROOT_IDENTITY);
    await runInProcess(source, (process) => {
      process.run.scheduleTick = vi.fn(async () => {});
    });

    const kernel = await getKernelPtr("inst_test");
    // SAFETY: test fixture is constructed with the asserted domain shape.
    const response = (await runInDurableObject(
      kernel,
      (instance: Kernel) =>
        instance.recvFrame(
          sourcePid,
          makeReq("proc.ipc.call", {
            pid: targetPid,
            message: "Start a delegated task.",
            timeoutMs: 30_000,
          }),
        ),
      // SAFETY: test fixture is constructed with the asserted domain shape.
    )) as ResponseOkFrame;
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

    await waitForStoredMessage(source, (message) =>
      message.content.includes(`Process \`${targetPid}\` finished task \`${data.callId}\`.`),
    );

    await runInProcess(source, (process) => {
      const reply = process.store.messages
        .getMessages()
        .find(
          (message: any) =>
            message.role === "system" && message.content.includes(`Process \`${targetPid}\` finished task \`${data.callId}\`.`),
        );
      expect(reply?.content).toContain("Error:");
      expect(reply?.content).toContain("Target run was aborted: user.superseded");
      process.runs.active = null;
    });
  });

  it("cancels delegated IPC when its source run is superseded", async () => {
    const sourcePid = "mech-ipc-cancelled-source-run";
    const targetPid = "mech-ipc-cancelled-target-run";
    const source = await initProcess(sourcePid, ROOT_IDENTITY);
    const target = await initProcess(targetPid, ROOT_IDENTITY);

    await runInProcess(source, (process) => {
      process.run.scheduleTick = vi.fn(async () => {});
    });
    await runInProcess(target, (process) => {
      process.runs.active = { runId: "target-busy-run" };
    });

    const firstSend = await sendMessage(source, {
      message: "delegate a slow task",
      origin: { kind: "client", connectionId: "client-1" },
    });
    const sourceRunId = firstSend.runId;

    const kernel = await getKernelPtr("inst_test");
    // SAFETY: test fixture is constructed with the asserted domain shape.
    const ipcResponse = (await runInDurableObject(
      kernel,
      (instance: Kernel) =>
        instance.recvFrame(sourcePid, {
          ...makeReq("proc.ipc.call", {
            pid: targetPid,
            message: "wait for the slow task",
            timeoutMs: 30_000,
          }),
          runId: sourceRunId,
        }),
      // SAFETY: test fixture is constructed with the asserted domain shape.
    )) as ResponseOkFrame;
    // SAFETY: test fixture is constructed with the asserted domain shape.
    const ipc = ipcResponse.data as any;
    expect(ipc).toMatchObject({ ok: true, queued: true });

    const secondSend = await sendMessage(source, {
      message: "stop waiting and do this instead",
      origin: { kind: "client", connectionId: "client-1" },
    });
    const successorRunId = secondSend.runId;

    await vi.waitFor(async () => {
      expect(
        await runInDurableObject(kernel, (instance: Kernel) =>
          // SAFETY: test fixture is constructed with the asserted domain shape.
          (instance as any).ipcCalls.get(ipc.callId),
        ),
      ).toBeNull();
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

    await runInProcess(source, (process) => {
      expect(process.runs.active).toMatchObject({ runId: successorRunId });
      expect(
        process.store.messages
          .getMessages()
          .some(
            (message: any) =>
              message.role === "system" &&
              (message.content.includes(`Process \`${targetPid}\` finished task \`${ipc.callId}\`.`) ||
                message.content.includes("late delegated result")),
          ),
      ).toBe(false);
      process.runs.active = null;
    });
    await runInProcess(target, (process) => {
      process.runs.active = null;
      process.store.queue.clearQueue();
    });
  });

  it("drops IPC replies for a source run that was already aborted", async () => {
    const pid = "mech-ipc-aborted-source-run";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    await runInProcess(stub, async (process, _state, instance) => {
      process.sendSignal = vi.fn();
      process.run.scheduleTick = vi.fn(async () => {});
      process.controller.rememberAbortedRun("run-aborted");
      process.runs.active = { runId: "run-successor" };

      const delivery = ipcAnswer("ipc.reply", {
        callId: "call-aborted",
        sourceRunId: "run-aborted",
        targetPid: "target-process",
        deadlineAt: Date.now() + 30_000,
        response: { text: "late delegated result", usage: null },
      });
      expect(await instance.deliverEvent(delivery)).toEqual({ eventId: delivery.eventId, runId: null, queued: false, ignored: true });

      expect(process.store.messages.getMessages()).toEqual([]);
      expect(process.store.queue.queueSize()).toBe(0);
      expect(process.runs.active).toMatchObject({ runId: "run-successor" });
      expect(process.sendSignal).not.toHaveBeenCalled();
      expect(process.run.scheduleTick).not.toHaveBeenCalled();
      process.runs.active = null;
    });
  });

  it("drops IPC terminal events created before a process reset", async () => {
    const pid = "mech-ipc-reset-source";
    const stub = await initProcess(pid, ROOT_IDENTITY);
    const createdAt = Date.now() - 1_000;

    await stub.recvFrame(makeReq("proc.reset", {}));
    const delivery = ipcAnswer("ipc.reply", {
      callId: "call-before-reset",
      targetPid: "target-process",
      createdAt,
      deadlineAt: Date.now() + 30_000,
      response: { text: "stale result", usage: null },
    });
    expect(await stub.deliverEvent(delivery)).toEqual({ eventId: delivery.eventId, runId: null, queued: false, ignored: true });

    await runInProcess(stub, (process) => {
      expect(process.store.messages.getMessages()).toEqual([]);
      expect(process.runs.active).toBeNull();
    });
  });

  it("does not recreate a killed process for a late IPC event", async () => {
    const stub = await initProcess("mech-ipc-killed-source", ROOT_IDENTITY);

    await stub.recvFrame(makeReq("proc.kill", { archive: false }));
    const late = await stub.deliverEvent(ipcAnswer("ipc.timeout", {
      callId: "call-after-kill",
      targetPid: "target-process",
      createdAt: Date.now() - 1_000,
      deadlineAt: Date.now(),
      error: "IPC call timed out",
    }));
    expect(late).toMatchObject({ unavailable: "killed" });

    await runInProcess(stub, (_instance, state) => {
      const tables = state.storage.sql
        .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .toArray()
        .map((row) => row.name);
      expect(tables).not.toEqual(
        expect.arrayContaining(["conversations", "messages", "process_kv"]),
      );
    });
  });

  it("keeps an overdue delegation open for its eventual reply", async () => {
    const pid = "mech-ipc-overdue-source";
    const stub = await initProcess(pid, ROOT_IDENTITY);
    const callId = "call-overdue";
    const createdAt = Date.now() - 1_000;

    const checkIn = ipcAnswer("ipc.overdue", {
      callId,
      targetPid: "target-process",
      createdAt,
      deadlineAt: Date.now(),
      nextCheckAt: Date.now() + 60_000,
      checkInCount: 1,
    });
    await stub.deliverEvent(checkIn);
    await stub.deliverEvent(checkIn);
    await stub.deliverEvent(ipcAnswer("ipc.reply", {
      callId,
      targetPid: "target-process",
      createdAt,
      deadlineAt: Date.now(),
      response: { text: "eventual result", usage: null },
    }));

    await runInProcess(stub, (process) => {
      const messages = process.store.messages.getMessages();
      expect(
        messages.filter((message: any) => message.content.includes("is still running")),
      ).toHaveLength(1);
      expect(messages.some((message: any) => message.content.includes("eventual result"))).toBe(
        true,
      );
      process.runs.active = null;
    });
  });

  it("records a redelivered answer once, by its delivery's id", async () => {
    const pid = "mech-ipc-deduplicated-reply";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    await runInProcess(stub, async (process, _state, instance) => {
      process.sendSignal = vi.fn();
      process.run.scheduleTick = vi.fn(async () => {});
      const delivery = ipcAnswer("ipc.reply", {
        callId: "call-retried",
        targetPid: "target-process",
        deadlineAt: Date.now() + 30_000,
        response: { text: "delivered once", usage: null },
      });

      const first = await instance.deliverEvent(delivery);
      expect(await instance.deliverEvent(delivery)).toEqual(first);

      expect(
        process.store.messages
          .getMessages()
          .filter((message: any) => message.content.includes("delivered once")),
      ).toHaveLength(1);
      expect(process.run.scheduleTick).toHaveBeenCalledTimes(1);
      process.runs.active = null;
    });
  });

  it("gives an answer for another run its own run after the active one, leaving the active run alone", async () => {
    const pid = "mech-ipc-other-source-run";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    await runInProcess(stub, async (process, _state, instance) => {
      process.sendSignal = vi.fn();
      process.run.scheduleTick = vi.fn(async () => {});
      process.runs.active = { runId: "run-active" };

      const delivery = ipcAnswer("ipc.reply", {
        callId: "call-other-run",
        sourceRunId: "run-waiting",
        targetPid: "target-process",
        deadlineAt: Date.now() + 30_000,
        response: { text: "delegated result for an older run", usage: null },
      });
      expect(await instance.deliverEvent(delivery)).toEqual({ eventId: delivery.eventId, runId: delivery.eventId, queued: true });

      // The active run never sees it; the answer waits for its own run.
      expect(process.store.messages.getMessages()).toEqual([]);
      expect(process.runs.active).toEqual({ runId: "run-active" });
      const queued = drainProcessQueue(process.store);
      expect(queued).toHaveLength(1);
      expect(queued[0]).toMatchObject({
        type: "message",
        runId: delivery.eventId,
        role: "system",
        message: expect.stringContaining("delegated result for an older run"),
        record: { kind: "event", payload: delivery.event },
      });
      expect(process.sendSignal).toHaveBeenCalledWith(
        "proc.changed",
        expect.objectContaining({ changes: ["queue"] }),
      );
      expect(process.run.scheduleTick).not.toHaveBeenCalled();
      process.runs.active = null;
    });
  });

  it("defers the fallback wake run until a busy source run finishes", async () => {
    const sourcePid = "mech-ipc-busy-source";
    const targetPid = "mech-ipc-busy-target";
    const source = await initProcess(sourcePid, ROOT_IDENTITY);

    await runInProcess(source, (process) => {
      process.run.scheduleTick = vi.fn(async () => {});
      process.runs.active = {
        runId: "active-source-run",
      };
    });

    await source.deliverEvent(ipcAnswer("ipc.reply", {
      callId: "busy-call",
      targetPid,
      deadlineAt: Date.now() + 30_000,
      response: {
        text: "busy result",
        usage: null,
        media: [
          {
            type: "video",
            mimeType: "video/mp4",
            key: `home/worker/.gsv/media/archived-media:${"a".repeat(64)}`,
            path: `/home/worker/.gsv/media/archived-media:${"a".repeat(64)}`,
            filename: "clip.mp4",
            size: 1234,
          },
        ],
      },
    }));

    await runInProcess(source, (process) => {
      const messages = process.store.messages.getMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe("system");
      expect(messages[0].content).toContain(
        `Process \`${targetPid}\` finished task \`busy-call\`.`,
      );
      expect(messages[0].content).toContain("busy result");
      expect(messages[0].content).toContain("Attachments:");
      expect(messages[0].content).toContain(
        `/home/worker/.gsv/media/archived-media:${"a".repeat(64)}`,
      );
      expect(process.runs.active).toMatchObject({
        runId: "active-source-run",
        pendingRuntimeEvents: 1,
      });
      expect(process.store.queue.queueSize()).toBe(0);
      expect(process.run.scheduleTick).not.toHaveBeenCalled();
    });

    await runInProcess(source, async (process) => {
      await process.run.finishRun("active-source-run", {
        reason: "turn.complete",
        status: "ok",
        text: "parent finished before reading the event",
      });
    });

    await runInProcess(source, (process) => {
      const runtimeMessages = process.store.messages
        .getMessages()
        .filter((message: any) => message.role === "system");
      expect(runtimeMessages).toHaveLength(1);
      expect(runtimeMessages[0].content).toContain("busy result");
      expect(process.store.messages.getRecords().some((record: ProcHistoryRecord) =>
        record.kind === "event" && record.payload.kind === "runtime.wake",
      )).toBe(false);
      expect(process.store.queue.queueSize()).toBe(0);
      expect(process.runs.active?.runId).not.toBe("active-source-run");
      expect(process.runs.active).toMatchObject({});
      process.runs.active = null;
    });
  });

  it("uses a busy bounded IPC reply on the next tool-result turn", async () => {
    const sourcePid = "mech-ipc-next-turn-source";
    const targetPid = "mech-ipc-next-turn-target";
    const source = await initProcess(sourcePid, ROOT_IDENTITY);

    const result = await runInProcess(source, async (process) => {
      const generatedInputs: string[] = [];
      process.sendSignal = async () => {};
      mockGeneration(process, async (request: any) => {
        generatedInputs.push(JSON.stringify(request.context.messages));
        return assistantResponse([
          { type: "text", text: "used delegated result" },
          messageAction("used delegated result", "delegated-result-message"),
        ]);
      }, async () => {
        return "";
      });
      process.store.messages.appendMessage("user", "Wait for delegated work.", {
        runId: "active-source-turn",
      });
      process.store.messages.appendMessage("assistant", "Waiting on a command.", {
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
      process.store.tools.register(
        "dispatch_shell",
        "call_shell",
        "active-source-turn",
        "shell.exec",
        {
          input: "sleep 10",
          target: "gsv",
        },
      );
      process.store.tools.resolve("dispatch_shell", { ok: true, stdout: "done" });
      process.runs.active = generationRun("active-source-turn", {
        ...terminalTestConfig(sourcePid),
        provider: "workers-ai",
        model: "@cf/test/model",
      }, {
        mcpServers: []
      });

      await process.deliverEvent(ipcAnswer("ipc.reply", {
        callId: "next-turn-call",
        targetPid,
        deadlineAt: Date.now() + 30_000,
        response: { text: "next-turn result", usage: null },
      }));

      expect(process.runs.active).toMatchObject({
        runId: "active-source-turn",
        pendingRuntimeEvents: 1,
      });
      expect(process.store.queue.queueSize()).toBe(0);

      await process.run.runTick("active-source-turn");

      return {
        generatedInputs,
        queueSize: process.store.queue.queueSize(),
        currentRun: process.runs.active,
        messages: process.store.messages.getMessages(),
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
      expect(input).toContain(`Process \`${targetPid}\` finished task \``);
      expect(input).toContain(token);
      return token;
    });

    const kernel = await getKernelPtr("inst_test");
    // SAFETY: test fixture is constructed with the asserted domain shape.
    const response = (await runInDurableObject(
      kernel,
      (instance: Kernel) =>
        instance.recvFrame(
          sourcePid,
          makeReq("proc.ipc.call", {
            pid: targetPid,
            message: `Reply with exactly this token and nothing else: ${token}. Do not call tools.`,
            timeoutMs: 60_000,
          }),
        ),
      // SAFETY: test fixture is constructed with the asserted domain shape.
    )) as ResponseOkFrame;

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
    while (Date.now() < deadline) {
      replyMessage = await runInProcess(source, (process) => {
        const messages = process.store.messages.getMessages();
        return (
          messages.find(
            (message: any) =>
              message.role === "system" &&
              message.content.includes(`Process \`${targetPid}\` finished task \`${data.callId}\`.`),
          ) ?? null
        );
      });
      if (replyMessage) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    expect(replyMessage).toBeTruthy();
    expect(replyMessage.content).toContain(token);

    await driveProcessUntilIdle(source, 10_000);

    await runInProcess(source, (process) => {
      const messages = process.store.messages.getMessages();
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
    await runInProcess(source, (process) => {
      process.run.scheduleTick = async () => {};
    });

    const kernel = await getKernelPtr("inst_test");
    // SAFETY: test fixture is constructed with the asserted domain shape.
    const response = (await runInDurableObject(
      kernel,
      (instance: Kernel) =>
        instance.recvFrame(
          sourcePid,
          makeReq("proc.ipc.call", {
            pid: targetPid,
            message: "This call will timeout in the test.",
            timeoutMs: 10_000,
          }),
        ),
      // SAFETY: test fixture is constructed with the asserted domain shape.
    )) as ResponseOkFrame;

    // SAFETY: test fixture is constructed with the asserted domain shape.
    const data = response.data as any;
    expect(data.ok).toBe(true);

    // SAFETY: test fixture is constructed with the asserted domain shape.

    await runInDurableObject(kernel, async (instance: Kernel) => {
      instance.ctx.storage.sql.exec("UPDATE ipc_calls SET deadline_at = 0 WHERE call_id = ?", data.callId);
      await instance.ipc.onIpcCallTimeout(data.callId);
    });

    await waitForStoredMessage(source, (message) => message.content.includes("timed out"));
    await runInProcess(source, (process) => {
      const messages = process.store.messages.getMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe("system");
      expect(messages[0].content).toContain(
        `Delegated task to process \`${targetPid}\` timed out.`,
      );
      expect(messages[0].content).toContain(`Task id: \`${data.callId}\`.`);
      process.runs.active = null;
    });
  });

  it("does not announce IPC work superseded while its tick is scheduled", async () => {
    const pid = "mech-ipc-stale-start";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    await runInProcess(stub, async (process) => {
      const { promise: scheduleBlocked, resolve: releaseSchedule } = deferred();
      const { promise: scheduleStarted, resolve: markScheduleStarted } = deferred();
      process.sendSignal = vi.fn();
      process.run.scheduleTick = vi.fn(async (runId: string) => {
        if (runId === "ipc-run") {
          markScheduleStarted();
          await scheduleBlocked;
        }
      });

      const delivering = process.deliverEvent(ipcMessage({
        sourcePid: "source-process",
        source: ROOT_IDENTITY,
        message: "slow IPC admission",
      }, "ipc-run"));
      await scheduleStarted;

      const successor = await process.controller.admitInput({
        message: "new user direction",
        origin: { kind: "client", connectionId: "client-1" },
      }, crypto.randomUUID(), "interrupt");
      releaseSchedule();
      await delivering;

      const startedRunIds = process.sendSignal.mock.calls
        .filter(([signal]: [string]) => signal === "proc.run.started")
        .map(([, payload]: [string, { runId: string }]) => payload.runId);
      expect(startedRunIds).toEqual([successor.runId]);
      expect(process.runs.active).toMatchObject({ runId: successor.runId });
      process.runs.active = null;
    });
  });

  it("keeps IPC admission behind earlier background sends", async () => {
    const stub = await initProcess("mech-ipc-admission-order", ROOT_IDENTITY);

    await runInProcess(stub, async (process) => {
      process.run.scheduleTick = vi.fn(async () => {});
      process.sendSignal = vi.fn(async () => {});
      const releaseAdmission = await process.controller.acquireQueuedSendAdmission();
      const delivering = process.deliverEvent(ipcMessage({
        sourcePid: "source-process",
        source: ROOT_IDENTITY,
        message: "ordered IPC",
      }, "ipc-ordered-run"));
      await Promise.resolve();
      expect(process.runs.active).toBeNull();

      releaseAdmission();
      await expect(delivering).resolves.toEqual({ eventId: "ipc-ordered-run", runId: "ipc-ordered-run", queued: false });
      expect(process.runs.active).toMatchObject({ runId: "ipc-ordered-run" });
      process.runs.active = null;
    });
  });

  it("terminalizes IPC work when its first tick cannot be scheduled", async () => {
    const stub = await initProcess("mech-ipc-schedule-failure", ROOT_IDENTITY);

    await runInProcess(stub, async (process) => {
      process.run.scheduleTick = vi.fn(async () => {
        throw new Error("scheduler unavailable");
      });
      process.sendSignal = vi.fn(async () => {});

      await expect(
        process.deliverEvent(ipcMessage({
          sourcePid: "source-process",
          source: ROOT_IDENTITY,
          message: "must not strand",
        }, "ipc-unscheduled-run")),
      ).resolves.toMatchObject({ runId: "ipc-unscheduled-run" });

      await vi.waitFor(() => expect(process.runs.active).toBeNull());
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
});
