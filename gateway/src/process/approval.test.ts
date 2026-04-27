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
  workspaceId: "ws-1",
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

  it("builds path tags for filesystem syscalls", () => {
    const facts = buildToolApprovalFacts("fs.delete", { path: "../.env" }, IDENTITY);
    expect(facts.tags).toContain("destructive");
    expect(facts.tags).toContain("hidden-path");
    expect(facts.tags).toContain("outside-cwd");
    expect(facts.path).toBe("/home/hank/.env");
  });
});
