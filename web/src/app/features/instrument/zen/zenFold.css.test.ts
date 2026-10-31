import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("message fold styles", () => {
  it("clips a fold wherever ZenText renders, not only in the chat view", () => {
    const css = readFileSync(new URL("./zen.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const selectors = [...css.matchAll(/([^{}]*\.is-folded[^{}]*)\{/g)].map((rule) => rule[1].trim());
    expect(selectors).toEqual([".zen-resolving-text.is-folded"]);
  });
});
