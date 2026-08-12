import { describe, expect, it } from "vitest";
import type {
  ProcHistoryResult,
  ProcListEntry,
} from "@humansandmachines/gsv/protocol";
import { normalizeHistory, normalizeProcessSummary } from "./processes";

function process(label: string | null): ProcListEntry {
  return {
    pid: "proc:task",
    uid: 2000,
    username: "sam-agent",
    interactive: true,
    parentPid: null,
    state: "idle",
    activeRunId: null,
    queuedCount: 0,
    lastActiveAt: null,
    label,
    createdAt: 1,
    cwd: "/home/sam-agent",
  };
}

describe("normalizeProcessSummary", () => {
  it("shows a neutral placeholder until an unnamed task receives its title", () => {
    expect(normalizeProcessSummary(process(null)).title).toBe("New task");
  });

  it("uses the generated process label as the task title", () => {
    expect(normalizeProcessSummary(process("Review migration plan")).title)
      .toBe("Review migration plan");
  });
});

describe("normalizeHistory", () => {
  it("preserves the authoritative target on restored approvals", () => {
    const result: Extract<ProcHistoryResult, { ok: true }> = {
      ok: true,
      pid: "proc:task",
      messages: [],
      messageCount: 0,
      activeRunId: "run-1",
      pendingHil: {
        pid: "proc:task",
        requestId: "hil-1",
        runId: "run-1",
        callId: "call-1",
        toolName: "Shell",
        syscall: "shell.exec",
        target: "macbook",
        args: { input: "pwd" },
        createdAt: 1,
      },
    };

    expect(normalizeHistory(result)).toMatchObject({
      runState: "awaiting_hil",
      pendingHil: {
        requestId: "hil-1",
        target: "macbook",
      },
    });
  });
});
