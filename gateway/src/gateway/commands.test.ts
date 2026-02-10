import { describe, it, expect } from "vitest";
import {
  normalizeThinkLevel,
  parseCommand,
  parseModelSelection,
  type ThinkLevel,
} from "./commands";
import { parseDirectives } from "./directives";

describe("normalizeThinkLevel", () => {
  it("returns undefined for empty input", () => {
    expect(normalizeThinkLevel()).toBeUndefined();
    expect(normalizeThinkLevel("")).toBeUndefined();
  });

  it("normalizes 'off' variants to 'none'", () => {
    expect(normalizeThinkLevel("off")).toBe("none");
    expect(normalizeThinkLevel("none")).toBe("none");
    expect(normalizeThinkLevel("0")).toBe("none");
    expect(normalizeThinkLevel("OFF")).toBe("none");
  });

  it("normalizes 'minimal' variants", () => {
    expect(normalizeThinkLevel("minimal")).toBe("minimal");
    expect(normalizeThinkLevel("min")).toBe("minimal");
    expect(normalizeThinkLevel("1")).toBe("minimal");
    expect(normalizeThinkLevel("MINIMAL")).toBe("minimal");
  });

  it("normalizes 'low' variants", () => {
    expect(normalizeThinkLevel("low")).toBe("low");
    expect(normalizeThinkLevel("2")).toBe("low");
    expect(normalizeThinkLevel("LOW")).toBe("low");
  });

  it("normalizes 'medium' variants", () => {
    expect(normalizeThinkLevel("medium")).toBe("medium");
    expect(normalizeThinkLevel("med")).toBe("medium");
    expect(normalizeThinkLevel("3")).toBe("medium");
    expect(normalizeThinkLevel("MEDIUM")).toBe("medium");
  });

  it("normalizes 'high' variants", () => {
    expect(normalizeThinkLevel("high")).toBe("high");
    expect(normalizeThinkLevel("4")).toBe("high");
    expect(normalizeThinkLevel("HIGH")).toBe("high");
  });

  it("normalizes 'xhigh' variants", () => {
    expect(normalizeThinkLevel("xhigh")).toBe("xhigh");
    expect(normalizeThinkLevel("max")).toBe("xhigh");
    expect(normalizeThinkLevel("5")).toBe("xhigh");
    expect(normalizeThinkLevel("XHIGH")).toBe("xhigh");
  });

  it("returns undefined for invalid input", () => {
    expect(normalizeThinkLevel("invalid")).toBeUndefined();
    expect(normalizeThinkLevel("super")).toBeUndefined();
    expect(normalizeThinkLevel("6")).toBeUndefined();
  });
});

describe("parseDirectives - thinking level", () => {
  it("parses /think:level directive", () => {
    const result = parseDirectives("Hello /think:high world");
    expect(result.hasThinkDirective).toBe(true);
    expect(result.thinkLevel).toBe("high");
    expect(result.cleaned).toBe("Hello world");
  });

  it("parses /t:level shorthand", () => {
    const result = parseDirectives("What is 2+2? /t:medium");
    expect(result.hasThinkDirective).toBe(true);
    expect(result.thinkLevel).toBe("medium");
    expect(result.cleaned).toBe("What is 2+2?");
  });

  it("parses all thinking levels via directive", () => {
    const levels: Array<[string, ThinkLevel]> = [
      ["off", "none"],
      ["minimal", "minimal"],
      ["low", "low"],
      ["medium", "medium"],
      ["high", "high"],
      ["xhigh", "xhigh"],
      ["max", "xhigh"],
    ];

    for (const [input, expected] of levels) {
      const result = parseDirectives(`/t:${input} test`);
      expect(result.thinkLevel).toBe(expected);
    }
  });

  it("handles directive at start of message", () => {
    const result = parseDirectives("/t:high Explain quantum physics");
    expect(result.thinkLevel).toBe("high");
    expect(result.cleaned).toBe("Explain quantum physics");
  });

  it("handles directive at end of message", () => {
    const result = parseDirectives("Explain quantum physics /t:high");
    expect(result.thinkLevel).toBe("high");
    expect(result.cleaned).toBe("Explain quantum physics");
  });

  it("handles multiple directives", () => {
    const result = parseDirectives(
      "/t:high /m:claude-opus-4-6 What is life?",
      "anthropic",
    );
    expect(result.hasThinkDirective).toBe(true);
    expect(result.thinkLevel).toBe("high");
    expect(result.hasModelDirective).toBe(true);
    expect(result.model).toEqual({
      provider: "anthropic",
      id: "claude-opus-4-6",
    });
    expect(result.cleaned).toBe("What is life?");
  });

  it("parses provider/model directive values with slash", () => {
    const result = parseDirectives(
      "/m:anthropic/claude-opus-4-6 Explain quantum physics",
    );
    expect(result.hasModelDirective).toBe(true);
    expect(result.model).toEqual({
      provider: "anthropic",
      id: "claude-opus-4-6",
    });
    expect(result.cleaned).toBe("Explain quantum physics");
  });
});

describe("parseModelSelection", () => {
  it("parses provider/model form", () => {
    expect(
      parseModelSelection("anthropic/claude-opus-4-6"),
    ).toEqual({
      provider: "anthropic",
      id: "claude-opus-4-6",
    });
  });

  it("parses model-id form with fallback provider", () => {
    expect(
      parseModelSelection("claude-opus-4-6", "anthropic"),
    ).toEqual({
      provider: "anthropic",
      id: "claude-opus-4-6",
    });
  });

  it("returns undefined for model-id without fallback provider", () => {
    expect(parseModelSelection("claude-opus-4-6")).toBeUndefined();
  });

  it("returns undefined when selector contains whitespace", () => {
    expect(parseModelSelection("anthropic/claude-opus-4-6 hello")).toBeUndefined();
  });
});

describe("parseCommand - /think command", () => {
  it("parses /think without args", () => {
    const result = parseCommand("/think");
    expect(result).not.toBeNull();
    expect(result?.name).toBe("think");
    expect(result?.args).toBe(""); // Empty string when no args
  });

  it("parses /think with level", () => {
    const result = parseCommand("/think high");
    expect(result).not.toBeNull();
    expect(result?.name).toBe("think");
    expect(result?.args).toBe("high");
  });

  it("parses /think with various levels", () => {
    const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
    for (const level of levels) {
      const result = parseCommand(`/think ${level}`);
      expect(result?.name).toBe("think");
      expect(result?.args).toBe(level);
    }
  });
});
