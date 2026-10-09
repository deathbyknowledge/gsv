import { describe, expect, it, vi } from "vitest";
import type { Process } from "./do";
import { DEFAULT_TOOL_APPROVAL_POLICY } from "./approval";
import { approvedRun, initProcess, offeredTools, ROOT_IDENTITY, runInProcess, terminalTestConfig } from "./do-test-harness";

describe("cloud browser approval admission", () => {
  it.each(["cloud", "personal", "unavailable"])("admits a %s browser through the owning policy", async kind => {
    const stub = await initProcess(`browser-approval-${kind}`, ROOT_IDENTITY);
    await runInProcess(stub, async (process: Process) => {
      process.runs.active = approvedRun("run", {
        config: { ...terminalTestConfig(process.pid), capabilities: ["shell.exec"] },
        approvalPolicy: DEFAULT_TOOL_APPROVAL_POLICY,
        tools: offeredTools("Shell"), offeredToolNames: ["Shell"],
      });
      process.store.tools.register("shell", "call", "run", "shell.exec", { target: "browser", input: "page snapshot" });
      const resolve = vi.spyOn(process.kernel, "resolveApprovalTarget");
      if (kind === "unavailable") resolve.mockRejectedValue(new Error("Approval lookup unavailable"));
      else resolve.mockResolvedValue(kind === "cloud" ? { kind: "cloud-browser", instanceId: "instance" } : { kind: "other" });
      const launch = vi.spyOn(process.tools, "launchToolDispatch").mockImplementation(() => {});
      vi.spyOn(process, "sendSignal").mockResolvedValue(undefined);
      vi.spyOn(process.signals, "toolStarted").mockResolvedValue(undefined);
      vi.spyOn(process.run, "schedule").mockResolvedValue(undefined);
      const approval = await process.tools.processToolCalls("run");
      if (kind === "cloud") {
        expect(approval).toBeNull();
        expect(launch).toHaveBeenCalledWith("run", "shell", "shell.exec", { target: "browser", input: "page snapshot" },
          DEFAULT_TOOL_APPROVAL_POLICY, undefined, { kind: "cloud-browser", instanceId: "instance" });
      } else {
        expect(launch).not.toHaveBeenCalled();
        if (kind === "personal") expect(approval).toMatchObject({ syscall: "shell.exec" });
        else expect(process.store.tools.getResults("run")[0]).toMatchObject({ status: "error", error: expect.stringContaining("Approval lookup unavailable") });
      }
      process.store.tools.clearPendingHil();
      process.runs.active = null;
    });
  });

  it("skips discovery for explicit policies and never dispatches a cancelled lookup", async () => {
    const stub = await initProcess("browser-approval-cancel", ROOT_IDENTITY);
    await runInProcess(stub, async (process: Process) => {
      const resolve = vi.spyOn(process.kernel, "resolveApprovalTarget");
      expect(await process.tools.resolveApproval({ default: "ask", rules: [] }, "shell.exec", { target: "browser" })).toMatchObject({ action: "ask" });
      expect(resolve).not.toHaveBeenCalled();
      const restricted = { default: "auto" as const, rules: [{ match: "shell.exec", target: "cloud-browsers/*", action: "deny" as const }] };
      resolve.mockRejectedValueOnce(new Error("Target unavailable for tool approval"));
      await expect(process.tools.resolveApproval(restricted, "shell.exec", { target: "browser" })).rejects.toThrow("Target unavailable");
      resolve.mockResolvedValueOnce({ kind: "other" });
      expect(await process.tools.resolveApproval(restricted, "shell.exec", { target: "browser" })).toMatchObject({ action: "auto", approvedTarget: { kind: "other" } });
      process.runs.active = approvedRun("run", {
        config: terminalTestConfig(process.pid), approvalPolicy: DEFAULT_TOOL_APPROVAL_POLICY,
        tools: offeredTools("Shell"), offeredToolNames: ["Shell"],
      });
      process.store.tools.register("shell", "call", "run", "shell.exec", { target: "browser", input: "page snapshot" });
      resolve.mockImplementation(async () => { process.runs.active = null; return { kind: "cloud-browser", instanceId: "instance" }; });
      const launch = vi.spyOn(process.tools, "launchToolDispatch").mockImplementation(() => {});
      expect(await process.tools.processToolCalls("run")).toBeNull();
      expect(launch).not.toHaveBeenCalled();
      expect(process.store.tools.getPendingHil()).toBeNull();
    });
  });
});
