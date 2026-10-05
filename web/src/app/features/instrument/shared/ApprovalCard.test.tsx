import { describe, expect, it, vi } from "vitest";
import { Hint } from "../../../components/ui/Tooltip";
import { collectNodes, collectText } from "../../../testing/testHarness";
import { ApprovalCard } from "./ApprovalCard";

const request = {
  pid: "ship", requestId: "r1", runId: "run1", callId: "c1", toolName: "Shell", syscall: "shell.exec",
  target: "my-mac", args: { input: "pgrep -fl Granola" }, createdAt: 1,
};
const props = { who: "jessicat", place: "my mac", onInspect: () => {}, onDecide: () => {} };

describe("approval card", () => {
  it("remembers only an explicit always-allow action and explains its scope", () => {
    const onDecide = vi.fn();
    const tree = ApprovalCard({ ...props, request, onDecide });
    const nodes = collectNodes(tree);
    const hint = nodes.find((node) => node.type === Hint);
    expect(hint?.props.text).toBe("Allow this process to run any shell command on my mac without asking again. Other processes still ask.");
    nodes.find((node) => node.type === "button" && collectText(node) === "always allow")?.props.onClick?.();
    expect(onDecide).toHaveBeenLastCalledWith("approve", true);
    nodes.find((node) => node.type === "button" && collectText(node).includes("run it"))?.props.onClick?.();
    expect(onDecide).toHaveBeenLastCalledWith("approve");
    nodes.find((node) => node.type === "button" && collectText(node).includes("don't"))?.props.onClick?.();
    expect(onDecide).toHaveBeenLastCalledWith("deny");
    onDecide.mockClear();
    const disabled = ApprovalCard({ ...props, request, onDecide, disabled: true });
    const remember = collectNodes(disabled).find((node) => node.type === "button" && collectText(node) === "always allow");
    expect(remember?.props.disabled).toBe(true);
    remember?.props.onClick?.();
    expect(onDecide).not.toHaveBeenCalled();
  });

  it.each([
    { ...request, target: "targets/*" },
    { ...request, syscall: "mail.send" },
  ])("does not offer shell permission for $syscall on $target", (pending) => {
    expect(collectText(ApprovalCard({ ...props, request: pending }))).not.toContain("always allow");
  });

  it("leads with the model's purpose and folds the command away", () => {
    const tree = ApprovalCard({ ...props, request: { ...request, purpose: "check whether Granola is running" } });
    const text = collectText(tree);
    expect(text).toContain("Check whether Granola is running");
    expect(text).toContain("show the command");
    const fold = collectNodes(tree).find((node) => node.type === "details");
    expect(fold).toBeDefined();
    expect(fold?.props).not.toHaveProperty("open");
    const foldText = collectText(fold);
    for (const part of ["jessicat", "my-mac", "$", "pgrep -fl Granola"]) expect(foldText).toContain(part);
    expect(foldText).not.toContain("shell.exec");
  });

  it("describes the request in the same shape when no purpose was given", () => {
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
    expect(text).toContain("read /Users/jessicat/notes.md");
    expect(text).toContain("my-mac");
    expect(text).not.toContain("fs.read");
    expect(text).not.toContain("$");
  });

  it("names the recipient and subject for mail without faking a prompt", () => {
    const text = collectText(ApprovalCard({
      ...props,
      request: { ...request, toolName: "mail.send", syscall: "mail.send", target: "gsv", args: { to: "mike@example.com", subject: "Contract follow-up", text: "private" } },
    }));
    expect(text).toContain("to mike@example.com · Contract follow-up");
    expect(text).not.toContain("mail.send");
    expect(text).not.toContain("private");
    expect(text).not.toContain("$");
  });
});
