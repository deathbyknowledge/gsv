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
  vi.spyOn(process.kernel, "readApprovalPolicy").mockImplementation(async () => JSON.stringify(process.runs.active?.approvalPolicy));
}

/** Asking reads the owner's current policy first, so the prompt appears a moment later. */
function pendingApproval(process: Process) {
  return vi.waitFor(() => {
    const pending = process.store.tools.getPendingHil();
    if (!pending) throw new Error("No approval is pending yet");
    return pending;
  });
}

describe("approval beneath a native command", () => {
  it("uses the Kernel's target metadata for nested commands and still enforces capabilities", async () => {
    const stub = await initProcess("nested-cloud-browser", ROOT_IDENTITY);
    await runInProcess(stub, async (process: Process) => {
      prepareShell(process);
      const request: ProcessToolAuthorizeArgs = {
        runId: "run", requestId: "shell", syscall: "fs.write",
        args: { target: "cloud", path: "/tmp/report.txt", content: "report" },
        target: { targetId: "cloud", ownerUid: 1000, platform: "browser", route: { kind: "instance", instanceId: "instance" } },
      };
      const signal = new AbortController().signal;
      expect(await process.tools.authorizeNestedTool(request, signal)).toBe(true);
      expect(process.store.tools.getPendingHil()).toBeNull();
      const run = process.runs.active!;
      run.config!.capabilities = ["fs.read"];
      process.runs.active = run;
      await expect(process.tools.authorizeNestedTool(request, signal)).rejects.toThrow("Permission denied");
      process.runs.active = null;
    });
  });

  it("keeps a search target's approval beneath its owning Shell call", async () => {
    const stub = await initProcess("nested-shell-search", ROOT_IDENTITY);
    await runInProcess(stub, async (process: Process) => {
      prepareShell(process);
      const run = process.runs.active!;
      run.approvalPolicy!.rules.unshift(
        { match: "web.search", target: "gsv", action: "auto" },
        { match: "web.search", target: "targets/*", action: "ask" },
      );
      process.runs.active = run;
      const signal = new AbortController().signal;
      const request: ProcessToolAuthorizeArgs = {
        runId: "run", requestId: "shell", syscall: "web.search", args: { target: "gsv", query: "news" },
      };
      expect(await process.tools.authorizeNestedTool(request, signal)).toBe(true);
      const waiting = process.tools.authorizeNestedTool({ ...request, args: { target: "personal-search", query: "news" } }, signal);
      const pending = await pendingApproval(process);
      expect(pending).toMatchObject({ ownerDispatchId: "shell", syscall: "web.search" });
      process.tools.resolveCodeModeApproval(pending.requestId, false);
      expect(await waiting).toBe(false);
      process.runs.active = null;
    });
  });

  it("asks about the actual destination and approves the offered Shell owner", async () => {
    const stub = await initProcess("nested-shell-approve", ROOT_IDENTITY);
    await runInProcess(stub, async (process: Process) => {
      prepareShell(process);
      const waiting = process.tools.authorizeNestedTool({
        runId: "run", requestId: "shell", syscall: "fs.transfer.receive",
        args: { target: "laptop", path: "/tmp/a" },
      }, new AbortController().signal);
      const pending = await pendingApproval(process);
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
      const pending = await pendingApproval(process);
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

  it("asks before scheduling a command, as a default rule", async () => {
    const stub = await initProcess("nested-shell-schedule", ROOT_IDENTITY);
    await runInProcess(stub, async (process: Process) => {
      prepareShell(process);
      const signal = new AbortController().signal;
      const waiting = process.tools.authorizeNestedTool({ runId: "run", requestId: "shell", syscall: "sched.add", args: {} }, signal);
      const pending = await pendingApproval(process);
      expect(pending.syscall).toBe("sched.add");
      process.tools.resolveCodeModeApproval(pending.requestId, false);
      expect(await waiting).toBe(false);
      process.runs.active = null;
    });
  });

  it("reads the owner's current policy before asking, so an allow from another process applies", async () => {
    const stub = await initProcess("nested-shell-fresh-allow", ROOT_IDENTITY);
    await runInProcess(stub, async (process: Process) => {
      prepareShell(process);
      vi.spyOn(process.kernel, "readApprovalPolicy").mockResolvedValue(JSON.stringify({
        default: "auto",
        rules: [{ match: "sched.add", target: "gsv", action: "auto" }, ...DEFAULT_TOOL_APPROVAL_POLICY.rules],
      }));
      const signal = new AbortController().signal;
      expect(await process.tools.authorizeNestedTool({ runId: "run", requestId: "shell", syscall: "sched.add", args: {} }, signal)).toBe(true);
      expect(process.store.tools.getPendingHil()).toBeNull();
      expect(process.runs.active?.approvalPolicy?.rules[0]).toEqual({ match: "sched.add", target: "gsv", action: "auto" });
      process.runs.active = null;
    });
  });

  it("still asks when the owner's current policy cannot be read", async () => {
    const stub = await initProcess("nested-shell-unread-policy", ROOT_IDENTITY);
    await runInProcess(stub, async (process: Process) => {
      prepareShell(process);
      vi.spyOn(process.kernel, "readApprovalPolicy").mockRejectedValue(new Error("Kernel unavailable"));
      const signal = new AbortController().signal;
      const waiting = process.tools.authorizeNestedTool({ runId: "run", requestId: "shell", syscall: "sched.add", args: {} }, signal);
      const pending = await pendingApproval(process);
      expect(pending.syscall).toBe("sched.add");
      process.tools.resolveCodeModeApproval(pending.requestId, false);
      expect(await waiting).toBe(false);
      process.runs.active = null;
    });
  });
});

describe("approval the Kernel decides itself", () => {
  function prepareCodeMode(process: Process) {
    process.runs.active = approvedRun("run", { config: terminalTestConfig(process.pid) });
    vi.spyOn(process, "sendSignal").mockResolvedValue(undefined);
    vi.spyOn(process.kernel, "readApprovalPolicy").mockResolvedValue(JSON.stringify(DEFAULT_TOOL_APPROVAL_POLICY));
    return vi.spyOn(process.tools, "dispatchCodeModeSyscall").mockResolvedValue({ type: "res", id: "sched", ok: true, data: { id: "s1" } });
  }

  it("lets CodeMode set a message reminder without asking, leaving commands to the Kernel's check", async () => {
    const stub = await initProcess("codemode-reminder", ROOT_IDENTITY);
    await runInProcess(stub, async (process: Process) => {
      const dispatch = prepareCodeMode(process);
      const reminder = { expression: { kind: "at", at: "2030-01-01T09:00:00Z" }, target: { kind: "message", text: "Stretch" } };
      await process.tools.executeCodeModeSyscall(
        { runId: "run", dispatchId: "codemode", approvalPolicy: DEFAULT_TOOL_APPROVAL_POLICY, capabilities: ["*"] },
        "sched.add", reminder, new AbortController().signal,
      );
      expect(process.store.tools.getPendingHil()).toBeNull();
      expect(dispatch).toHaveBeenCalledOnce();
      process.runs.active = null;
    });
  });

  it("still refuses a call the owner blocked", async () => {
    const stub = await initProcess("codemode-reminder-blocked", ROOT_IDENTITY);
    await runInProcess(stub, async (process: Process) => {
      const dispatch = prepareCodeMode(process);
      const blocked = { default: "auto" as const, rules: [{ match: "sched.add", action: "deny" as const }] };
      await expect(process.tools.executeCodeModeSyscall(
        { runId: "run", dispatchId: "codemode", approvalPolicy: blocked, capabilities: ["*"] },
        "sched.add", {}, new AbortController().signal,
      )).rejects.toThrow("denied by policy");
      expect(dispatch).not.toHaveBeenCalled();
      process.runs.active = null;
    });
  });
});
