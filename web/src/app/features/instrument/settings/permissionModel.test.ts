import { describe, expect, it } from "vitest";
import { targetFromOptionValue, targetOptionValue, targetIndexForRule } from "../../../components/ui/agentToolApprovalOptions";
import { parseApprovalPolicy, serializeApprovalPolicy } from "../../../domain/system/consoleAgentBehavior";
import { readSettingsPolicy } from "./settingsModel";
import { permissionOptionsForRule } from "./permissionModel";

describe("Settings approval labels", () => {
  it("round-trips metadata scopes through parsing, selection and serialization", () => {
    for (const target of [{ route: "instance", platform: "browser" }, { route: "machine" }, { route: "adapter", platform: "mail" }, "{\"route\":\"instance\"}"] as const) {
      const policy = { default: "ask", rules: [{ match: "shell.exec", target, action: "deny" }] };
      const parsed = parseApprovalPolicy(JSON.stringify(policy));
      const stored = readSettingsPolicy(serializeApprovalPolicy(parsed));
      expect(stored).toEqual(policy);
      const options = permissionOptionsForRule(parsed.rules[0], []);
      const selected = options.targets[targetIndexForRule(target, [])];
      expect(targetFromOptionValue(selected.value)).toEqual(target);
    }
  });

  it("never turns an invalid metadata selector into an unscoped Allow rule", () => {
    for (const target of [{ platform: "browser" }, { route: "instance", typo: "browser" }]) {
      const raw = JSON.stringify({ default: "ask", rules: [{ match: "shell.exec", target, action: "auto" }] });
      expect(readSettingsPolicy(raw)).toBeNull();
      expect(parseApprovalPolicy(raw)).toEqual({ default: "ask", rules: [] });
    }
  });

  it("uses the established tool names and target labels while retaining exact values", () => {
    const options = permissionOptionsForRule({ match: "shell.exec", target: "machine:123", action: "ask" }, [{ id: "machine:123", label: "My MacBook" }]);
    expect(options.tools.find((option) => option.value === "shell.exec")?.label).toBe("Run shell commands");
    expect(options.tools.find((option) => option.value === "fs.read")?.label).toBe("Read files");
    expect(options.tools.find((option) => option.value === "sys.mcp.call")?.label).toBe("Call MCP tools");
    expect(options.targets.find((option) => option.value === targetOptionValue("machine:123"))?.label).toBe("My MacBook");
    expect(options.targets.find((option) => option.value === targetOptionValue("gsv"))?.label).toBe("GSV computer");
    expect(options.targets.find((option) => option.value === targetOptionValue({ route: "instance", platform: "browser" }))?.label).toBe("Cloud browsers");
    expect(options.targets.find((option) => option.value === "")?.label).toBe("All machines");
  });

  it("offers the cloud-browser scope before any instance exists", () => {
    const options = permissionOptionsForRule({ match: "shell.exec", target: { route: "instance", platform: "browser" }, action: "ask" }, []);
    expect(options.targets.filter((option) => option.value === targetOptionValue({ route: "instance", platform: "browser" }))).toEqual([
      { value: targetOptionValue({ route: "instance", platform: "browser" }), label: "Cloud browsers", group: undefined },
    ]);
  });

  it("retains custom rules and unavailable target IDs before and after target discovery", () => {
    const rule = Object.freeze({ match: "plugin.special_action", target: "machine:missing", action: "deny" as const });
    const unknown = permissionOptionsForRule(rule, []);
    expect(unknown.tools.find((option) => option.value === rule.match)).toMatchObject({ value: rule.match, label: "Custom match" });
    expect(unknown.customToolLabel).toBe("Plugin Special Action · plugin.special_action");
    expect(unknown.targets.find((option) => option.value === targetOptionValue(rule.target))).toMatchObject({ value: targetOptionValue(rule.target), label: rule.target });
    const discovered = permissionOptionsForRule(rule, [{ id: rule.target, label: "Old laptop" }]);
    expect(discovered.targets.find((option) => option.value === targetOptionValue(rule.target))).toMatchObject({ value: targetOptionValue(rule.target), label: "Old laptop" });
    expect(rule).toEqual({ match: "plugin.special_action", target: "machine:missing", action: "deny" });
  });

  it("keeps the legacy external-machine scope distinct from the default all-target scope", () => {
    const options = permissionOptionsForRule({ match: "fs.*", target: "targets/*", action: "ask" }, []);
    expect(options.targets.filter((option) => option.label === "All machines").map((option) => option.value)).toEqual(["", targetOptionValue("targets/*")]);
  });
});
