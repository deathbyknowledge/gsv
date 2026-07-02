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

  it("resolves agent model profile overrides through the owning user", () => {
    const config: ConsoleConfigEntry[] = [
      { key: "users/2000/ai/model_profile", value: "fast-stack", redacted: false },
      {
        key: "users/1000/ai/model_profiles",
        value: JSON.stringify({
          profiles: [{
            id: "fast-stack",
            name: "Fast Stack",
            values: {
              "config/ai/provider": "custom",
              "config/ai/model": "zai-glm-4.7",
            },
            createdAt: 1,
            updatedAt: 2,
          }],
        }),
        redacted: false,
      },
    ];

    const behavior = behaviorForAccount(config, 2000, 1000);

    expect(behavior.modelProfile).toBe("fast-stack");
    expect(behavior.model).toBe("model-profile:fast-stack");
    expect(behavior.modelLabel).toBe("Fast Stack");
  });

  it("treats legacy raw model overrides as a matching owner profile", () => {
    const config: ConsoleConfigEntry[] = [
      { key: "users/2000/ai/model", value: "zai-glm-4.7", redacted: false },
      {
        key: "users/1000/ai/model_profiles",
        value: JSON.stringify({
          profiles: [{
            id: "fast-stack",
            name: "Fast Stack",
            values: {
              "config/ai/provider": "custom",
              "config/ai/model": "zai-glm-4.7",
            },
            createdAt: 1,
            updatedAt: 2,
          }],
        }),
        redacted: false,
      },
    ];

    const behavior = behaviorForAccount(config, 2000, 1000);

    expect(behavior.modelProfile).toBe("fast-stack");
    expect(behavior.model).toBe("model-profile:fast-stack");
    expect(behavior.modelLabel).toBe("Fast Stack");
  });

  it("keeps raw model overrides when provider stack fields are configured", () => {
    const config: ConsoleConfigEntry[] = [
      { key: "users/2000/ai/model", value: "zai-glm-4.7", redacted: false },
      { key: "users/2000/ai/provider", value: "custom", redacted: false },
      {
        key: "users/1000/ai/model_profiles",
        value: JSON.stringify({
          profiles: [{
            id: "fast-stack",
            name: "Fast Stack",
            values: {
              "config/ai/provider": "custom",
              "config/ai/model": "zai-glm-4.7",
            },
            createdAt: 1,
            updatedAt: 2,
          }],
        }),
        redacted: false,
      },
    ];

    const behavior = behaviorForAccount(config, 2000, 1000);

    expect(behavior.modelProfile).toBe("");
    expect(behavior.model).toBe("zai-glm-4.7");
    expect(behavior.modelLabel).toBe("zai-glm-4.7");
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

  it("normalizes approval target scopes", () => {
    const policy = parseApprovalPolicy(JSON.stringify({
      default: "auto",
      rules: [
        { match: "shell.exec", target: "gateway", action: "ask" },
        { match: "shell.exec", when: { target: "device" }, action: "deny" },
        { match: "fs.read", target: "macbook", action: "auto" },
      ],
    }));

    expect(policy.rules).toEqual([
      { match: "shell.exec", target: "gsv", action: "ask" },
      { match: "shell.exec", target: "targets/*", action: "deny" },
      { match: "fs.read", target: "macbook", action: "auto" },
    ]);
    expect(serializeApprovalPolicy(policy)).toBe(
      '{"default":"auto","rules":[{"match":"shell.exec","target":"gsv","action":"ask"},{"match":"shell.exec","target":"targets/*","action":"deny"},{"match":"fs.read","target":"macbook","action":"auto"}]}',
    );
  });
});
