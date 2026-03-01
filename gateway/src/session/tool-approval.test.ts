import { describe, expect, it } from "vitest";
import {
  evaluateToolApproval,
  matchesToolApprovalPattern,
  parseToolApprovalDecision,
} from "./tool-approval";
import type { ToolApprovalConfig } from "../config";

describe("tool approval pattern matching", () => {
  it("matches exact tool names", () => {
    expect(matchesToolApprovalPattern("gsv__Bash", "gsv__Bash")).toBe(true);
    expect(matchesToolApprovalPattern("gsv__ReadFile", "gsv__Bash")).toBe(false);
  });

  it("supports wildcard patterns", () => {
    expect(matchesToolApprovalPattern("node-1__Bash", "node-1__*")).toBe(true);
    expect(matchesToolApprovalPattern("node-2__Bash", "node-1__*")).toBe(false);
    expect(matchesToolApprovalPattern("gsv__ReadFile", "*Read*")).toBe(true);
  });
});

describe("tool approval policy evaluation", () => {
  const baseConfig: ToolApprovalConfig = {
    defaultDecision: "allow",
    rules: [
      {
        id: "deny-destructive-shell",
        tool: "gsv__Bash",
        when: [
          {
            path: "command",
            op: "regex",
            value: "(^|\\s)rm\\s+-rf\\s+/",
          },
        ],
        decision: "deny",
        reason: "destructive command",
      },
      {
        id: "ask-shell",
        tool: "gsv__Bash",
        decision: "ask",
      },
    ],
  };

  it("uses first-match-wins semantics", () => {
    const denied = evaluateToolApproval(
      "gsv__Bash",
      { command: "rm -rf /tmp/demo" },
      baseConfig,
    );
    expect(denied).toEqual({
      decision: "deny",
      ruleId: "deny-destructive-shell",
      reason: "destructive command",
    });

    const ask = evaluateToolApproval(
      "gsv__Bash",
      { command: "ls -la" },
      baseConfig,
    );
    expect(ask).toEqual({
      decision: "ask",
      ruleId: "ask-shell",
      reason: undefined,
    });
  });

  it("returns default decision when no rule matches", () => {
    const result = evaluateToolApproval("gsv__ReadFile", { path: "x" }, {
      defaultDecision: "allow",
      rules: [],
    });
    expect(result).toEqual({ decision: "allow" });
  });

  it("supports equals/contains/startsWith/regex operators", () => {
    const config: ToolApprovalConfig = {
      defaultDecision: "allow",
      rules: [
        {
          id: "ask-env-prod",
          tool: "node-1__deploy",
          when: [{ path: "env", op: "equals", value: "prod" }],
          decision: "ask",
        },
        {
          id: "deny-curl-pipe",
          tool: "gsv__Bash",
          when: [{ path: "command", op: "contains", value: "curl" }],
          decision: "deny",
        },
        {
          id: "ask-home-write",
          tool: "gsv__WriteFile",
          when: [{ path: "path", op: "startsWith", value: "/home/" }],
          decision: "ask",
        },
        {
          id: "deny-hidden-file",
          tool: "gsv__WriteFile",
          when: [{ path: "path", op: "regex", value: "^\\." }],
          decision: "deny",
        },
      ],
    };

    expect(
      evaluateToolApproval("node-1__deploy", { env: "prod" }, config),
    ).toMatchObject({ decision: "ask", ruleId: "ask-env-prod" });
    expect(
      evaluateToolApproval("gsv__Bash", { command: "curl x" }, config),
    ).toMatchObject({ decision: "deny", ruleId: "deny-curl-pipe" });
    expect(
      evaluateToolApproval("gsv__WriteFile", { path: "/home/sj/a.txt" }, config),
    ).toMatchObject({ decision: "ask", ruleId: "ask-home-write" });
    expect(
      evaluateToolApproval("gsv__WriteFile", { path: ".env" }, config),
    ).toMatchObject({ decision: "deny", ruleId: "deny-hidden-file" });
  });

  it("supports nested and indexed arg paths", () => {
    const result = evaluateToolApproval(
      "node-1__pipeline",
      { steps: [{ name: "prep" }, { name: "deploy" }] },
      {
        defaultDecision: "allow",
        rules: [
          {
            id: "ask-step-1-deploy",
            tool: "node-1__pipeline",
            when: [{ path: "steps.1.name", op: "equals", value: "deploy" }],
            decision: "ask",
          },
        ],
      },
    );

    expect(result).toEqual({
      decision: "ask",
      ruleId: "ask-step-1-deploy",
      reason: undefined,
    });
  });

  it("treats invalid regex rules as non-matching", () => {
    const result = evaluateToolApproval(
      "gsv__Bash",
      { command: "ls" },
      {
        defaultDecision: "allow",
        rules: [
          {
            id: "broken-rule",
            tool: "gsv__Bash",
            when: [{ path: "command", op: "regex", value: "[" }],
            decision: "deny",
          },
        ],
      },
    );

    expect(result).toEqual({ decision: "allow" });
  });
});

describe("tool approval decision parsing", () => {
  it("parses approve decisions", () => {
    expect(parseToolApprovalDecision("yes")).toEqual({ decision: "approve" });
    expect(parseToolApprovalDecision("approve appr_123")).toEqual({
      decision: "approve",
      approvalId: "appr_123",
    });
    expect(
      parseToolApprovalDecision("[whatsapp · 1:23 PM UTC] yes appr_456"),
    ).toEqual({
      decision: "approve",
      approvalId: "appr_456",
    });
  });

  it("parses deny decisions", () => {
    expect(parseToolApprovalDecision("no")).toEqual({ decision: "deny" });
    expect(parseToolApprovalDecision("reject appr_123")).toEqual({
      decision: "deny",
      approvalId: "appr_123",
    });
  });

  it("ignores non-decision messages", () => {
    expect(parseToolApprovalDecision("what is happening")).toBeNull();
    expect(parseToolApprovalDecision("")).toBeNull();
  });
});
