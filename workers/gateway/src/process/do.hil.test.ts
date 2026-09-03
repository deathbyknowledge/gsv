import { describe, expect, it, vi } from "vitest";
import {
  approvedRun, okProcessResponse, runInProcess, ROOT_IDENTITY, initProcess, makeReq, offeredTools,
  registerToolBlock,
} from "./do-test-harness";

describe("proc.hil", () => {
  it("rejects an unoffered approval and advances the remaining registered call", async () => {
    const runId = "run-hil-unoffered-batch";
    const stub = await initProcess("mech-hil-unoffered-batch", ROOT_IDENTITY);

    await runInProcess(stub, async (process) => {
      process.runs.active = approvedRun(runId, {
        tools: offeredTools("Read"),
        offeredToolNames: ["Read"]
      });
      process.sendSignal = vi.fn(async () => {});
      process.run.schedule = vi.fn(async () => {});
      process.run.scheduleTick = vi.fn(async () => {});
      process.kernel.dispatchSyscall = vi.fn(async (_runId: string, dispatchId: string) => {
        process.store.tools.resolve(dispatchId, "read completed");
      });
      process.store.tools.register(
        "dispatch-unoffered-shell",
        "unoffered-shell",
        runId,
        "shell.exec",
        { input: "cat /root/secret", target: "gsv" },
      );
      process.store.tools.register("dispatch-offered-read", "offered-read", runId, "fs.read", {
        path: "/root/allowed.txt",
      });
      process.store.tools.setPendingHil({
        requestId: "approval-unoffered-shell",
        runId,
        toolCallId: "unoffered-shell",
        toolName: "Shell",
        syscall: "shell.exec",
        args: { input: "cat /root/secret", target: "gsv" },
        createdAt: Date.now(),
      });

      await expect(
        process.controller.handleProcHil({
          requestId: "approval-unoffered-shell",
          decision: "approve",
        }),
      ).resolves.toEqual({
        ok: false,
        error: 'Tool "Shell" was not offered for this generation',
      });
      await vi.waitFor(() => {
        expect(process.kernel.dispatchSyscall).toHaveBeenCalledOnce();
      });
      expect(process.kernel.dispatchSyscall).toHaveBeenCalledWith(
        runId,
        "dispatch-offered-read",
        "fs.read",
        { path: "/root/allowed.txt" },
      );
      expect(process.store.tools.getResults(runId)).toMatchObject([
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

    await runInProcess(stub, async (process) => {
      const resolveApproval = vi.fn();
      process.runs.active = approvedRun(runId, {
        tools: offeredTools("Read"),
        offeredToolNames: ["Read"]
      });
      process.sendSignal = vi.fn(async () => {});
      process.run.schedule = vi.fn(async () => {});
      process.run.scheduleTick = vi.fn(async () => {});
      process.kernel.dispatchSyscall = vi.fn(async (_runId: string, dispatchId: string) => {
        process.store.tools.resolve(dispatchId, "read completed");
      });
      process.store.tools.register(
        "dispatch-unoffered-codemode",
        "unoffered-codemode",
        runId,
        "codemode.exec",
        { code: "return await fs.read({ path: '/root/secret' });" },
      );
      process.store.tools.markDispatched("dispatch-unoffered-codemode");
      process.store.tools.register(
        "dispatch-offered-read-after-codemode",
        "offered-read-after-codemode",
        runId,
        "fs.read",
        { path: "/root/allowed.txt" },
      );
      process.store.tools.setPendingHil({
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

      await expect(
        process.controller.handleProcHil({
          requestId: "approval-unoffered-codemode",
          decision: "approve",
        }),
      ).resolves.toEqual({
        ok: false,
        error: 'Tool "CodeMode" was not offered for this generation',
      });
      expect(resolveApproval).toHaveBeenCalledWith(false);
      await vi.waitFor(() => {
        expect(process.kernel.dispatchSyscall).toHaveBeenCalledOnce();
      });
      expect(process.kernel.dispatchSyscall).toHaveBeenCalledWith(
        runId,
        "dispatch-offered-read-after-codemode",
        "fs.read",
        { path: "/root/allowed.txt" },
      );
      expect(process.store.tools.getResults(runId)).toMatchObject([
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

    await runInProcess(stub, async (process) => {
      process.runs.active = {
        runId: "run-hil-1",
        approvalPolicy: {
          default: "auto",
          rules: [{ match: "fs.read", action: "ask" }],
        },
      };
      registerToolBlock(process, "run-hil-1", [
        {
          type: "toolCall",
          id: "call-hil-1",
          name: "Read",
          arguments: { path: "/root/secret.txt" },
        },
      ]);
      await process.tools.processToolCalls("run-hil-1");
    });

    const history = await okProcessResponse(stub, makeReq("proc.history", {}));

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

    await runInProcess(stub, (process) => {
      expect(process.store.tools.getPendingHilForRun("run-hil-1")).not.toBeNull();
      expect(process.store.tools.getPending("call-hil-1")).toBeNull();
    });
  });

  it("pauses a background process instead of converting approval into a tool error", async () => {
    const pid = "mech-hil-background";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    await runInProcess(stub, async (process) => {
      process.store.state.setValue("interactive", "0");
      process.runs.active = {
        runId: "run-hil-background",
        approvalPolicy: {
          default: "auto",
          rules: [{ match: "shell.exec", action: "ask" }],
        },
      };
      registerToolBlock(process, "run-hil-background", [
        {
          type: "toolCall",
          id: "call-hil-background",
          name: "Shell",
          arguments: { input: "date" },
        },
      ]);

      await expect(process.tools.processToolCalls("run-hil-background")).resolves.toMatchObject({
        runId: "run-hil-background",
        toolCallId: "call-hil-background",
      });
      expect(process.store.tools.getResults("run-hil-background")).toMatchObject([
        {
          id: "call-hil-background",
          status: "registered",
        },
      ]);
      expect(process.store.tools.getPendingHilForRun("run-hil-background")).not.toBeNull();
    });
  });

  it("exposes the normalized approval target rather than a legacy alias", async () => {
    const pid = "mech-hil-normalized-target";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    await runInProcess(stub, async (process) => {
      process.runs.active = {
        runId: "run-hil-normalized-target",
        approvalPolicy: {
          default: "auto",
          rules: [{ match: "shell.exec", action: "ask" }],
        },
      };
      registerToolBlock(process, "run-hil-normalized-target", [
        {
          type: "toolCall",
          id: "call-hil-normalized-target",
          name: "Shell",
          arguments: { input: "pwd", target: "gateway" },
        },
      ]);
      await process.tools.processToolCalls("run-hil-normalized-target");
    });

    const history = await okProcessResponse(stub, makeReq("proc.history", {}));

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

    const requestId = await runInProcess(stub, async (process) => {
      process.runs.active = {
        runId: "run-hil-2",
        approvalPolicy: {
          default: "auto",
          rules: [{ match: "fs.read", action: "ask" }],
        },
      };
      process.run.scheduleTick = vi.fn(async () => {});
      registerToolBlock(process, "run-hil-2", [
        {
          type: "toolCall",
          id: "call-hil-2",
          name: "Read",
          arguments: { path: "/root/secret.txt" },
        },
      ]);
      await process.tools.processToolCalls("run-hil-2");
      process.sendSignal = vi.fn(async () => {});
      return process.store.tools.getPendingHilForRun("run-hil-2").requestId;
    });

    const res = await okProcessResponse(
      stub,
      makeReq("proc.hil", { requestId, decision: "deny" }),
    );

    expect(res.ok).toBe(true);
    expect(res.data).toMatchObject({
      ok: true,
      pid,
      requestId,
      decision: "deny",
      resumed: true,
      pendingHil: null,
    });

    await runInProcess(stub, async (process) => {
      expect(process.store.tools.getPendingHil()).toBeNull();
      expect(process.store.tools.getResults("run-hil-2")).toMatchObject([
        {
          id: "call-hil-2",
          status: "error",
          error: "Tool execution denied by user",
          outcome: "denied",
        },
      ]);
      await process.tools.ingestToolResults(
        "run-hil-2",
        process.store.tools.getResults("run-hil-2"),
      );
      const toolResult = process.store.messages.getMessages().at(-1);
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

    const requestId = await runInProcess(stub, async (process) => {
      process.runs.active = {
        runId: "run-hil-exact-request",
        approvalPolicy: {
          default: "auto",
          rules: [{ match: "fs.delete", action: "ask" }],
        },
      };
      registerToolBlock(process, "run-hil-exact-request", [
        {
          type: "toolCall",
          id: "call-hil-exact-request",
          name: "Delete",
          arguments: { path: "/tmp/exact-request.txt" },
        },
      ]);
      await process.tools.processToolCalls("run-hil-exact-request");
      return process.store.tools.getPendingHilForRun("run-hil-exact-request").requestId;
    });

    const stale = await okProcessResponse(
      stub,
      makeReq("proc.hil", { requestId: `${requestId}-stale`, decision: "approve" }),
    );
    expect(stale.ok).toBe(true);
    expect(stale.data).toEqual({
      ok: false,
      error: `Pending tool confirmation not found: ${requestId}-stale`,
    });

    await runInProcess(stub, (process) => {
      expect(process.store.tools.getPendingHilForRun("run-hil-exact-request")).toMatchObject({
        requestId,
        runId: "run-hil-exact-request",
        toolCallId: "call-hil-exact-request",
      });
    });

    const exact = await okProcessResponse(
      stub,
      makeReq("proc.hil", { requestId, decision: "deny" }),
    );
    expect(exact.ok).toBe(true);
    expect(exact.data).toMatchObject({
      ok: true,
      pid,
      requestId,
      decision: "deny",
    });
  });

  it("classifies a denied CodeMode confirmation as a user-controlled outcome", async () => {
    const stub = await initProcess("mech-hil-codemode-deny", ROOT_IDENTITY);

    await runInProcess(stub, async (process) => {
      const runId = "run-hil-codemode-deny";
      const requestId = "approval-codemode-deny";
      const resolve = vi.fn();
      process.runs.active = approvedRun(runId);
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
      process.store.tools.markDispatched("dispatch-call-codemode-other");
      process.store.tools.markDispatched("dispatch-call-codemode-outer");
      process.store.tools.setPendingHil({
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

      await expect(
        process.controller.handleProcHil({ requestId, decision: "deny" }),
      ).resolves.toMatchObject({
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
      expect(process.store.tools.getResults(runId)).toMatchObject([
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
      process.store.tools.resolve("dispatch-call-codemode-other", {
        status: "completed",
        result: "still running",
      });
      await process.tools.ingestToolResults(runId, process.store.tools.getResults(runId));
      const outcomes = process.store.messages
        .getMessages()
        .filter((message: any) => message.role === "toolResult")
        .map((message: any) => JSON.parse(message.toolCalls).outcome);
      expect(outcomes).toEqual(["completed", "denied"]);
    });
  });

  it("resumes a sole CodeMode run once after denying its nested approval", async () => {
    const pid = "mech-hil-codemode-sole-deny";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    await runInProcess(stub, async (process) => {
      const runId = "run-hil-codemode-sole-deny";
      const requestId = "approval-codemode-sole-deny";
      const resolve = vi.fn();
      process.runs.active = approvedRun(runId);
      registerToolBlock(process, runId, [
        {
          id: "call-codemode-sole",
          name: "CodeMode",
          arguments: { code: "return await fs.read({ path: '/secret' });" },
        },
      ]);
      process.store.tools.markDispatched("dispatch-call-codemode-sole");
      process.store.tools.setPendingHil({
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
      process.run.schedule = vi.fn(async () => ({ id: "resume-codemode-sole" }));
      process.sendSignal = vi.fn(async () => {});

      await process.controller.handleProcHil({ requestId, decision: "deny" });

      expect(resolve).toHaveBeenCalledWith(false);
      expect(process.store.tools.getPendingHil()).toBeNull();
      expect(process.store.tools.getResults(runId)).toMatchObject([
        {
          id: "call-codemode-sole",
          status: "error",
          outcome: "denied",
        },
      ]);
      expect(process.run.schedule).toHaveBeenCalledTimes(1);
      expect(process.run.schedule).toHaveBeenCalledWith(
        expect.any(Date),
        "tick",
        { runId, generation: 0 },
        { idempotent: true },
      );
      expect(process.sendSignal).toHaveBeenCalledWith("proc.run.tool.finished", {
        pid,
        runId,
        executionId: "dispatch-call-codemode-sole",
        callId: "call-codemode-sole",
        outcome: "denied",
        timestamp: expect.any(Number),
      });
      process.store.tools.clearPendingToolCalls();
      process.runs.active = null;
    });
  });

  it("does not infer a user denial from a live tool error message", async () => {
    const stub = await initProcess("mech-tool-error-denial-text", ROOT_IDENTITY);

    await runInProcess(stub, async (process) => {
      const runId = "run-tool-error-denial-text";
      process.store.tools.register(
        "dispatch-tool-error-denial-text",
        "call-tool-error-denial-text",
        runId,
        "fs.read",
        { path: "/provider" },
      );
      process.store.tools.fail(
        "dispatch-tool-error-denial-text",
        "Tool execution denied by user",
      );

      expect(process.store.tools.getResults(runId)[0].outcome).toBe("failed");
      await process.tools.ingestToolResults(runId, process.store.tools.getResults(runId));
      const toolResult = process.store.messages.getMessages().at(-1);
      expect(JSON.parse(toolResult.toolCalls).outcome).toBe("failed");
    });
  });

  it("remembers approved tool confirmations for the process", async () => {
    const pid = "mech-hil-remember";
    const stub = await initProcess(pid, ROOT_IDENTITY);

    const requestId = await runInProcess(stub, async (process) => {
      process.runs.active = {
        runId: "run-hil-remember",
        approvalPolicy: {
          default: "auto",
          rules: [{ match: "fs.read", action: "ask" }],
        },
      };
      registerToolBlock(process, "run-hil-remember", [
        {
          type: "toolCall",
          id: "call-hil-remember-1",
          name: "Read",
          arguments: { path: "/root/one.txt" },
        },
        {
          type: "toolCall",
          id: "call-hil-remember-2",
          name: "Read",
          arguments: { path: "/root/two.txt" },
        },
      ]);
      await process.tools.processToolCalls("run-hil-remember");
      return process.store.tools.getPendingHilForRun("run-hil-remember").requestId;
    });

    const res = await okProcessResponse(
      stub,
      makeReq("proc.hil", { requestId, decision: "approve", remember: true }),
    );

    expect(res.ok).toBe(true);
    expect(res.data).toMatchObject({
      ok: true,
      pid,
      requestId,
      decision: "approve",
      remembered: true,
      pendingHil: null,
    });

    await runInProcess(stub, (process) => {
      expect(process.store.tools.getPendingHil()).toBeNull();
      expect(JSON.parse(process.store.state.getValue("toolApprovalOverrides"))).toEqual([
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

    await runInProcess(stub, async (process) => {
      const runId = "run-hil-approved-execution";
      process.runs.active = {
        runId,
        approvalPolicy: {
          default: "auto",
          rules: [{ match: "fs.read", action: "ask" }],
        },
      };
      process.sendSignal = vi.fn(async () => {});
      process.run.schedule = vi.fn(async () => ({ id: "tool-lifecycle" }));
      process.tools.launchToolDispatch = vi.fn();
      registerToolBlock(process, runId, [
        {
          type: "toolCall",
          id: "call-hil-approved-execution",
          name: "Read",
          arguments: { path: "/private/input" },
        },
      ]);
      await process.tools.processToolCalls(runId);
      const requestId = process.store.tools.getPendingHilForRun(runId).requestId;

      await process.controller.handleProcHil({ requestId, decision: "approve" });
      await process.tools.resolveStartedTool(
        runId,
        "dispatch-call-hil-approved-execution",
        "private output",
      );

      expect(process.tools.launchToolDispatch).toHaveBeenCalledWith(
        runId,
        "dispatch-call-hil-approved-execution",
        "fs.read",
        { path: "/private/input" },
        process.runs.active.approvalPolicy,
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
      expect(process.sendSignal).toHaveBeenCalledWith("proc.run.tool.finished", {
        pid,
        runId,
        executionId: "dispatch-call-hil-approved-execution",
        callId: "call-hil-approved-execution",
        outcome: "completed",
        timestamp: expect.any(Number),
      });
      process.store.tools.clearPendingToolCalls();
      process.runs.active = null;
    });
  });

  it("terminalizes CodeMode approval state whose continuation was lost", async () => {
    const stub = await initProcess("mech-hil-codemode-recovery", ROOT_IDENTITY);

    await runInProcess(stub, async (process) => {
      const runId = "run-hil-codemode-recovery";
      process.runs.active = approvedRun(runId);
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
      process.store.tools.markDispatched("dispatch-call-codemode-other");
      process.store.tools.markDispatched("dispatch-call-codemode-outer");
      process.store.tools.setPendingHil({
        requestId: "approval-lost",
        runId,
        ownerDispatchId: "dispatch-call-codemode-outer",
        toolCallId: "codemode-nested-call",
        toolName: "Read",
        syscall: "fs.read",
        args: { path: "/lost" },
        createdAt: Date.now(),
      });
      process.run.schedule = vi.fn(async () => ({ id: "recovery-tick" }));
      process.sendSignal = vi.fn(async () => {});

      await expect(
        process.controller.handleProcHil({
          requestId: "approval-lost",
          decision: "approve",
        }),
      ).resolves.toEqual({
        ok: false,
        error: "CodeMode execution was interrupted while waiting for tool approval",
      });

      expect(process.store.tools.getPendingHil()).toBeNull();
      expect(process.store.tools.getResults(runId)).toMatchObject([
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
      expect(process.run.schedule).not.toHaveBeenCalled();
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
