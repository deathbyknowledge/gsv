import { describe, expect, it } from "vitest";
import { describeHilRequest, hilDetailLabel, hilRequestDetail, hilRequestSentence, normalizeHilRequest } from "./hil";

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

  it("offers the raw detail behind the sentence", () => {
    expect(hilRequestDetail(shell)).toBe("pgrep -fl Granola");
    expect(hilDetailLabel(shell)).toBe("show the command");
    expect(hilRequestDetail({ ...shell, syscall: "fs.read", args: { path: "/root/secret.txt" } })).toBe("/root/secret.txt");
    expect(hilDetailLabel({ ...shell, syscall: "fs.read" })).toBe("show the details");
    expect(hilRequestDetail({ ...shell, syscall: "mail.send", args: { to: "mike@example.com", subject: "Hi" } })).toBe("mike@example.com · Hi");
    expect(hilRequestDetail({ ...shell, syscall: "mail.send", args: {} })).toBeNull();
  });
});
