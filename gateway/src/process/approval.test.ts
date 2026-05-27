import { describe, expect, it } from "vitest";
import type { ProcessIdentity } from "@gsv/protocol/syscalls/system";
import {
  DEFAULT_TOOL_APPROVAL_POLICY,
  buildToolApprovalFacts,
  parseToolApprovalPolicy,
  resolveToolApproval,
} from "./approval";

const IDENTITY: ProcessIdentity = {
  uid: 1000,
  gid: 1000,
  gids: [1000],
  username: "hank",
  home: "/home/hank",
  cwd: "/home/hank/project",
};

describe("tool approval policy", () => {
  it("parses policy JSON and keeps defaults on invalid input", () => {
    expect(parseToolApprovalPolicy(null)).toEqual(DEFAULT_TOOL_APPROVAL_POLICY);
    expect(parseToolApprovalPolicy("{")).toEqual(DEFAULT_TOOL_APPROVAL_POLICY);
    expect(parseToolApprovalPolicy(JSON.stringify({
      default: "deny",
      rules: [{ match: "fs.*", action: "ask" }],
    }))).toEqual({
      default: "deny",
      rules: [{ match: "fs.*", action: "ask" }],
    });
  });

  it("defaults ordinary worker shell commands to auto while guarding risky commands", () => {
    const ordinary = resolveToolApproval(
      DEFAULT_TOOL_APPROVAL_POLICY,
      "shell.exec",
      { target: "gsv", input: "pwd" },
      IDENTITY,
      "task",
    );
    expect(ordinary.action).toBe("auto");

    const destructive = resolveToolApproval(
      DEFAULT_TOOL_APPROVAL_POLICY,
      "shell.exec",
      { target: "gsv", input: "rm -rf build" },
      IDENTITY,
      "task",
    );
    expect(destructive.action).toBe("ask");
  });

  it("classifies shell commands through the parser instead of substring boundaries", () => {
    const tabbed = resolveToolApproval(
      DEFAULT_TOOL_APPROVAL_POLICY,
      "shell.exec",
      { target: "gsv", input: "rm\t-rf build" },
      IDENTITY,
      "task",
    );
    expect(tabbed.action).toBe("ask");
    expect(tabbed.facts.tags).toContain("destructive");

    const newline = resolveToolApproval(
      DEFAULT_TOOL_APPROVAL_POLICY,
      "shell.exec",
      { target: "gsv", input: "sudo\npwd" },
      IDENTITY,
      "task",
    );
    expect(newline.action).toBe("ask");
    expect(newline.facts.tags).toContain("privileged");
  });

  it("requires approval for unclassified shell commands", () => {
    const resolution = resolveToolApproval(
      DEFAULT_TOOL_APPROVAL_POLICY,
      "shell.exec",
      { target: "gsv", input: "node -e 'console.log(1)'" },
      IDENTITY,
      "task",
    );
    expect(resolution.action).toBe("ask");
    expect(resolution.facts.tags).toContain("unclassified");
  });

  it("requires approval for network and mutating shell commands", () => {
    const network = resolveToolApproval(
      DEFAULT_TOOL_APPROVAL_POLICY,
      "shell.exec",
      { target: "gsv", input: "curl https://example.com" },
      IDENTITY,
      "task",
    );
    expect(network.action).toBe("ask");
    expect(network.facts.tags).toContain("network");

    const redirect = resolveToolApproval(
      DEFAULT_TOOL_APPROVAL_POLICY,
      "shell.exec",
      { target: "gsv", input: "echo key >> ~/.ssh/authorized_keys" },
      IDENTITY,
      "task",
    );
    expect(redirect.action).toBe("ask");
    expect(redirect.facts.tags).toContain("mutating");
  });

  it("prefers exact syscall rules over domain wildcards", () => {
    const policy = parseToolApprovalPolicy(JSON.stringify({
      default: "auto",
      rules: [
        { match: "fs.*", action: "deny" },
        { match: "fs.read", action: "ask" },
      ],
    }));

    const resolution = resolveToolApproval(policy, "fs.read", { path: "/tmp/a" }, IDENTITY);
    expect(resolution.action).toBe("ask");
    expect(resolution.matchedRule).toBe("fs.read");
  });

  it("matches conditional rules on tags, args, and target", () => {
    const policy = parseToolApprovalPolicy(JSON.stringify({
      default: "auto",
      rules: [
        {
          match: "shell.exec",
          when: {
            anyTag: ["network"],
            target: "device",
            argPrefix: { input: "curl" },
          },
          action: "ask",
        },
      ],
    }));

    const resolution = resolveToolApproval(policy, "shell.exec", {
      input: "curl https://example.com",
      target: "macbook",
    }, IDENTITY);

    expect(resolution.action).toBe("ask");
    expect(resolution.facts.tags).toContain("network");
    expect(resolution.facts.target).toBe("device");
  });

  it("classifies shell session continuations as device-targeted", () => {
    const policy = parseToolApprovalPolicy(JSON.stringify({
      default: "auto",
      rules: [
        {
          match: "shell.exec",
          when: { target: "device" },
          action: "ask",
        },
      ],
    }));

    const resolution = resolveToolApproval(policy, "shell.exec", {
      sessionId: "sh_123",
      input: "rm -rf build",
    }, IDENTITY);

    expect(resolution.action).toBe("ask");
    expect(resolution.facts.target).toBe("device");
    expect(resolution.facts.tags).toContain("remote");
    expect(resolution.facts.tags).toContain("destructive");
  });

  it("builds path tags for filesystem syscalls", () => {
    const facts = buildToolApprovalFacts("fs.delete", { path: "../.env" }, IDENTITY);
    expect(facts.tags).toContain("destructive");
    expect(facts.tags).toContain("hidden-path");
    expect(facts.tags).toContain("outside-cwd");
    expect(facts.path).toBe("/home/hank/.env");
  });
});
