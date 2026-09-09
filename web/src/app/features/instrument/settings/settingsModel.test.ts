import { describe, expect, it } from "vitest";
import type { ConsoleAccount } from "../../gsv-console/domain/consoleModels";
import { canConfigure, instructionPath, newInstructionName, readSettingsPolicy, signInUrl } from "./settingsModel";

const account: ConsoleAccount = { uid: 1001, username: "viewer", displayName: "Viewer", relation: "self", runnable: false, gecos: "", capabilities: ["fs.*", "sys.mcp.list"] };

describe("Settings editing boundaries", () => {
  it("keeps capability grants separate from visibility and matches wildcard domains exactly", () => {
    expect(canConfigure(account, "fs.write")).toBe(true);
    expect(canConfigure(account, "sys.mcp.list")).toBe(true);
    expect(canConfigure(account, "sys.mcp.remove")).toBe(false);
    expect(canConfigure(account, "fsx.write")).toBe(false);
    expect(canConfigure(account, "sys.config.set")).toBe(false);
  });

  it("preserves target-specific approval rules and their original order without adding rules", () => {
    const policy = { default: "auto", rules: [
      { match: "shell.*", target: "laptop", action: "deny" },
      { match: "shell.exec", target: "gsv", action: "ask" },
      { match: "mail.send", action: "ask" },
    ] };
    expect(readSettingsPolicy(JSON.stringify(policy))).toEqual(policy);
  });

  it("refuses lossy editing of conditional or unknown policy fields and malformed JSON", () => {
    expect(readSettingsPolicy('{"default":"ask","rules":[{"match":"shell.exec","action":"deny","when":{"target":"laptop"}}]}')).toBeNull();
    expect(readSettingsPolicy('{"default":"ask","rules":[],"futureRule":true}')).toBeNull();
    expect(readSettingsPolicy("not json")).toBeNull();
    expect(readSettingsPolicy('{"default":"ask","rules":[{"match":"","action":"deny"}]}')).toBeNull();
  });

  it("keeps instruction edits within the authenticated user's existing Markdown folder", () => {
    expect(instructionPath("my instructions.md")).toBe("~/context.d/my instructions.md");
    for (const name of ["../other.md", "nested/file.md", "../context.d/a.md", "a\\b.md", "token.json", "a\0.md"]) {
      expect(() => instructionPath(name)).toThrow();
    }
  });

  it("only renders ordinary web sign-in URLs", () => {
    expect(signInUrl("https://example.test/authorize?state=synthetic")).toBe("https://example.test/authorize?state=synthetic");
    expect(signInUrl("javascript:alert(1)")).toBeNull();
    expect(signInUrl("data:text/html,example")).toBeNull();
    expect(signInUrl("not a url")).toBeNull();
  });

  it("creates Markdown names without allowing a folder or an empty name", () => {
    expect(newInstructionName("  writing style  ")).toBe("writing style.md");
    expect(newInstructionName("10-preferences.md")).toBe("10-preferences.md");
    expect(newInstructionName("Préférences.MD")).toBe("Préférences.md");
    for (const name of ["", " ", ".md", ".", "..", "../other", "/tmp/file.md", "nested/file.md", "a\\b", "a\0b", "a\nb"]) {
      expect(() => newInstructionName(name)).toThrow();
    }
  });
});
