import { describe, expect, it, vi } from "vitest";
import type { JsonObject } from "@humansandmachines/gsv/protocol";
import { Hint } from "../../../components/ui/Tooltip";
import { collectNodes, collectText } from "../../../testing/testHarness";
import { ApprovalCard } from "./ApprovalCard";

const request = {
  pid: "ship", requestId: "r1", runId: "run1", callId: "c1", toolName: "Shell", syscall: "shell.exec",
  target: "my-mac", args: { input: "pgrep -fl Granola" }, createdAt: 1,
};
const props = { who: "jessicat", place: "my mac", onInspect: () => {}, onDecide: () => {} };

describe("approval card", () => {
  it("offers always allow with its exact scope only when a handler is given, and runs once otherwise", () => {
    const onDecide = vi.fn();
    const onAlwaysAllow = vi.fn();
    const tree = ApprovalCard({ ...props, request, onDecide, onAlwaysAllow });
    const nodes = collectNodes(tree);
    const hint = nodes.find((node) => node.type === Hint);
    expect(hint?.props.text).toBe("Always run commands on my mac without asking. The rule is saved in Settings → permissions, where you can change it.");
    nodes.find((node) => node.type === "button" && collectText(node).includes("always allow"))?.props.onClick?.();
    expect(onAlwaysAllow).toHaveBeenCalledOnce();
    expect(onDecide).not.toHaveBeenCalled();
    nodes.find((node) => node.type === "button" && collectText(node).includes("run it"))?.props.onClick?.();
    expect(onDecide).toHaveBeenLastCalledWith("approve");
    nodes.find((node) => node.type === "button" && collectText(node).includes("don't"))?.props.onClick?.();
    expect(onDecide).toHaveBeenLastCalledWith("deny");
    const plain = ApprovalCard({ ...props, request });
    expect(collectText(plain)).not.toContain("always allow");
    expect(collectNodes(plain).some((node) => node.type === Hint)).toBe(false);
  });

  it.each([
    { pending: { ...request, syscall: "mail.send", target: "gsv" }, scope: "Always send email without asking." },
    { pending: { ...request, syscall: "sys.mcp.call", target: "gsv", args: { serverId: "calendar", name: "update_event" } }, scope: "Always use any connected tool without asking." },
    { pending: { ...request, syscall: "fs.write", target: "targets/*" }, scope: "Always write files on my mac without asking." },
  ])("names the whole scope the rule covers for $pending.syscall", ({ pending, scope }) => {
    const hint = collectNodes(ApprovalCard({ ...props, request: pending, onAlwaysAllow: () => {} })).find((node) => node.type === Hint);
    expect(hint?.props.text).toContain(scope);
  });

  it("offers the explanation link only when given, without a shortcut", () => {
    const onExplain = vi.fn();
    const tree = ApprovalCard({ ...props, request, onExplain, shortcuts: false });
    const link = collectNodes(tree).find((node) => node.type === "button" && collectText(node) === "why am I being asked?");
    expect(link).toBeDefined();
    link?.props.onClick?.();
    expect(onExplain).toHaveBeenCalledOnce();
    expect(collectNodes(tree).some((node) => node.type === "kbd")).toBe(false);
    expect(collectText(ApprovalCard({ ...props, request }))).not.toContain("why am I being asked?");
  });

  it("keeps run and deny live when the rule failed to save, and holds everything while it saves", () => {
    const failed = ApprovalCard({ ...props, request, onAlwaysAllow: () => {}, alwaysAllowError: "offline" });
    const text = collectText(failed);
    expect(text).toContain("the rule was not saved: offline");
    expect(text).toContain("run it once");
    const buttons = collectNodes(failed).filter((node) => node.type === "button" && node.props.disabled !== undefined);
    expect(buttons).toHaveLength(3);
    for (const button of buttons) expect(button.props.disabled).toBe(false);
    const onDecide = vi.fn();
    const onAlwaysAllow = vi.fn();
    const saving = ApprovalCard({ ...props, request, onDecide, onAlwaysAllow, alwaysAllowSaving: true });
    const held = collectNodes(saving).filter((node) => node.type === "button" && node.props.disabled !== undefined);
    expect(held).toHaveLength(3);
    for (const button of held) { expect(button.props.disabled).toBe(true); button.props.onClick?.(); }
    expect(onDecide).not.toHaveBeenCalled();
    expect(onAlwaysAllow).not.toHaveBeenCalled();
    expect(collectText(saving)).toContain("saving the rule");
  });

  it("leads with the model's purpose and folds the command away", () => {
    const tree = ApprovalCard({ ...props, request: { ...request, purpose: "check whether Granola is running" } });
    const text = collectText(tree);
    expect(text).toContain("Check whether Granola is running");
    expect(text).toContain("show the command");
    const fold = collectNodes(tree).find((node) => node.type === "details");
    expect(fold).toBeDefined();
    expect(fold?.props).not.toHaveProperty("open");
    const foldText = collectText(collectNodes(fold).find((node) => node.props.class === "machine-rail"));
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
    const tree = ApprovalCard({
      ...props,
      request: { ...request, toolName: "Read", syscall: "fs.read", args: { path: "/Users/jessicat/notes.md" } },
    });
    const text = collectText(tree);
    expect(text).toContain("Read a file on my mac");
    expect(text).toContain("show the details");
    expect(text).toContain("read /Users/jessicat/notes.md");
    expect(text).toContain("my-mac");
    expect(collectText(collectNodes(tree).find((node) => node.props.class === "machine-rail"))).not.toContain("fs.read");
    expect(text).not.toContain("$");
  });

  it("names the recipient and subject for mail without faking a prompt", () => {
    const tree = ApprovalCard({
      ...props,
      request: { ...request, toolName: "mail.send", syscall: "mail.send", target: "gsv", args: { to: "mike@example.com", subject: "Contract follow-up", text: "private" } },
    });
    const text = collectText(collectNodes(tree).find((node) => node.props.class === "machine-rail"));
    expect(text).toContain("to mike@example.com · Contract follow-up");
    expect(text).not.toContain("mail.send");
    expect(text).not.toContain("private");
    expect(text).not.toContain("$");
  });

  it.each<{ syscall: string; args: JsonObject }>([
    { syscall: "sys.mcp.call", args: { serverId: "calendar", name: "update_event", arguments: { attendees: ["guest@example.com"], notify: false, retries: 0, location: null } } },
    { syscall: "shell.exec", args: { input: "python task.py", cwd: "/home/user/project", env: { MODE: "write" }, timeout: 60 } },
    { syscall: "mail.send", args: { to: "guest@example.com", subject: "Update", text: "Complete mail body", attachments: [{ path: "/report.pdf" }] } },
    { syscall: "shell.exec", args: { sessionId: "pending-command", stdin: "yes\n" } },
  ])("keeps every $syscall argument inspectable in closed details", ({ syscall, args }) => {
    const pending = { ...request, syscall, args };
    const nodes = collectNodes(ApprovalCard({ ...props, request: pending }));
    const folds = nodes.filter((node) => node.type === "details");
    expect(folds.length).toBeGreaterThan(0);
    for (const fold of folds) expect(fold.props).not.toHaveProperty("open");
    const exact = nodes.find((node) => node.type === "pre" && node.props.class === "approval-exact");
    expect(JSON.parse(collectText(exact))).toEqual({ syscall, target: pending.target, args });
  });
});
