import { describe, expect, it } from "vitest";
import type { ProcListEntry } from "@humansandmachines/gsv/protocol";
import { normalizeProcessSummary } from "./processes";

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
