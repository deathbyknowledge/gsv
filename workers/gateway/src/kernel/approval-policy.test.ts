import { describe, expect, it } from "vitest";
import { DEFAULT_TOOL_APPROVAL_POLICY } from "../process/approval";
import type { KernelContext } from "./context";
import { allowInOwnerApprovalPolicy, readOwnerApprovalPolicy } from "./approval-policy";

function memoryConfig(entries: Record<string, string> = {}) {
  const values = new Map(Object.entries(entries));
  return {
    values,
    // SAFETY: the owner approval policy only reads and writes ConfigStore keys.
    config: {
      get: (key: string) => values.get(key) ?? null,
      set: (key: string, value: string) => { values.set(key, value); },
    } as KernelContext["config"],
  };
}

describe("owner approval policy", () => {
  it("is the owner's list, or the system list until they have one", () => {
    const { config } = memoryConfig({ "config/ai/tools/approval": '{"default":"ask","rules":[]}' });
    expect(readOwnerApprovalPolicy(config, 1000)).toBe('{"default":"ask","rules":[]}');
    const owned = memoryConfig({ "config/ai/tools/approval": "{}", "users/1000/ai/tools/approval": '{"default":"deny","rules":[]}' });
    expect(readOwnerApprovalPolicy(owned.config, 1000)).toBe('{"default":"deny","rules":[]}');
  });

  it("starts the owner's list from the system one and puts the allow first", () => {
    const { config, values } = memoryConfig();
    expect(allowInOwnerApprovalPolicy(config, 1000, { match: "shell.exec", target: "laptop" })).toBe(true);
    expect(JSON.parse(values.get("users/1000/ai/tools/approval")!)).toEqual({
      default: DEFAULT_TOOL_APPROVAL_POLICY.default,
      rules: [{ match: "shell.exec", target: "laptop", action: "auto" }, ...DEFAULT_TOOL_APPROVAL_POLICY.rules],
    });
  });

  it("replaces a rule for the same call and target instead of stacking them", () => {
    const { config, values } = memoryConfig({ "users/1000/ai/tools/approval": JSON.stringify({ default: "ask", rules: [
      { match: "mail.send", target: "gsv", action: "ask" }, { match: "mail.send", action: "ask" },
    ] }) });
    expect(allowInOwnerApprovalPolicy(config, 1000, { match: "mail.send", target: "gsv" })).toBe(true);
    expect(JSON.parse(values.get("users/1000/ai/tools/approval")!)).toEqual({ default: "ask", rules: [
      { match: "mail.send", target: "gsv", action: "auto" }, { match: "mail.send", action: "ask" },
    ] });
  });

  it.each([
    [{ match: "shell.exec", target: "targets/*" }],
    [{ match: "shell.exec", target: "*" }],
    [{ match: "fs.*", target: "laptop" }],
    [{ match: "shell.exec", target: "" }],
  ])("refuses an allow that would cover more than the request: %j", (allow) => {
    const { config, values } = memoryConfig();
    expect(allowInOwnerApprovalPolicy(config, 1000, allow)).toBe(false);
    expect(values.size).toBe(0);
  });

  it("leaves a saved list it cannot read untouched", () => {
    const { config, values } = memoryConfig({ "users/1000/ai/tools/approval": "not json" });
    expect(allowInOwnerApprovalPolicy(config, 1000, { match: "mail.send", target: "gsv" })).toBe(false);
    expect(values.get("users/1000/ai/tools/approval")).toBe("not json");
  });
});
