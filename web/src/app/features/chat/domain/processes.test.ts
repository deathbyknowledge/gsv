import { describe, expect, it } from "vitest";
import type { ProcListEntry } from "@humansandmachines/gsv/protocol";
import { normalizeProcessSummary } from "./processes";

function process(label: string | null): ProcListEntry {
  return {
    pid: "proc:task",
    uid: 2000,
    username: "sam-agent",
    personal: true,
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
  it("shows a neutral placeholder until unnamed work receives its title", () => {
    expect(normalizeProcessSummary(process(null)).title).toBe("New work");
  });

  it("uses the generated process label as the work title", () => {
    expect(normalizeProcessSummary(process("Review migration plan")).title)
      .toBe("Review migration plan");
  });

  it("preserves the canonical personal marker", () => {
    expect(normalizeProcessSummary(process("Home")).personal).toBe(true);
  });
});
