import { describe, expect, it } from "vitest";
import { describeHilRequest, hilDetailLabel, hilRequestLine, hilRequestSentence, normalizeHilRequest } from "./hil";

const BASE_REQUEST = {
  pid: "pid-1",
  requestId: "hil-1",
  runId: "run-1",
  callId: "call-1",
  toolName: "Shell",
  syscall: "shell.exec",
  args: { input: "pwd" },
  createdAt: 1,
};

describe("HIL request normalization", () => {
  it("preserves the authoritative target exactly", () => {
    expect(normalizeHilRequest({
      ...BASE_REQUEST,
      target: "  macbook  ",
    })).toMatchObject({
      target: "  macbook  ",
    });
  });

  it("rejects requests without an authoritative target", () => {
    expect(normalizeHilRequest({
      ...BASE_REQUEST,
      args: { input: "pwd", target: "gateway" },
    })).toBeNull();
  });

  it("keeps the model's reason as one trimmed line and drops an empty one", () => {
    expect(normalizeHilRequest({
      ...BASE_REQUEST,
      target: "my-mac",
      reason: "  check whether Granola\n  is running  ",
    })?.reason).toBe("check whether Granola is running");
    expect(normalizeHilRequest({ ...BASE_REQUEST, target: "my-mac", reason: "   " })).not.toHaveProperty("reason");
    expect(normalizeHilRequest({ ...BASE_REQUEST, target: "my-mac" })).not.toHaveProperty("reason");
  });

  it("rejects requests without exact decision correlation", () => {
    expect(normalizeHilRequest({
      ...BASE_REQUEST,
      requestId: "",
      target: "gsv",
    })).toBeNull();
    expect(normalizeHilRequest({
      ...BASE_REQUEST,
      runId: null,
      target: "gsv",
    })).toBeNull();
  });
});

describe("HIL request wording", () => {
  const shell = { ...BASE_REQUEST, target: "my-mac", args: { input: "pgrep -fl Granola" } };

  it("leads with the reason when the model wrote one", () => {
    expect(hilRequestSentence({ ...shell, reason: "check whether Granola is running" }, "my mac"))
      .toBe("Check whether Granola is running");
  });

  it("builds a sentence from the request shape otherwise", () => {
    expect(hilRequestSentence(shell, "my mac")).toBe("Run a command on my mac");
    expect(describeHilRequest({ ...shell, target: "gsv" }, "your cloud home")).toBe("run a command in your cloud home");
    expect(describeHilRequest({ ...shell, syscall: "fs.write", args: { path: "/tmp/a" } }, "my mac")).toBe("write a file on my mac");
    expect(describeHilRequest({ ...shell, syscall: "mail.send", args: { to: "mike@example.com", subject: "Contract follow-up" } }, "gsv"))
      .toBe("send an email to mike@example.com about Contract follow-up");
    expect(describeHilRequest({ ...shell, syscall: "sys.mcp.call", toolName: "Search" }, "my mac")).toBe("use Search on my mac");
  });

  it("folds the request as a terminal line, a plain verb, or the tool's name, never the syscall id", () => {
    expect(hilRequestLine(shell)).toEqual({ lead: "prompt", text: "pgrep -fl Granola" });
    expect(hilDetailLabel(shell)).toBe("show the command");
    expect(hilRequestLine({ ...shell, syscall: "fs.read", args: { path: "/root/secret.txt", target: "my-mac" } }))
      .toEqual({ lead: "place", text: "read /root/secret.txt" });
    expect(hilRequestLine({ ...shell, syscall: "fs.write", args: { path: "/tmp/a", content: "x" } })?.text).toBe("write /tmp/a");
    expect(hilRequestLine({ ...shell, syscall: "fs.edit", args: { path: "/tmp/a" } })?.text).toBe("edit /tmp/a");
    expect(hilRequestLine({ ...shell, syscall: "fs.delete", args: { path: "/tmp/a" } })?.text).toBe("delete /tmp/a");
    expect(hilDetailLabel({ ...shell, syscall: "fs.read" })).toBe("show the details");
    expect(hilRequestLine({ ...shell, syscall: "mail.send", toolName: "mail.send", args: { to: "mike@example.com", subject: "Hi", text: "body" } }))
      .toEqual({ lead: "none", text: "to mike@example.com · Hi" });
    expect(hilRequestLine({ ...shell, syscall: "mail.send", args: {} })).toBeNull();
    expect(hilRequestLine({ ...shell, syscall: "net.fetch", toolName: "net.fetch", args: { url: "https://example.com" } }))
      .toEqual({ lead: "place", text: "fetch https://example.com" });
    expect(hilRequestLine({ ...shell, syscall: "sys.mcp.call", toolName: "sys.mcp.call", args: { serverId: "s1", name: "search_docs", arguments: { q: "granola" } } })?.text)
      .toBe("search_docs");
    expect(hilRequestLine({ ...shell, syscall: "codemode.exec", toolName: "CodeMode", args: { code: "return 1" } })?.text)
      .toBe("CodeMode return 1");
    const lines = [
      hilRequestLine(shell),
      hilRequestLine({ ...shell, syscall: "fs.read", args: { path: "/x" } }),
      hilRequestLine({ ...shell, syscall: "net.fetch", args: { url: "u" } }),
    ];
    for (const line of lines) expect(line?.text).not.toMatch(/\b(shell|fs|net)\.[a-z]+\b/);
  });
});
