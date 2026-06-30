import { describe, expect, it } from "vitest";
import type { ConsoleConfigEntry } from "./consoleModels";
import {
  behaviorForAccount,
  defaultApprovalPolicyForConfig,
  GLOBAL_APPROVAL_CONFIG_KEY,
  parseApprovalPolicy,
  serializeApprovalPolicy,
} from "./consoleAgentBehavior";

describe("console agent behavior", () => {
  it("uses the owning user's approval policy when an agent has no override", () => {
    const ownerApproval = JSON.stringify({
      default: "deny",
      rules: [{ match: "fs.read", action: "auto" }],
    });
    const systemApproval = JSON.stringify({
      default: "auto",
      rules: [{ match: "fs.delete", action: "ask" }],
    });
    const config: ConsoleConfigEntry[] = [
      { key: "users/1000/ai/tools/approval", value: ownerApproval, redacted: false },
      { key: GLOBAL_APPROVAL_CONFIG_KEY, value: systemApproval, redacted: false },
    ];

    const behavior = behaviorForAccount(config, 2000, 1000);

    expect(behavior.approval).toBe(ownerApproval);
    expect(behavior.approvalInherited).toBe(true);
    expect(behavior.approvalOverride).toBe("");
    expect(behavior.permission).toBe("deny");
  });

  it("uses the configured system approval policy when account defaults are missing", () => {
    const approval = JSON.stringify({
      default: "auto",
      rules: [{ match: "fs.delete", action: "ask" }],
    });
    const config: ConsoleConfigEntry[] = [
      { key: GLOBAL_APPROVAL_CONFIG_KEY, value: approval, redacted: false },
    ];

    const behavior = behaviorForAccount(config, 42);

    expect(behavior.approval).toBe(approval);
    expect(behavior.approvalInherited).toBe(true);
    expect(behavior.approvalOverride).toBe("");
    expect(behavior.permission).toBe("auto");
  });

  it("falls back to the runtime approval default when config is missing", () => {
    const policy = parseApprovalPolicy(defaultApprovalPolicyForConfig([]));

    expect(policy.default).toBe("auto");
    expect(policy.rules.map((rule) => rule.match)).toEqual([
      "shell.exec",
      "net.fetch",
      "fs.delete",
      "sys.mcp.call",
    ]);
  });

  it("keeps explicit ask-only approval policies serializable", () => {
    expect(serializeApprovalPolicy({ default: "ask", rules: [] })).toBe('{"default":"ask","rules":[]}');
  });
});
