import { describe, expect, it } from "vitest";
import {
  DEFAULT_TOOL_APPROVAL_POLICY,
  parseToolApprovalPolicy,
  resolveToolApproval,
} from "./approval";

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

  it("normalizes legacy target conditions to target scopes", () => {
    expect(parseToolApprovalPolicy(JSON.stringify({
      default: "auto",
      rules: [
        {
          match: "shell.exec",
          when: { anyTag: ["network"], target: "device" },
          action: "ask",
        },
      ],
    }))).toEqual({
      default: "auto",
      rules: [{ match: "shell.exec", target: "targets/*", action: "ask" }],
    });
  });

  it("asks for default guarded tool kinds", () => {
    expect(resolveToolApproval(DEFAULT_TOOL_APPROVAL_POLICY, "shell.exec").action).toBe("ask");
    expect(resolveToolApproval(DEFAULT_TOOL_APPROVAL_POLICY, "net.fetch").action).toBe("ask");
    expect(resolveToolApproval(DEFAULT_TOOL_APPROVAL_POLICY, "fs.delete").action).toBe("ask");
    expect(resolveToolApproval(DEFAULT_TOOL_APPROVAL_POLICY, "sys.mcp.call").action).toBe("ask");
    expect(resolveToolApproval(DEFAULT_TOOL_APPROVAL_POLICY, "fs.read").action).toBe("auto");
  });

  it("resolves native and connected targets from tool args", () => {
    expect(resolveToolApproval(DEFAULT_TOOL_APPROVAL_POLICY, "shell.exec").target).toBe("gsv");
    expect(resolveToolApproval(DEFAULT_TOOL_APPROVAL_POLICY, "shell.exec", { target: "gateway" }).target).toBe("gsv");
    expect(resolveToolApproval(DEFAULT_TOOL_APPROVAL_POLICY, "shell.exec", { target: "macbook" }).target).toBe("macbook");
    expect(resolveToolApproval(DEFAULT_TOOL_APPROVAL_POLICY, "shell.exec", { sessionId: "sh_123" }).target).toBe("targets/*");
  });

  it("prefers exact syscall rules over domain wildcards", () => {
    const policy = parseToolApprovalPolicy(JSON.stringify({
      default: "auto",
      rules: [
        { match: "fs.*", action: "deny" },
        { match: "fs.read", action: "ask" },
      ],
    }));

    const resolution = resolveToolApproval(policy, "fs.read");
    expect(resolution.action).toBe("ask");
    expect(resolution.matchedRule).toBe("fs.read");
  });

  it("matches domain wildcards when exact rules are absent", () => {
    const policy = parseToolApprovalPolicy(JSON.stringify({
      default: "auto",
      rules: [{ match: "repo.*", action: "ask" }],
    }));

    const resolution = resolveToolApproval(policy, "repo.delete");
    expect(resolution.action).toBe("ask");
    expect(resolution.matchedRule).toBe("repo.*");
  });

  it("prefers target-specific rules over generic tool rules", () => {
    const policy = parseToolApprovalPolicy(JSON.stringify({
      default: "auto",
      rules: [
        { match: "shell.exec", action: "ask" },
        { match: "shell.exec", target: "targets/*", action: "deny" },
        { match: "shell.exec", target: "macbook", action: "auto" },
      ],
    }));

    expect(resolveToolApproval(policy, "shell.exec", { target: "gsv" }).action).toBe("ask");
    expect(resolveToolApproval(policy, "shell.exec", { target: "linux-box" }).action).toBe("deny");
    expect(resolveToolApproval(policy, "shell.exec", { target: "macbook" }).action).toBe("auto");
  });

  it("lets target-specific wildcards override generic exact rules", () => {
    const policy = parseToolApprovalPolicy(JSON.stringify({
      default: "auto",
      rules: [
        { match: "shell.exec", action: "ask" },
        { match: "shell.*", target: "macbook", action: "auto" },
      ],
    }));

    expect(resolveToolApproval(policy, "shell.exec", { target: "macbook" }).action).toBe("auto");
    expect(resolveToolApproval(policy, "shell.exec", { target: "gsv" }).action).toBe("ask");
  });
});
