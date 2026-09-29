import { describe, expect, it } from "vitest";
import { permissionOptionsForRule } from "./permissionModel";

describe("Settings approval labels", () => {
  it("uses the established tool names and target labels while retaining exact values", () => {
    const options = permissionOptionsForRule({ match: "shell.exec", target: "machine:123", action: "ask" }, [{ id: "machine:123", label: "My MacBook" }]);
    expect(options.tools.find((option) => option.value === "shell.exec")?.label).toBe("Run shell commands");
    expect(options.tools.find((option) => option.value === "fs.read")?.label).toBe("Read files");
    expect(options.tools.find((option) => option.value === "sys.mcp.call")?.label).toBe("Call MCP tools");
    expect(options.targets.find((option) => option.value === "machine:123")?.label).toBe("My MacBook");
    expect(options.targets.find((option) => option.value === "gsv")?.label).toBe("GSV computer");
    expect(options.targets.find((option) => option.value === "")?.label).toBe("All machines");
  });

  it("retains custom rules and unavailable target IDs before and after target discovery", () => {
    const rule = Object.freeze({ match: "plugin.special_action", target: "machine:missing", action: "deny" as const });
    const unknown = permissionOptionsForRule(rule, []);
    expect(unknown.tools.find((option) => option.value === rule.match)).toMatchObject({ value: rule.match, label: "Custom match" });
    expect(unknown.customToolLabel).toBe("Plugin Special Action · plugin.special_action");
    expect(unknown.targets.find((option) => option.value === rule.target)).toMatchObject({ value: rule.target, label: rule.target });
    const discovered = permissionOptionsForRule(rule, [{ id: rule.target, label: "Old laptop" }]);
    expect(discovered.targets.find((option) => option.value === rule.target)).toMatchObject({ value: rule.target, label: "Old laptop" });
    expect(rule).toEqual({ match: "plugin.special_action", target: "machine:missing", action: "deny" });
  });

  it("keeps the legacy external-machine scope distinct from the default all-target scope", () => {
    const options = permissionOptionsForRule({ match: "fs.*", target: "targets/*", action: "ask" }, []);
    expect(options.targets.filter((option) => option.label === "All machines").map((option) => option.value)).toEqual(["", "targets/*"]);
  });
});
