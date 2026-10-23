import { describe, expect, it } from "vitest";
import { preferenceWrites } from "./preferenceWrites";

const draft = { uid: 1000, config: [], order: null, reasoning: "high", language: "pt-BR", timezone: "Europe/Amsterdam" };

describe("combined preferences", () => {
  it("collects only changed owner preferences and trims locale input", () => {
    expect(preferenceWrites({ ...draft, language: " pt-BR ", config: [
      { key: "users/1000/ai/reasoning", value: "high", redacted: false },
      { key: "users/1000/ai/models/key", value: "untouched", redacted: true },
    ] })).toEqual([
      { key: "users/1000/locale/language", value: "pt-BR" },
      { key: "users/1000/locale/timezone", value: "Europe/Amsterdam" },
    ]);
  });
  it("validates all fields before returning writes", () => {
    expect(() => preferenceWrites({ ...draft, timezone: "Mars/Olympus" })).toThrow();
    expect(() => preferenceWrites({ ...draft, language: "not a language" })).toThrow();
  });
  it("clears locale overrides and skips values already saved during a partial failure", () => {
    expect(preferenceWrites({ ...draft, language: "", timezone: "", config: [
      { key: "users/1000/ai/reasoning", value: "high", redacted: false },
      { key: "users/1000/locale/language", value: "pt-BR", redacted: false },
    ] })).toEqual([{ key: "users/1000/locale/language", value: "" }]);
  });
});
