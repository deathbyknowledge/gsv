import { describe, expect, it } from "vitest";
import type { ConsoleProcess } from "../../../domain/system/consoleModels";
import { delegatedApprovalProcesses } from "./DelegatedApprovals";

function process(pid: string, parentPid: string | null, overrides: Partial<ConsoleProcess> = {}): ConsoleProcess {
  return { pid, parentPid, uid: 1000, label: pid, username: "algo", profile: "", cwd: "/home/algo",
    personal: false, interactive: false, state: "waiting_hil", rawState: "waiting_hil", activeRunId: `${pid}-run`,
    queuedCount: 0, createdAt: 1, lastActiveAt: 1, ...overrides };
}

describe("Ship pending approvals", () => {
  const processes = [
    process("ship", null, { personal: true, state: "idle", activeRunId: null }),
    process("parent", "ship", { state: "idle", activeRunId: null }),
    process("child", "parent"),
    process("older-work", "replaced-ship"),
    process("other-owner", "ship", { uid: 2000 }),
    process("finished", "ship", { state: "idle", activeRunId: null }),
  ];

  it("shows pending child work even when Ship is idle, including work from an older Ship process", () => {
    expect(delegatedApprovalProcesses(processes, "ship").map(({ pid }) => pid)).toEqual(["child", "older-work"]);
  });

  it("scopes a helper to its descendants and never mixes owners from an administrator's list", () => {
    expect(delegatedApprovalProcesses(processes, "parent").map(({ pid }) => pid)).toEqual(["child"]);
    expect(delegatedApprovalProcesses(processes, "missing")).toEqual([]);
    expect(delegatedApprovalProcesses([process("unknown-owner", null, { uid: null, personal: true }), ...processes], "unknown-owner")).toEqual([]);
  });

  it("removes cancelled requests and rejects broken or cyclic ancestry", () => {
    const cancelled = processes.map((entry) => entry.pid === "child" ? { ...entry, activeRunId: null } : entry);
    expect(delegatedApprovalProcesses(cancelled, "parent")).toEqual([]);
    expect(delegatedApprovalProcesses([process("a", "b"), process("b", "a"), process("c", null)], "c")).toEqual([]);
  });
});
