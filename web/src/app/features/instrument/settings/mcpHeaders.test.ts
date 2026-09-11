import { describe, expect, it } from "vitest";
import { parseMcpHeaders } from "./mcpHeaders";

const row = (name: string, value: string) => ({ id: name, name, value });

describe("MCP custom headers", () => {
  it("keeps values exact and ignores untouched rows", () => {
    expect(parseMcpHeaders([row(" Authorization ", "Bearer fixture-value"), row("X-Workspace", "workspace-a"), row("", "")])).toEqual({ ok: true, headers: { Authorization: "Bearer fixture-value", "X-Workspace": "workspace-a" } });
    expect(parseMcpHeaders([])).toEqual({ ok: true, headers: {} });
  });

  it("rejects missing names and values", () => {
    expect(parseMcpHeaders([row("", "fixture-value")])).toEqual({ ok: false, error: "Each header needs a name." });
    expect(parseMcpHeaders([row("Authorization", " ")])).toEqual({ ok: false, error: "Each header needs a value." });
  });

  it("rejects case-insensitive duplicates before converting rows to an object", () => {
    expect(parseMcpHeaders([row("Authorization", "one"), row("authorization", "two")]).ok).toBe(false);
  });

  it.each([row("Invalid Name", "value"), row("X-Key", "one\r\nX-Other: two"), row("X-Key", "\nvalue\n")])("rejects invalid HTTP headers without echoing values", (header) => {
    expect(parseMcpHeaders([header])).toEqual({ ok: false, error: "Use valid HTTP header names and values without line breaks." });
  });

  it("preserves valid object-like header names as ordinary own properties", () => {
    const result = parseMcpHeaders([row("__proto__", "fixture-value")]);
    expect(result.ok && Object.hasOwn(result.headers, "__proto__")).toBe(true);
    expect(result.ok && Object.getPrototypeOf(result.headers)).toBe(Object.prototype);
  });
});
