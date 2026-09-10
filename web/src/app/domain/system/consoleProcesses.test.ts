import { describe, expect, it } from "vitest";
import type { ConsoleProcess } from "./consoleModels";
import {
  consoleWorkProcesses,
  findConsoleWorkProcess,
  isConsoleWorkProcess,
} from "./consoleProcesses";

function process(pid: string, personal: boolean): ConsoleProcess {
  return {
    pid,
    label: pid,
    state: "idle",
    rawState: "idle",
    uid: 1000,
    username: "aria",
    profile: "default",
    cwd: "/home/aria",
    parentPid: null,
    interactive: true,
    personal,
    activeRunId: null,
    queuedCount: 0,
    createdAt: 1,
    lastActiveAt: 1,
  };
}

describe("console Work process selection", () => {
  it("excludes the canonical personal process from Work collections", () => {
    const personal = process("personal", true);
    const work = process("work", false);

    expect(isConsoleWorkProcess(personal)).toBe(false);
    expect(consoleWorkProcesses([personal, work])).toEqual([work]);
  });

  it("fails closed when a Work detail targets the canonical personal process", () => {
    const personal = process("personal", true);
    const work = process("work", false);

    expect(findConsoleWorkProcess([personal, work], personal.pid)).toBeNull();
    expect(findConsoleWorkProcess([personal, work], work.pid)).toBe(work);
  });
});
