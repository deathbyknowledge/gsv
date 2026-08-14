import { describe, expect, it } from "vitest";
import type { ConsoleProcess } from "../domain/consoleModels";
import { iconForProcess, processBlurb, processDetailSections } from "./runtimePresentation";

function process(input: Partial<ConsoleProcess> = {}): ConsoleProcess {
  return {
    pid: "proc:review",
    label: "Review release",
    state: "idle",
    rawState: "idle",
    uid: 1000,
    username: "aria",
    profile: "default",
    cwd: "/home/aria",
    parentPid: null,
    interactive: false,
    personal: false,
    activeRunId: null,
    queuedCount: 0,
    createdAt: 1,
    lastActiveAt: 2,
    ...input,
  };
}

describe("runtime work presentation", () => {
  it("presents a delegated process as durable work", () => {
    expect(iconForProcess(process())).toBe("list");
    expect(processBlurb(process())).toContain("idle work");
    expect(processBlurb(process())).not.toContain("task");
  });

  it("keeps interactive process and parent metadata inspectable", () => {
    const sections = processDetailSections(process({ interactive: true, parentPid: "proc:parent" }));
    const ownerRows = sections.find((section) => section.title === "OWNER")?.rows ?? [];

    expect(iconForProcess(process({ interactive: true }))).toBe("chat");
    expect(ownerRows).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "HIL APPROVALS", sub: "YES" }),
      expect.objectContaining({ label: "PARENT WORK", sub: "proc:parent" }),
    ]));
  });
});
