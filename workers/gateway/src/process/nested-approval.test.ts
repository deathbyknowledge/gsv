import { describe, expect, it, vi } from "vitest";
import type { Process } from "./do";
import type { ProcessToolAuthorizeArgs } from "../protocol/process-frames";
import { DEFAULT_TOOL_APPROVAL_POLICY } from "./approval";
import {
  approvedRun, initProcess, offeredTools, ROOT_IDENTITY, runInProcess, terminalTestConfig,
} from "./do-test-harness";

function prepareShell(process: Process): void {
  process.runs.active = approvedRun("run", {
    config: { ...terminalTestConfig(process.pid), capabilities: ["*"] },
    approvalPolicy: {
      ...DEFAULT_TOOL_APPROVAL_POLICY,
      rules: [{ match: "fs.transfer.receive", target: "targets/*", action: "ask" }, ...DEFAULT_TOOL_APPROVAL_POLICY.rules],
    },
    tools: offeredTools("Shell"), offeredToolNames: ["Shell"],
  });
  process.store.tools.register("shell", "call", "run", "shell.exec", { input: "cp /tmp/a laptop:/tmp/a" }, "Copy the report");
  process.store.tools.markDispatched("shell");
  vi.spyOn(process, "sendSignal").mockResolvedValue(undefined);
  vi.spyOn(process.run, "scheduleTick").mockResolvedValue(undefined);
}

describe("approval beneath a native command", () => {
  it("asks about the actual destination and approves the offered Shell owner", async () => {
    const stub = await initProcess("nested-shell-approve", ROOT_IDENTITY);
    await runInProcess(stub, async (process: Process) => {
      prepareShell(process);
      const waiting = process.tools.authorizeNestedTool({
        runId: "run", requestId: "shell", syscall: "fs.transfer.receive",
        args: { target: "laptop", path: "/tmp/a" },
      }, new AbortController().signal);
      const pending = process.store.tools.getPendingHil()!;
      expect(pending).toMatchObject({ ownerDispatchId: "shell", syscall: "fs.transfer.receive", purpose: "Copy the report" });
      expect(await process.controller.handleProcHil({ requestId: pending.requestId, decision: "approve" })).toMatchObject({ ok: true });
      expect(await waiting).toBe(true);
      process.runs.active = null;
    });
  });

  it("cancels the approval with its owning operation and rejects late approval", async () => {
    const stub = await initProcess("nested-shell-cancel", ROOT_IDENTITY);
    await runInProcess(stub, async (process: Process) => {
      prepareShell(process);
      const controller = new AbortController();
      const waiting = process.tools.authorizeNestedTool({
        runId: "run", requestId: "shell", syscall: "mail.send", args: { to: "example@example.invalid", text: "Hello" },
      }, controller.signal);
      const pending = process.store.tools.getPendingHil()!;
      const rejection = expect(waiting).rejects.toThrow("cancelled");
      controller.abort(new Error("cancelled"));
      await rejection;
      expect(process.store.tools.getPendingHil()).toBeNull();
      expect(await process.controller.handleProcHil({ requestId: pending.requestId, decision: "approve" })).toMatchObject({ ok: false });
      process.runs.active = null;
    });
  });

  it("rejects an unowned request and a completed tool even for automatic operations", async () => {
    const stub = await initProcess("nested-shell-stale", ROOT_IDENTITY);
    await runInProcess(stub, async (process: Process) => {
      prepareShell(process);
      const args: ProcessToolAuthorizeArgs = { runId: "run", requestId: "missing", syscall: "fs.read", args: { target: "gsv", path: "/tmp/a" } };
      await expect(process.tools.authorizeNestedTool(args, new AbortController().signal)).rejects.toThrow("no longer active");
      process.store.tools.resolve("shell", "done");
      await expect(process.tools.authorizeNestedTool({ ...args, requestId: "shell" }, new AbortController().signal)).rejects.toThrow("no longer active");
      process.runs.active = null;
    });
  });

  it("asks for future executable work without changing ordinary reminder defaults", async () => {
    const stub = await initProcess("nested-shell-schedule", ROOT_IDENTITY);
    await runInProcess(stub, async (process: Process) => {
      prepareShell(process);
      const signal = new AbortController().signal;
      expect(await process.tools.authorizeNestedTool({ runId: "run", requestId: "shell", syscall: "sched.add", args: {} }, signal)).toBe(true);
      const waiting = process.tools.authorizeNestedTool({ runId: "run", requestId: "shell", syscall: "sched.add", args: {}, defaultAction: "ask" }, signal);
      const pending = process.store.tools.getPendingHil()!;
      expect(pending.syscall).toBe("sched.add");
      process.tools.resolveCodeModeApproval(pending.requestId, false);
      expect(await waiting).toBe(false);
      process.runs.active = null;
    });
  });
});
