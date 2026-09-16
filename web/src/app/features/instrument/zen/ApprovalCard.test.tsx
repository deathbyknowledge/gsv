import { describe, expect, it } from "vitest";
import { collectNodes, collectText } from "../../../testing/testHarness";
import { ApprovalCard } from "./ApprovalCard";

const request = {
  pid: "ship", requestId: "r1", runId: "run1", callId: "c1", toolName: "Shell", syscall: "shell.exec",
  target: "my-mac", args: { input: "pgrep -fl Granola" }, createdAt: 1,
};
const props = { who: "jessicat", place: "my mac", onInspect: () => {}, onDecide: () => {} };

describe("approval card", () => {
  it("leads with the model's reason and folds the command away", () => {
    const tree = ApprovalCard({ ...props, request: { ...request, reason: "check whether Granola is running" } });
    const text = collectText(tree);
    expect(text).toContain("Check whether Granola is running");
    expect(text).toContain("show the command");
    const fold = collectNodes(tree).find((node) => node.type === "details");
    expect(fold).toBeDefined();
    expect(fold?.props).not.toHaveProperty("open");
    const foldText = collectText(fold);
    for (const part of ["jessicat", "my-mac", "shell.exec", "pgrep -fl Granola"]) expect(foldText).toContain(part);
  });

  it("describes the request in the same shape when no reason was given", () => {
    const text = collectText(ApprovalCard({ ...props, request }));
    expect(text).toContain("Run a command on my mac");
    expect(text).toContain("show the command");
    expect(text).toContain("pgrep -fl Granola");
  });

  it("offers details rather than a command for a file request", () => {
    const text = collectText(ApprovalCard({
      ...props,
      request: { ...request, toolName: "Read", syscall: "fs.read", args: { path: "/Users/jessicat/notes.md" } },
    }));
    expect(text).toContain("Read a file on my mac");
    expect(text).toContain("show the details");
    expect(text).toContain("/Users/jessicat/notes.md");
  });
});
