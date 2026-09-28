import { describe, expect, it } from "vitest";
import { DEFAULT_TOOL_APPROVAL_POLICY } from "@humansandmachines/gsv/protocol";
import {
  APPROVAL_CATEGORIES,
  approvalRuleForRequest,
  askingCategories,
  composeApprovalChoices,
  currentApprovalChoices,
  protectManagedMailApproval,
  resolveApprovalAction,
  upsertApprovalRule,
  type ApprovalPolicyValue,
} from "./agentApproval";

const shipped: ApprovalPolicyValue = DEFAULT_TOOL_APPROVAL_POLICY;

describe("approval categories", () => {
  it("reads the shipped policy as asking for machine work, connected tools and mail, and nothing in the cloud home", () => {
    expect(currentApprovalChoices(shipped)).toEqual({
      shell: "ask", "machine-files": "ask", delete: "ask", web: "ask", tools: "ask", mail: "ask",
    });
    expect(askingCategories(shipped)).toEqual(APPROVAL_CATEGORIES.map((category) => category.id));
    expect(resolveApprovalAction(shipped, "fs.delete", "gsv")).toBe("auto");
    expect(resolveApprovalAction(shipped, "shell.exec", "gsv")).toBe("auto");
  });

  it("reads deletes as allowed once machine file changes are, until the delete row is chosen", () => {
    const machinesOpen = composeApprovalChoices(shipped, null, { shell: "auto", "machine-files": "auto", web: "auto" });
    expect(currentApprovalChoices(machinesOpen)).toMatchObject({ shell: "auto", "machine-files": "auto", web: "auto", delete: "auto" });
    expect(askingCategories(machinesOpen)).toEqual(["tools", "mail"]);
    const deletesAsk = composeApprovalChoices(shipped, null, { "machine-files": "auto", delete: "ask" });
    expect(askingCategories(deletesAsk)).toEqual(["shell", "delete", "web", "tools", "mail"]);
  });

  it("reads a denied rule as blocked rather than allowed, and ask still wins over it", () => {
    const blocked = upsertApprovalRule(upsertApprovalRule(shipped, { match: "fs.delete", target: "gsv", action: "deny" }),
      { match: "fs.delete", target: "targets/*", action: "deny" });
    expect(currentApprovalChoices(blocked).delete).toBe("deny");
    expect(askingCategories(blocked)).not.toContain("delete");
    const half = upsertApprovalRule(shipped, { match: "fs.delete", target: "gsv", action: "deny" });
    expect(currentApprovalChoices(half).delete).toBe("ask");
  });
});

describe("upsertApprovalRule", () => {
  it("replaces a rule in place when capability and scope match, normalising legacy scopes", () => {
    const policy: ApprovalPolicyValue = { default: "auto", rules: [{ match: "fs.write", target: "devices/*", action: "ask" }, { match: "shell.exec", action: "ask" }] };
    const next = upsertApprovalRule(policy, { match: "fs.write", target: "targets/*", action: "auto" });
    expect(next.rules).toEqual([{ match: "fs.write", target: "targets/*", action: "auto" }, { match: "shell.exec", action: "ask" }]);
  });

  it("appends when the scope differs and never mutates its input", () => {
    const policy: ApprovalPolicyValue = { default: "auto", rules: [{ match: "shell.exec", action: "ask" }] };
    const next = upsertApprovalRule(policy, { match: "shell.exec", target: "my-mac", action: "auto" });
    expect(next.rules).toHaveLength(2);
    expect(next.rules[1]).toEqual({ match: "shell.exec", target: "my-mac", action: "auto" });
    expect(policy.rules).toHaveLength(1);
  });
});

