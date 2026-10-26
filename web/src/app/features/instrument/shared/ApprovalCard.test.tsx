import type { ComponentChildren } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonObject } from "@humansandmachines/gsv/protocol";
import { InfoTip } from "../../../components/ui/InfoTip";
import { Hint } from "../../../components/ui/Tooltip";
import { collectNodes, collectText, createTestRoot } from "../../../testing/testHarness";
import { ApprovalCard, type ApprovalCardProps } from "./ApprovalCard";

const request = {
  pid: "ship", requestId: "r1", runId: "run1", callId: "c1", toolName: "Shell", syscall: "shell.exec",
  target: "my-mac", args: { input: "pgrep -fl Granola" }, createdAt: 1,
};
const props = { who: "jessicat", place: "my mac", onInspect: () => {}, onDecide: () => {} };

async function approvalCardTree(cardProps: ApprovalCardProps): Promise<ComponentChildren> {
  const root = createTestRoot("approval card");
  let tree: ComponentChildren;
  function Harness() { tree = ApprovalCard(cardProps); return null; }
  try {
    await root.render(<Harness />);
  } finally {
    await root.unmount();
  }
  return tree;
}

beforeEach(() => vi.stubGlobal("document", {}));
afterEach(() => vi.unstubAllGlobals());

describe("approval card", () => {
  it("remembers only an explicit always-allow action and explains its scope", async () => {
    const onDecide = vi.fn();
    const tree = await approvalCardTree({ ...props, request, onDecide });
    const nodes = collectNodes(tree);
    const hint = nodes.find((node) => node.type === Hint && collectText(node) === "Always allow");
    expect(hint?.props.text).toBe("Stop asking before “Run shell commands” on my mac, for Ship and every helper. Change this in Settings → Permissions.");
    nodes.find((node) => node.type === "button" && collectText(node) === "Always allow")?.props.onClick?.();
    expect(onDecide).toHaveBeenLastCalledWith("approve", true);
    nodes.find((node) => node.type === "button" && collectText(node).includes("Allow once"))?.props.onClick?.();
    expect(onDecide).toHaveBeenLastCalledWith("approve");
    nodes.find((node) => node.type === "button" && collectText(node).includes("Block"))?.props.onClick?.();
    expect(onDecide).toHaveBeenLastCalledWith("deny");
    onDecide.mockClear();
    const disabled = await approvalCardTree({ ...props, request, onDecide, disabled: true });
    const remember = collectNodes(disabled).find((node) => node.type === "button" && collectText(node) === "Always allow");
    expect(remember?.props.disabled).toBe(true);
    remember?.props.onClick?.();
    expect(onDecide).not.toHaveBeenCalled();
  });

  it("keeps the heading visible and tucks its secondary notes into tooltips", async () => {
    const onInspect = vi.fn();
    const tree = await approvalCardTree({ ...props, request, onInspect });
    const header = collectNodes(tree).find((node) => node.props.class === "q");
    expect(collectText(header).replace(/\s+/g, " ")).toBe("approval · my mac");
    const inspect = collectNodes(header).find((node) => node.type === Hint);
    expect(inspect?.props.text).toBe("Inspect this approval in Work");
    expect(inspect?.props).not.toHaveProperty("openOnTap");
    const button = collectNodes(inspect).find((node) => node.type === "button");
    expect(button?.props).not.toHaveProperty("title");
    button?.props.onClick?.();
    expect(onInspect).toHaveBeenCalledOnce();
    const note = collectNodes(header).find((node) => node.type === InfoTip);
    expect(note?.props).toMatchObject({ text: "Nothing runs until you answer.", label: "About this approval" });
    expect(collectText(collectNodes(tree).find((node) => node.props.class === "keys"))).not.toContain("Nothing runs");
  });

  it("shows a plain heading with the note when the approval cannot be inspected", async () => {
    const tree = await approvalCardTree({ ...props, request, label: "crew", onInspect: undefined });
    const header = collectNodes(tree).find((node) => node.props.class === "q");
    expect(collectText(header).replace(/\s+/g, " ")).toBe("crew · my mac");
    expect(collectNodes(header).some((node) => node.type === "button" || node.type === Hint)).toBe(false);
    expect(collectNodes(header).some((node) => node.type === InfoTip)).toBe(true);
  });

  it("does not offer Always allow for a request that names no single place", async () => {
    expect(collectText(await approvalCardTree({ ...props, request: { ...request, target: "targets/*" } }))).not.toContain("Always allow");
  });

  it("offers Always allow for any kind of request on one place", async () => {
    const tree = await approvalCardTree({ ...props, request: { ...request, toolName: "CodeMode", syscall: "mail.send", target: "gsv", args: {} } });
    expect(collectText(tree)).toContain("Always allow");
    expect(collectNodes(tree).find((node) => node.type === Hint && collectText(node) === "Always allow")?.props.text).toContain("“Send mail”");
  });

  it("leads with the model's purpose and folds the command away", async () => {
    const tree = await approvalCardTree({ ...props, request: { ...request, purpose: "check whether Granola is running" } });
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

  it("describes the request in the same shape when no purpose was given", async () => {
    const text = collectText(await approvalCardTree({ ...props, request }));
    expect(text).toContain("Run a command on my mac");
    expect(text).toContain("show the command");
    expect(text).toContain("pgrep -fl Granola");
  });

  it("offers details rather than a command for a file request", async () => {
    const tree = await approvalCardTree({
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

  it("names the recipient and subject for mail without faking a prompt", async () => {
    const tree = await approvalCardTree({
      ...props,
      request: { ...request, toolName: "mail.send", syscall: "mail.send", target: "gsv", args: { to: "mike@example.com", subject: "Contract follow-up", text: "private" } },
    });
    const text = collectText(collectNodes(tree).find((node) => node.props.class === "machine-rail"));
    expect(text).toContain("to mike@example.com · Contract follow-up");
    expect(text).not.toContain("mail.send");
    expect(text).not.toContain("private");
    expect(text).not.toContain("$");
  });

  it("names who a publish speaks as, every change, and the files its records carry", async () => {
    const picture = { $type: "blob", ref: { $link: "bafkreipicture" }, mimeType: "image/png", size: 2_097_152 };
    const tree = await approvalCardTree({ ...props, request: { ...request, syscall: "atproto.write", target: "gsv", args: {
      handle: "alice",
      address: "alice.ship.space",
      writes: [
        { action: "put", collection: "com.example.note", rkey: "first", record: { $type: "com.example.note", text: "hello", picture } },
        { action: "delete", collection: "com.example.note", rkey: "old" },
      ],
    } } });
    const text = collectText(tree);
    expect(text).toContain("Publish to the open network");
    expect(text).toMatch(/Publishes to the open network as\s+@alice/);
    expect(text).toContain("add or replace com.example.note/first");
    expect(text).toContain("remove com.example.note/old");
    const nodes = collectNodes(tree);
    const handle = nodes.find((node) => node.type === Hint && collectText(node) === "@alice");
    expect(handle?.props.text).toBe("alice.ship.space");
    // Each file the records carry renders once, keyed by its CID.
    expect(nodes.filter((node) => node.key === "bafkreipicture")).toHaveLength(1);
    expect(collectText(nodes.find((node) => node.props.class === "machine-rail"))).toBe("com.example.note/first · com.example.note/old");
  });

  it.each<{ syscall: string; args: JsonObject }>([
    { syscall: "sys.mcp.call", args: { serverId: "calendar", name: "update_event", arguments: { attendees: ["guest@example.com"], notify: false, retries: 0, location: null } } },
    { syscall: "shell.exec", args: { input: "python task.py", cwd: "/home/user/project", env: { MODE: "write" }, timeout: 60 } },
    { syscall: "mail.send", args: { to: "guest@example.com", subject: "Update", text: "Complete mail body", attachments: [{ path: "/report.pdf" }] } },
    { syscall: "shell.exec", args: { sessionId: "pending-command", stdin: "yes\n" } },
  ])("keeps every $syscall argument inspectable in closed details", async ({ syscall, args }) => {
    const pending = { ...request, syscall, args };
    const nodes = collectNodes(await approvalCardTree({ ...props, request: pending }));
    const folds = nodes.filter((node) => node.type === "details");
    expect(folds.length).toBeGreaterThan(0);
    for (const fold of folds) expect(fold.props).not.toHaveProperty("open");
    const exact = nodes.find((node) => node.type === "pre" && node.props.class === "approval-exact");
    expect(JSON.parse(collectText(exact))).toEqual({ syscall, target: pending.target, args });
  });
});
