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
  it.each(["cloud", "personal", "unavailable"].flatMap(kind => [false, true].map(poll => ({ kind, poll }))))(
    "admits a $kind browser through the owning policy (poll=$poll)", async ({ kind, poll }) => {
      const stub = await initProcess(`browser-approval-${kind}-${poll}`, ROOT_IDENTITY);
      await runInProcess(stub, async (process: Process) => {
        process.runs.active = approvedRun("run", {
          config: { ...terminalTestConfig(process.pid), capabilities: ["shell.exec"] },
          approvalPolicy: DEFAULT_TOOL_APPROVAL_POLICY,
          tools: offeredTools("Shell"), offeredToolNames: ["Shell"],
        });
        const args = poll ? { sessionId: "session", input: "" } : { target: "browser", input: "page snapshot" };
        if (poll) process.tools.rememberShellSessionTargetFromResult("shell.exec", { target: "browser" }, { sessionId: "session" });
        process.store.tools.register("shell", "call", "run", "shell.exec", args);
        const resolve = vi.spyOn(process.kernel, "resolveApprovalTarget");
        if (kind === "unavailable") resolve.mockRejectedValue(new Error("Approval lookup unavailable"));
        else resolve.mockResolvedValue(kind === "cloud" ? cloud : personal);
        const launch = vi.spyOn(process.tools, "launchToolDispatch").mockImplementation(() => {});
        vi.spyOn(process, "sendSignal").mockResolvedValue(undefined);
        vi.spyOn(process.signals, "toolStarted").mockResolvedValue(undefined);
        vi.spyOn(process.run, "schedule").mockResolvedValue(undefined);
        const approval = await process.tools.processToolCalls("run");
        expect(resolve).toHaveBeenCalledWith("browser", expect.any(AbortSignal));
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

  it("rejects an unknown shell session before target lookup or dispatch", async () => {
    const stub = await initProcess("browser-approval-unknown-session", ROOT_IDENTITY);
    await runInProcess(stub, async (process: Process) => {
      process.runs.active = approvedRun("run", {
        config: terminalTestConfig(process.pid), approvalPolicy: DEFAULT_TOOL_APPROVAL_POLICY,
        tools: offeredTools("Shell"), offeredToolNames: ["Shell"],
      });
      process.store.tools.register("shell", "call", "run", "shell.exec", { sessionId: "unknown", input: "" });
      const resolve = vi.spyOn(process.kernel, "resolveApprovalTarget");
      const launch = vi.spyOn(process.tools, "launchToolDispatch").mockImplementation(() => {});
      expect(await process.tools.processToolCalls("run")).toBeNull();
      expect(resolve).not.toHaveBeenCalled();
      expect(launch).not.toHaveBeenCalled();
      expect(process.store.tools.getResults("run")[0]).toMatchObject({ status: "error", error: expect.stringContaining("session") });
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