describe("composeApprovalChoices", () => {
  it("flips only the chosen capability and keeps every other shipped rule at its index", () => {
    const next = composeApprovalChoices(shipped, null, { shell: "auto" });
    expect(next.default).toBe("auto");
    expect(next.rules).toHaveLength(shipped.rules.length);
    shipped.rules.forEach((rule, index) => {
      if (rule.match === "shell.exec" && rule.target === "targets/*") expect(next.rules[index]).toEqual({ ...rule, action: "auto" });
      else expect(next.rules[index]).toEqual(rule);
    });
    expect(resolveApprovalAction(next, "shell.exec", "my-mac")).toBe("auto");
  });

  it("only moves file changes on machines, never their reads or searches", () => {
    const next = composeApprovalChoices(shipped, null, { "machine-files": "auto" });
    expect(resolveApprovalAction(next, "fs.write", "my-mac")).toBe("auto");
    expect(resolveApprovalAction(next, "fs.read", "my-mac")).toBe("auto");
    const asking = composeApprovalChoices(shipped, null, { "machine-files": "ask" });
    expect(resolveApprovalAction(asking, "fs.read", "my-mac")).toBe("auto");
    expect(resolveApprovalAction(asking, "fs.search", "my-mac")).toBe("auto");
    expect(resolveApprovalAction(asking, "fs.edit", "my-mac")).toBe("ask");
  });

  it("lets a delete choice win over the file wildcard on machines and the cloud-home default", () => {
    const next = composeApprovalChoices(shipped, null, { "machine-files": "auto", delete: "ask" });
    expect(resolveApprovalAction(next, "fs.write", "my-mac")).toBe("auto");
    expect(resolveApprovalAction(next, "fs.delete", "my-mac")).toBe("ask");
    expect(resolveApprovalAction(next, "fs.delete", "gsv")).toBe("ask");
  });

  it("starts from an existing override and preserves rules outside the category set", () => {
    const current: ApprovalPolicyValue = { default: "ask", rules: [{ match: "repo.*", action: "deny" }, { match: "custom.thing", action: "auto" }] };
    const next = composeApprovalChoices(shipped, current, { tools: "auto" });
    expect(next.default).toBe("ask");
    expect(next.rules.slice(0, 2)).toEqual(current.rules);
    expect(next.rules).toContainEqual({ match: "sys.mcp.call", action: "auto" });
  });

  it("writes nothing when no row was chosen", () => {
    expect(composeApprovalChoices(shipped, null, {})).toEqual(shipped);
  });

  it("lets an allow choice for mail stand against the managed-mail guard", () => {
    const next = composeApprovalChoices(shipped, null, { mail: "auto" });
    expect(protectManagedMailApproval(next)).toEqual(next);
    expect(resolveApprovalAction(next, "mail.send", "gsv")).toBe("auto");
    expect(next.rules.filter((rule) => rule.match === "mail.send")).toEqual([
      { match: "mail.send", action: "ask" },
      { match: "mail.send", target: "gsv", action: "auto" },
    ]);
  });

  it("re-adds the mail guard when no rule covers mail at the cloud home", () => {
    const next = composeApprovalChoices({ default: "auto", rules: [] }, null, { shell: "auto" });
    expect(next.rules).toContainEqual({ match: "mail.send", action: "ask" });
  });
});

describe("approvalRuleForRequest", () => {
  it("scopes the always-allow rule to exactly the resolved target", () => {
    expect(approvalRuleForRequest("shell.exec", "my-mac")).toEqual({ match: "shell.exec", target: "my-mac", action: "auto" });
    expect(approvalRuleForRequest("shell.exec", "targets/*")).toEqual({ match: "shell.exec", target: "targets/*", action: "auto" });
    expect(approvalRuleForRequest("mail.send", "gsv")).toEqual({ match: "mail.send", target: "gsv", action: "auto" });
    expect(approvalRuleForRequest("sys.mcp.call", "*")).toEqual({ match: "sys.mcp.call", action: "auto" });
  });

  it("wins over the shipped ask rule for that machine and nothing else", () => {
    const next = upsertApprovalRule(shipped, approvalRuleForRequest("shell.exec", "my-mac"));
    expect(resolveApprovalAction(next, "shell.exec", "my-mac")).toBe("auto");
    expect(resolveApprovalAction(next, "shell.exec", "other-mac")).toBe("ask");
    expect(resolveApprovalAction(next, "shell.exec", "targets/*")).toBe("ask");
  });
});

describe("resolveApprovalAction", () => {
  it("prefers the most specific target, then an exact match, then list order", () => {
    const policy: ApprovalPolicyValue = {
      default: "auto",
      rules: [
        { match: "fs.*", action: "deny" },
        { match: "fs.write", action: "ask" },
        { match: "fs.write", target: "targets/*", action: "auto" },
        { match: "fs.write", target: "my-mac", action: "deny" },
      ],
    };
    expect(resolveApprovalAction(policy, "fs.write", "my-mac")).toBe("deny");
    expect(resolveApprovalAction(policy, "fs.write", "other")).toBe("auto");
    expect(resolveApprovalAction(policy, "fs.write", "gsv")).toBe("ask");
    expect(resolveApprovalAction(policy, "fs.read", "gsv")).toBe("deny");
    expect(resolveApprovalAction(policy, "web.search", "gsv")).toBe("auto");
    expect(resolveApprovalAction({ default: "auto", rules: [] }, "mail.send", "gsv")).toBe("ask");
  });
});
