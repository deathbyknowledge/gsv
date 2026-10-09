import { describe, expect, it, vi } from "vitest";
import type { ProcessApprovalTarget } from "../protocol/process-frames";
import type { Process } from "./do";
import { DEFAULT_TOOL_APPROVAL_POLICY } from "./approval";
import { approvedRun, initProcess, offeredTools, ROOT_IDENTITY, runInProcess, terminalTestConfig } from "./do-test-harness";

const cloud: ProcessApprovalTarget = {
  targetId: "browser", ownerUid: 1000, platform: "browser", route: { kind: "instance", instanceId: "instance" },
};
const personal: ProcessApprovalTarget = { ...cloud, route: { kind: "machine", targetId: "browser" } };

describe("cloud browser approval admission", () => {
  it.each(["cloud", "personal", "unavailable"].flatMap(kind => ["start", "cached", "uncertain"].map(mode => ({ kind, mode }))))(
    "admits a $kind browser through the owning policy (mode=$mode)", async ({ kind, mode }) => {
      const stub = await initProcess(`browser-approval-${kind}-${mode}`, ROOT_IDENTITY);
      await runInProcess(stub, async (process: Process) => {
        process.runs.active = approvedRun("run", {
          config: { ...terminalTestConfig(process.pid), capabilities: ["shell.exec"] },
          approvalPolicy: DEFAULT_TOOL_APPROVAL_POLICY,
          tools: offeredTools("Shell"), offeredToolNames: ["Shell"],
        });
        const args = mode !== "start" ? { sessionId: "session", input: "" } : { target: "browser", input: "page snapshot" };
        if (mode === "cached") process.tools.rememberShellSessionTargetFromResult("shell.exec", { target: "browser" }, { sessionId: "session" });
        process.store.tools.register("shell", "call", "run", "shell.exec", args);
        const resolve = vi.spyOn(process.kernel, "resolveApprovalTarget");
        if (kind === "unavailable") resolve.mockRejectedValue(new Error("Approval lookup unavailable"));
        else resolve.mockResolvedValue(kind === "cloud" ? cloud : personal);
        const launch = vi.spyOn(process.tools, "launchToolDispatch").mockImplementation(() => {});
        vi.spyOn(process, "sendSignal").mockResolvedValue(undefined);
        vi.spyOn(process.signals, "toolStarted").mockResolvedValue(undefined);
        vi.spyOn(process.run, "schedule").mockResolvedValue(undefined);
        const approval = await process.tools.processToolCalls("run");
        expect(resolve).toHaveBeenCalledWith(mode === "uncertain" ? { sessionId: "session" } : { targetId: "browser" }, expect.any(AbortSignal));
        if (kind === "cloud") {
          expect(approval).toBeNull();
          expect(launch).toHaveBeenCalledWith("run", "shell", "shell.exec", { ...args, target: "browser" },
            DEFAULT_TOOL_APPROVAL_POLICY, undefined, cloud);
        } else {
          expect(launch).not.toHaveBeenCalled();
          if (kind === "personal") expect(approval).toMatchObject({ syscall: "shell.exec", args: { ...args, target: "browser" } });
          else expect(process.store.tools.getResults("run")[0]).toMatchObject({ status: "error", error: expect.stringContaining("Approval lookup unavailable") });
        }
        process.store.tools.clearPendingHil();
        process.runs.active = null;
      });
    });

  it("rejects a session only after consulting the Kernel", async () => {
    const stub = await initProcess("browser-approval-unknown-session", ROOT_IDENTITY);
    await runInProcess(stub, async (process: Process) => {
      process.runs.active = approvedRun("run", {
        config: terminalTestConfig(process.pid), approvalPolicy: DEFAULT_TOOL_APPROVAL_POLICY,
        tools: offeredTools("Shell"), offeredToolNames: ["Shell"],
      });
      process.store.tools.register("shell", "call", "run", "shell.exec", { sessionId: "unknown", input: "" });
      const resolve = vi.spyOn(process.kernel, "resolveApprovalTarget").mockRejectedValue(new Error("Unknown shell session"));
      const launch = vi.spyOn(process.tools, "launchToolDispatch").mockImplementation(() => {});
      expect(await process.tools.processToolCalls("run")).toBeNull();
      expect(resolve).toHaveBeenCalledWith({ sessionId: "unknown" }, expect.any(AbortSignal));
      expect(launch).not.toHaveBeenCalled();
      expect(process.store.tools.getResults("run")[0]).toMatchObject({ status: "error", error: expect.stringContaining("session") });
      process.runs.active = null;
    });
  });

  it("recovers a session-only CodeMode poll from Kernel state", async () => {
    const stub = await initProcess("codemode-uncertain-session", ROOT_IDENTITY);
    await runInProcess(stub, async (process: Process) => {
      process.runs.active = approvedRun("run", { config: terminalTestConfig(process.pid) });
      const resolve = vi.spyOn(process.kernel, "resolveApprovalTarget").mockResolvedValue(cloud);
      const dispatch = vi.spyOn(process.tools, "dispatchCodeModeSyscall").mockResolvedValue({ type: "res", id: "poll", ok: true, data: { status: "completed", output: "done" } });
      const signal = new AbortController().signal;
      await process.tools.executeCodeModeSyscall({ runId: "run", dispatchId: "codemode", approvalPolicy: DEFAULT_TOOL_APPROVAL_POLICY, capabilities: ["shell.exec"] },
        "shell.exec", { sessionId: "uncertain", input: "" }, signal);
      expect(resolve).toHaveBeenCalledOnce();
      expect(resolve).toHaveBeenCalledWith({ sessionId: "uncertain" }, signal);
      expect(dispatch).toHaveBeenCalledWith("run", expect.any(String), "shell.exec", { sessionId: "uncertain", input: "", target: "browser" }, signal, "codemode", cloud);
      process.runs.active = null;
    });
  });

  it("skips discovery for explicit policies and never dispatches a cancelled lookup", async () => {
    const stub = await initProcess("browser-approval-cancel", ROOT_IDENTITY);
    await runInProcess(stub, async (process: Process) => {
      const resolve = vi.spyOn(process.kernel, "resolveApprovalTarget");
      expect(await process.tools.resolveApproval({ default: "ask", rules: [] }, "shell.exec", { target: "browser" })).toMatchObject({ action: "ask" });
      expect(resolve).not.toHaveBeenCalled();
      const restricted = { default: "auto" as const, rules: [{ match: "shell.exec", target: { route: "instance" as const, platform: "browser" }, action: "deny" as const }] };
      resolve.mockRejectedValueOnce(new Error("Target unavailable for tool approval"));
      await expect(process.tools.resolveApproval(restricted, "shell.exec", { target: "browser" })).rejects.toThrow("Target unavailable");
      resolve.mockResolvedValueOnce(personal);
      expect(await process.tools.resolveApproval(restricted, "shell.exec", { target: "browser" })).toMatchObject({ action: "auto", approvedTarget: personal });
      process.runs.active = approvedRun("run", {
        config: terminalTestConfig(process.pid), approvalPolicy: DEFAULT_TOOL_APPROVAL_POLICY,
        tools: offeredTools("Shell"), offeredToolNames: ["Shell"],
      });
      process.store.tools.register("shell", "call", "run", "shell.exec", { target: "browser", input: "page snapshot" });
      resolve.mockImplementation(async () => { process.runs.active = null; return cloud; });
      const launch = vi.spyOn(process.tools, "launchToolDispatch").mockImplementation(() => {});
      expect(await process.tools.processToolCalls("run")).toBeNull();
      expect(launch).not.toHaveBeenCalled();
      expect(process.store.tools.getPendingHil()).toBeNull();
    });
  });
});
